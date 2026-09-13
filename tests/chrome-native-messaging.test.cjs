'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const {
  ChromeNativeMessagingServer, FrameDecoder, encodeMessage, encodeRequestFrames,
} = require('../src/main/adapters/chrome/native-messaging-server.cjs');

test('native messaging framing handles fragmented and coalesced UTF-8 messages', () => {
  const received = [];
  const decoder = new FrameDecoder((message) => received.push(message));
  const first = encodeMessage({ v: 1, text: '汉字' });
  const second = encodeMessage({ v: 1, value: 2 });
  decoder.push(first.subarray(0, 3));
  decoder.push(Buffer.concat([first.subarray(3), second]));
  assert.deepEqual(received, [{ v: 1, text: '汉字' }, { v: 1, value: 2 }]);
});

test('large host requests are split into independently bounded base64 frames', () => {
  const frames = encodeRequestFrames({ v: 1, id: 'large', method: 'window.prepare', params: { data: 'x'.repeat(1_200_000) } });
  assert.equal(frames.length, 3);
  assert.ok(frames.every((frame) => frame.length <= 1024 * 1024 + 4));
  const chunks = frames.map((frame) => JSON.parse(frame.subarray(4).toString('utf8')));
  const payload = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, 'base64')));
  assert.equal(JSON.parse(payload.toString('utf8')).params.data.length, 1_200_000);
});

test('native messaging server correlates replies and fails pending requests on disconnect', async () => {
  const net = {
    createServer(callback) {
      const server = new EventEmitter();
      server.listen = () => queueMicrotask(() => server.emit('listening'));
      server.close = (done) => done();
      server.accept = callback;
      return server;
    },
  };
  const bridge = new ChromeNativeMessagingServer({ net, timeoutMs: 100 });
  await bridge.start();
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.setNoDelay = () => {};
  socket.write = (frame) => {
    const length = frame.readUInt32LE(0);
    const request = JSON.parse(frame.subarray(4, length + 4));
    queueMicrotask(() => socket.emit('data', encodeMessage({ v: 1, id: request.id, ok: true, result: { done: true } })));
  };
  socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
  bridge.server.accept(socket);
  socket.emit('data', encodeMessage({ v: 1, type: 'hello', extensionId: 'fixed', extensionVersion: '1' }));
  assert.equal(bridge.connected, true);
  assert.deepEqual(await bridge.request('windows.list'), { done: true });
  socket.write = () => {};
  const pending = bridge.request('window.capture');
  socket.destroy();
  await assert.rejects(pending, { code: 'CHROME_EXTENSION_DISCONNECTED' });
  await bridge.stop();
});
