'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DesktopService, publicResult, validateDesktopState } = require('../src/desktop-service.cjs');

async function until(predicate, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Condition timed out.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeSession extends EventEmitter {
  constructor(role, id) {
    super();
    this.config = { role };
    this.self = { id, name: id };
    this.phase = role === 'host' ? 'hosting' : 'connected';
    this.dataPhase = 'connected';
    this.sent = [];
    this.allowData = true;
  }
  status() { return { role: this.config.role, phase: this.phase, peers: [] }; }
  sendData(message) {
    this.sent.push(structuredClone(message));
    if (!this.allowData || !this.peer) return false;
    const clean = structuredClone(message);
    queueMicrotask(() => this.peer.emit('data', clean, this.self.id));
    return true;
  }
}

function pairSessions() {
  const host = new FakeSession('host', 'host-id');
  const peer = new FakeSession('join', 'peer-id');
  host.phase = 'connected';
  host.peer = peer;
  peer.peer = host;
  return { host, peer };
}

class FakeIpcMain {
  constructor() { this.handlers = new Map(); }
  handle(channel, handler) { this.handlers.set(channel, handler); }
  removeHandler(channel) { this.handlers.delete(channel); }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.mainFrame = {};
    this.inputEvents = [];
    this.destroyed = false;
  }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
  setFrameRate(rate) { this.frameRate = rate; }
  sendInputEvent(event) { this.inputEvents.push(event); }
  focus() { this.focused = true; }
  isDestroyed() { return this.destroyed; }
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    FakeBrowserWindow.instances.push(this);
  }
  async loadFile(file) { this.loadedFile = file; }
  isDestroyed() { return this.destroyed; }
  close() { this.destroy(); }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit('closed');
  }
}

async function tempRoot(t, prefix) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

function serviceOptions(session, workspaceRoot) {
  return {
    session,
    workspaceRoot,
    hostName: 'Safe Host',
    BrowserWindow: FakeBrowserWindow,
    ipcMain: new FakeIpcMain(),
    programRendererPath: path.join('safe', 'programs'),
  };
}

test('host commands and recursive local imports persist only sanitized workspace state', async (t) => {
  const root = await tempRoot(t, 'compusync-desktop-host-');
  const workspaceRoot = path.join(root, 'workspace');
  const sourceRoot = path.join(root, 'Selected Folder');
  await fsp.mkdir(path.join(sourceRoot, 'Nested'), { recursive: true });
  await fsp.writeFile(path.join(sourceRoot, 'Nested', 'note.txt'), 'persistent note');
  const standalone = new FakeSession('host', 'host-id');
  standalone.dataPhase = 'disconnected';
  const service = new DesktopService(serviceOptions(standalone, workspaceRoot));
  await service.start();

  await service.handleCommand('mkdir', { parent: '', name: 'Notes' });
  await service.handleCommand('rename', { path: 'Notes', name: 'Documents' });
  const imported = await service.importPaths([sourceRoot], 'Documents');
  assert.equal(imported[0].path, 'Documents/Selected Folder');
  assert.equal(await service.workspace.readText('Documents/Selected Folder/Nested/note.txt'), 'persistent note');
  assert.equal(service.state().workspaceSerial, 5);
  assert.equal(service.state().entries.some((entry) => entry.path === 'Documents/Selected Folder/Nested/note.txt'), true);
  assert.equal(JSON.stringify(service.state()).includes(root), false);
  assert.equal(JSON.stringify(service.state()).includes('.compusync'), false);
  await service.stop();

  const replacementSession = new FakeSession('host', 'host-id');
  replacementSession.dataPhase = 'disconnected';
  const replacement = new DesktopService(serviceOptions(replacementSession, workspaceRoot));
  await replacement.start();
  assert.equal((await replacement.handleCommand('list', { path: 'Documents/Selected Folder/Nested' }))[0].name, 'note.txt');
  await replacement.handleCommand('delete', { path: 'Documents/Selected Folder' });
  assert.deepEqual(await replacement.handleCommand('list', { path: 'Documents' }), []);
  await replacement.stop();
});

