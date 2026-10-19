'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { loadBinding } = require('./index.cjs');
const binding = loadBinding().binding;
const supported = Boolean(binding?.NativeAudio) && process.platform === 'win32';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => process.hrtime.bigint();

function macWire(key) {
  let counter = 0n;
  return (body) => {
    const header = Buffer.alloc(12); header.write('CSM2'); header.writeBigUInt64BE(counter++, 4);
    const encrypt = createCipheriv('aes-256-gcm', key, header); encrypt.setAAD(header);
    return Buffer.concat([header, encrypt.update(body), encrypt.final(), encrypt.getAuthTag()]);
  };
}
function decodeWindows(key, packet) {
  assert.equal(packet.subarray(0, 4).toString(), 'CSW2');
  const header = packet.subarray(0, 12); const decrypt = createDecipheriv('aes-256-gcm', key, header);
  decrypt.setAAD(header); decrypt.setAuthTag(packet.subarray(-16));
  return Buffer.concat([decrypt.update(packet.subarray(12, -16)), decrypt.final()]);
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Native audio timing condition timed out.'); await delay(5); }
}

test('Windows native output honors authenticated future playback timestamps and reports device-clock timing', { skip: !supported }, async (t) => {
  const audio = new binding.NativeAudio(); t.after(() => audio.stop());
  assert.equal(audio.protocolVersion(), 2);
  if (!audio.outputs().length) { t.skip('No physical Windows audio output is available.'); return; }
  const key = randomBytes(32); const encode = macWire(key);
  const port = await audio.startReceiver(key.toString('hex'), '127.0.0.1', '');
  const socket = dgram.createSocket('udp4'); t.after(() => socket.close());
  socket.bind(0, '127.0.0.1'); await once(socket, 'listening');
  const messages = [];
  socket.on('message', (packet) => messages.push({ body: decodeWindows(key, packet), received: now() }));
  const send = (body) => new Promise((resolve, reject) => socket.send(encode(body), port, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const t1 = now(); const ping = Buffer.alloc(9); ping[0] = 1; ping.writeBigInt64BE(t1, 1);
  await send(ping); await until(() => messages.some(({ body }) => body[0] === 2));
  const { body: pong, received: t4 } = messages.find(({ body }) => body[0] === 2);
  const t2 = pong.readBigInt64BE(9); const t3 = pong.readBigInt64BE(17);
  const offset = ((t2 - t1) + (t3 - t4)) / 2n;
  // This test is on one host; use its common QPC clock directly to avoid
  // introducing one-sided Node scheduling delays into the playback assertion.
  assert.ok(offset > -100_000_000n && offset < 100_000_000n);
  const model = Buffer.alloc(17); model[0] = 3; model.writeBigInt64BE(0n, 1); model.writeBigInt64BE(1_000_000n, 9);
  const clockDeadline = Date.now() + 2000;
  while (!audio.status().clockReady && Date.now() < clockDeadline) { await send(model); await delay(10); }
  assert.equal(audio.status().clockReady, true, audio.status().error);
  const capture = now(); const packets = [];
  for (let index = 0; index < 20; index++) {
    const body = Buffer.alloc(989); body[0] = 6; body.writeUInt32BE(1, 1); body.writeBigUInt64BE(BigInt(index * 240), 5);
    body.writeBigInt64BE(capture + BigInt(index) * 5_000_000n, 13); body.writeBigInt64BE(capture + 150_000_000n + BigInt(index) * 5_000_000n, 21);
    const packet = encode(body); packets.push(packet);
    await new Promise((resolve, reject) => socket.send(packet, port, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  }
  await until(() => audio.status().packets === 20);
  assert.equal(audio.status().playedFrames, 0, 'future audio must not play as soon as it arrives');
  await until(() => audio.status().playedFrames > 0 || audio.status().error);
  const state = audio.status();
  assert.equal(state.error, undefined); assert.equal(state.running, true); assert.ok(state.playedFrames > 0);
  assert.equal(state.playoutDelayMs, 150); assert.equal(state.clockUncertaintyMs, 0.5);
  assert.ok(Math.abs(state.phaseErrorMs) < 20, 'device playback must follow the host monotonic clock');
  socket.send(packets[0], port, '127.0.0.1');
  const corrupt = Buffer.from(packets[19]); corrupt[corrupt.length - 1] ^= 1; socket.send(corrupt, port, '127.0.0.1');
  await delay(30); assert.equal(audio.status().packets, 20);
  audio.stop(); assert.equal(audio.status().running, false);
});
test('native audio cancellation cannot leave a late device stream running', { skip: !supported }, async () => {
  const audio = new binding.NativeAudio();
  const pending = audio.startReceiver(randomBytes(32).toString('hex'), '127.0.0.1', ''); audio.stop();
  await assert.rejects(pending); assert.equal(audio.status().running, false);
  await assert.rejects(audio.startReceiver('bad-key', '127.0.0.1', ''));
  await assert.rejects(audio.startSender(randomBytes(32).toString('hex'), '127.0.0.1', 45123), /Start audio sharing from the Mac/);
  audio.stop();
});
