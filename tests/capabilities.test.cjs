'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CAPABILITY_METHODS,
  CapabilityAuthority,
  MAX_CHUNK_BYTES,
  isKnownCapability,
  validateCapabilityRequest,
} = require('../src/core/capabilities.cjs');

test('capability registry is closed and authority grants are explicit', () => {
  assert.deepEqual(CAPABILITY_METHODS, [
    'workspace.list', 'workspace.mkdir', 'workspace.rename', 'workspace.delete',
    'transfer.start', 'transfer.chunk', 'transfer.finish', 'transfer.abort',
    'program.launch', 'program.input', 'program.close',
  ]);
  assert.equal(isKnownCapability('workspace.list'), true);
  assert.equal(isKnownCapability('shell.exec'), false);
  assert.throws(() => validateCapabilityRequest('shell.exec', {}), (error) => error.code === 'UNKNOWN_CAPABILITY');
  const readOnly = new CapabilityAuthority(['workspace.list']);
  assert.equal(readOnly.allows('workspace.list'), true);
  assert.equal(readOnly.allows('workspace.delete'), false);
  assert.deepEqual(readOnly.validate('workspace.list', {}), { path: '' });
  assert.throws(() => readOnly.validate('workspace.delete', { path: 'file.txt' }), (error) => error.code === 'UNAUTHORIZED');
  assert.throws(() => new CapabilityAuthority(['process.spawn']), (error) => error.code === 'INVALID_GRANT');
});

test('workspace and program capabilities expose public references without host or shell authority', () => {
  assert.deepEqual(validateCapabilityRequest('workspace.mkdir', { path: 'Notes/Today' }), { path: 'Notes/Today' });
  assert.deepEqual(validateCapabilityRequest('workspace.rename', { from: 'old.txt', to: 'Notes/new.txt' }), { from: 'old.txt', to: 'Notes/new.txt' });
  assert.deepEqual(validateCapabilityRequest('program.launch', { app: 'text-editor', path: 'Notes/new.txt' }), { app: 'text-editor', path: 'Notes/new.txt' });

  for (const payload of [
    { app: 'notepad.exe', path: 'Notes/new.txt' },
    { app: 'text-editor', path: 'Notes/new.txt', executable: 'cmd.exe' },
    { app: 'text-editor', path: 'Notes/new.txt', argv: ['/c', 'whoami'] },
    { app: 'text-editor', path: 'C:/Users/person/secret.txt' },
    { app: 'text-editor', path: '../secret.txt' },
  ]) assert.throws(() => validateCapabilityRequest('program.launch', payload), (error) => error.code === 'INVALID_PAYLOAD');

  for (const payload of [
    { path: 'Notes', hostPath: 'C:/Users/person' },
    { path: '.compusync/transfers' },
    { path: '/etc' },
    { path: 'CON' },
  ]) assert.throws(() => validateCapabilityRequest('workspace.list', payload), (error) => error.code === 'INVALID_PAYLOAD');
});

test('transfer capabilities validate exact metadata and canonical bounded chunks', () => {
  const sha256 = 'a'.repeat(64);
  assert.deepEqual(validateCapabilityRequest('transfer.start', {
    transferId: 'upload-1', name: 'note.txt', target: 'Notes', size: 3, sha256,
  }), { transferId: 'upload-1', name: 'note.txt', target: 'Notes', size: 3, sha256 });
  assert.deepEqual(validateCapabilityRequest('transfer.chunk', {
    transferId: 'upload-1', offset: 0, data: Buffer.from('abc').toString('base64'),
  }), { transferId: 'upload-1', offset: 0, data: 'YWJj' });

  for (const payload of [
    { transferId: '../bad', name: 'note.txt', size: 3, sha256 },
    { transferId: 'ok', name: '../note.txt', size: 3, sha256 },
    { transferId: 'ok', name: 'note.txt', size: 3, sha256: 'short' },
    { transferId: 'ok', name: 'note.txt', size: 3, sha256, shell: 'cmd' },
  ]) assert.throws(() => validateCapabilityRequest('transfer.start', payload), (error) => error.code === 'INVALID_PAYLOAD');

  assert.throws(() => validateCapabilityRequest('transfer.chunk', { transferId: 'ok', offset: 0, data: 'not base64!' }));
  assert.throws(() => validateCapabilityRequest('transfer.chunk', { transferId: 'ok', offset: 0, data: Buffer.alloc(MAX_CHUNK_BYTES + 1).toString('base64') }));
  assert.throws(() => validateCapabilityRequest('transfer.finish', { transferId: 'ok', path: 'host/path' }));
});

test('program input validator emits only fields accepted by the managed program', () => {
  assert.deepEqual(validateCapabilityRequest('program.input', {
    programId: 'program-1', input: { type: 'mouseDown', x: 12.5, y: 8, button: 'left', modifiers: ['shift'] },
  }), {
    programId: 'program-1', input: { type: 'mouseDown', x: 12.5, y: 8, button: 'left', clickCount: 1, modifiers: ['shift'] },
  });
  assert.deepEqual(validateCapabilityRequest('program.input', {
    programId: 'program-1', input: { type: 'keyDown', keyCode: 'a', modifiers: ['control'], isAutoRepeat: true },
  }), {
    programId: 'program-1', input: { type: 'keyDown', keyCode: 'a', modifiers: ['control'], isAutoRepeat: true },
  });
  assert.deepEqual(validateCapabilityRequest('program.input', {
    programId: 'program-1', input: { type: 'char', keyCode: 'é', modifiers: [] },
  }), {
    programId: 'program-1', input: { type: 'char', keyCode: 'é', modifiers: [] },
  });

  for (const input of [
    { type: 'mouseDown', x: 1, y: 1, button: 'primary' },
    { type: 'mouseMove', x: -1, y: 0 },
    { type: 'keyDown', keyCode: 'a', modifiers: ['super'] },
    { type: 'keyDown', keyCode: 'DefinitelyNotAKey' },
    { type: 'char', keyCode: '\0' },
    { type: 'keyDown', keyCode: 'a', command: 'open-shell' },
  ]) assert.throws(() => validateCapabilityRequest('program.input', { programId: 'program-1', input }), (error) => error.code === 'INVALID_PAYLOAD');
});