test('joined peer uses authenticated RPC and acknowledged chunks to import files and directories', async (t) => {
  const root = await tempRoot(t, 'compusync-desktop-peer-');
  const { host: hostSession, peer: peerSession } = pairSessions();
  const host = new DesktopService(serviceOptions(hostSession, path.join(root, 'host-workspace')));
  const peer = new DesktopService(serviceOptions(peerSession, path.join(root, 'unused-peer-workspace')));
  await host.start();
  await peer.start();
  hostSession.emit('data-status', { phase: 'connected', memberId: 'peer-id' });
  await until(() => peer.state().host.name === 'Safe Host');

  await peer.handleCommand('mkdir', { parent: '', name: 'Remote' });
  const localFile = path.join(root, 'large.txt');
  const contents = Buffer.alloc(150 * 1024, 'a');
  await fsp.writeFile(localFile, contents);
  const transferred = await peer.importPaths([localFile], 'Remote');
  assert.equal(transferred[0].path, 'Remote/large.txt');
  assert.deepEqual(await fsp.readFile(path.join(root, 'host-workspace', 'Remote', 'large.txt')), contents);
  const chunkRequests = peerSession.sent.filter((message) => message.kind === 'desktop-request' && message.method === 'transfer.chunk');
  assert.equal(chunkRequests.length, 2);
  assert.ok(chunkRequests.every((message) => Buffer.from(message.payload.data, 'base64').length <= 128 * 1024));

  const localDirectory = path.join(root, 'Project');
  await fsp.mkdir(path.join(localDirectory, 'src'), { recursive: true });
  await fsp.writeFile(path.join(localDirectory, 'src', 'index.txt'), 'from peer');
  await peer.importPaths([localDirectory], 'Remote');
  await peer.importPaths([localDirectory], 'Remote');
  assert.equal((await host.handleCommand('list', { path: 'Remote' })).some((entry) => entry.name === 'Project'), true);
  assert.equal((await host.handleCommand('list', { path: 'Remote' })).some((entry) => entry.name === 'Project (1)'), true);
  assert.equal(await host.workspace.readText('Remote/Project/src/index.txt'), 'from peer');
  assert.equal(JSON.stringify(peer.state()).includes(root), false);
  await peer.stop();
  await host.stop();
});

test('host program state, frames, and input are presented to and controlled by the peer', async (t) => {
  FakeBrowserWindow.instances = [];
  const root = await tempRoot(t, 'compusync-desktop-program-');
  const { host: hostSession, peer: peerSession } = pairSessions();
  const host = new DesktopService(serviceOptions(hostSession, path.join(root, 'host-workspace')));
  const peer = new DesktopService(serviceOptions(peerSession, path.join(root, 'unused-peer-workspace')));
  await host.start();
  await peer.start();
  const document = path.join(root, 'document.txt');
  await fsp.writeFile(document, 'editable');
  await host.importPaths([document]);
  hostSession.emit('data-status', { phase: 'connected', memberId: 'peer-id' });
  await until(() => peer.state().entries.some((entry) => entry.path === 'document.txt'));

  const launched = await peer.handleCommand('program-launch', { path: 'document.txt', kind: 'text-editor' });
  await until(() => host.state().programs.length === 1 && peer.state().programs.length === 1);
  const window = FakeBrowserWindow.instances.at(-1);
  const input = await peer.handleCommand('program-input', {
    programId: launched.id,
    input: { type: 'keyDown', keyCode: 'a', modifiers: ['control'] },
  });
  assert.deepEqual(input, { accepted: true });
  assert.deepEqual(window.webContents.inputEvents.at(-1), { type: 'keyDown', keyCode: 'a', modifiers: ['control'] });

  const peerFrames = [];
  peer.on('frame', (frame) => peerFrames.push(frame));
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 640, height: 400 }),
    toJPEG: () => Buffer.from('bounded jpeg frame'),
  };
  window.webContents.emit('paint', {}, {}, image);
  await until(() => peerFrames.length === 1);
  assert.equal(peerFrames[0].programId, launched.id);
  assert.equal('window' in peerFrames[0], false);
  hostSession.allowData = false;
  assert.equal(host._publishFrame({ ...peerFrames[0], serial: peerFrames[0].serial + 1 }), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerFrames.length, 1);
  hostSession.allowData = true;
  assert.equal(await peer.handleCommand('program-close', { programId: launched.id }).then((result) => result.closed), true);
  await until(() => peer.state().programs.length === 0);
  await peer.stop();
  await host.stop();
});

test('peer requests are bounded and result/state schemas discard extra authority', async (t) => {
  const root = await tempRoot(t, 'compusync-desktop-bounds-');
  const session = new FakeSession('join', 'peer-id');
  session.peer = { emit() {} };
  const peer = new DesktopService(serviceOptions(session, path.join(root, 'unused-workspace')));
  await peer.start();
  const pending = [];
  // start() has one bounded initial listing outstanding on this black-hole link.
  for (let index = 0; index < 31; index++) pending.push(peer.handleCommand('list', { path: '' }).catch((error) => error));
  await assert.rejects(peer.handleCommand('list', { path: '' }), (error) => error.code === 'PENDING_LIMIT');
  await peer.stop();
  assert.ok((await Promise.all(pending)).every((error) => error.code === 'DATA_UNAVAILABLE'));

  assert.equal(publicResult('workspace.list', [{
    path: 'safe.txt', name: 'safe.txt', type: 'file', size: 1, modifiedAt: 1, hostPath: 'C:/secret',
  }]), null);
  assert.equal(validateDesktopState({
    version: 1,
    host: { name: 'Host', path: 'C:/secret' },
    workspaceSerial: 0,
    entries: [], programs: [], transfers: [],
    catalog: [{ id: 'text-editor', name: 'Text Editor', kind: 'editor' }],
  }), null);
});

test('unknown authority is rejected and disconnect aborts member-owned partial transfers', async (t) => {
  const root = await tempRoot(t, 'compusync-desktop-security-');
  const { host: hostSession, peer: peerSession } = pairSessions();
  const host = new DesktopService(serviceOptions(hostSession, path.join(root, 'host-workspace')));
  const peer = new DesktopService(serviceOptions(peerSession, path.join(root, 'unused-peer-workspace')));
  await host.start();
  await peer.start();

  const maliciousId = 'request-malicious';
  peerSession.sendData({ kind: 'desktop-request', requestId: maliciousId, method: 'shell.exec', payload: { executable: 'cmd.exe', argv: ['/c', 'whoami'] } });
  await until(() => hostSession.sent.some((message) => message.kind === 'desktop-result' && message.requestId === maliciousId));
  const rejected = hostSession.sent.find((message) => message.kind === 'desktop-result' && message.requestId === maliciousId);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'UNKNOWN_CAPABILITY');
  assert.equal(JSON.stringify(rejected).includes('cmd.exe'), false);

  const partial = Buffer.from('partial');
  await peer._request('transfer.start', {
    transferId: 'transfer-disconnect',
    name: 'partial.txt',
    size: partial.length,
    sha256: createHash('sha256').update(partial).digest('hex'),
  });
  await peer._request('transfer.chunk', { transferId: 'transfer-disconnect', offset: 0, data: Buffer.from('par').toString('base64') });
  assert.equal(host.receiver.active().length, 1);
  hostSession.emit('data-status', { phase: 'disconnected', memberId: 'peer-id' });
  await until(() => host.receiver.active().length === 0);
  assert.deepEqual(await fsp.readdir(host.workspace.internalTransferDirectory()), []);
  assert.equal((await host.handleCommand('list', { path: '' })).some((entry) => entry.name === 'partial.txt'), false);

  await assert.rejects(() => peer.handleCommand('program-launch', { path: 'x.txt', kind: 'shell' }), (error) => error.code === 'INVALID_PAYLOAD');
  await peer.stop();
  await host.stop();
});
