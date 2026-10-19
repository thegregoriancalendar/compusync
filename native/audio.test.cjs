'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { createCipheriv, randomBytes } = require('node:crypto');
const { loadBinding } = require('./index.cjs');

const binding = loadBinding().binding;
const supported = Boolean(binding?.NativeAudio) && process.platform === 'win32';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('native Windows audio receives authenticated silent packets through a real output stream', { skip: !supported }, async (t) => {
  const audio = new binding.NativeAudio();
  t.after(() => audio.stop());
  const outputs = audio.outputs();
  if (!outputs.length) { t.skip('No physical Windows audio output is available.'); return; }
  assert.ok(outputs.every((output) => typeof output.id === 'string' && typeof output.label === 'string'));
  const key = randomBytes(32);
  const port = await audio.startReceiver(key.toString('hex'), '127.0.0.1', '');
  assert.ok(port > 0 && port <= 65535);
  const socket = dgram.createSocket('udp4');
  t.after(() => socket.close());
  const packets = [];
  for (let sequence = 0; sequence < 20; sequence++) {
    const header = Buffer.alloc(12);
    header.write('CSA1');
    header.writeBigUInt64BE(BigInt(sequence), 4);
    const encrypt = createCipheriv('aes-256-gcm', key, header);
    encrypt.setAAD(header);
    const packet = Buffer.concat([header, encrypt.update(Buffer.alloc(960)), encrypt.final(), encrypt.getAuthTag()]);
    packets.push(packet);
    await new Promise((resolve, reject) => socket.send(packet, port, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  }
  const deadline = Date.now() + 2000;
  while (audio.status().packets < 20 && Date.now() < deadline) await delay(10);
  assert.equal(audio.status().packets, 20);
  assert.equal(audio.status().running, true);
  assert.equal(audio.status().error, undefined);
  // Old authenticated data and a corrupted tag cannot advance receive status.
  await delay(150);
  socket.send(packets[0], port, '127.0.0.1');
  const tampered = Buffer.from(packets[19]);
  tampered[tampered.length - 1] ^= 1;
  socket.send(tampered, port, '127.0.0.1');
  await delay(30);
  assert.equal(audio.status().packets, 20);
  audio.stop();
  assert.equal(audio.status().running, false);
});

test('native audio cancellation cannot leave a late device stream running', { skip: !supported }, async () => {
  const audio = new binding.NativeAudio();
  const pending = audio.startReceiver(randomBytes(32).toString('hex'), '127.0.0.1', '');
  audio.stop();
  await assert.rejects(pending);
  assert.equal(audio.status().running, false);
  await assert.rejects(audio.startReceiver('bad-key', '127.0.0.1', ''));
  await assert.rejects(audio.startSender(randomBytes(32).toString('hex'), '127.0.0.1', 45123), /Start audio sharing from the Mac/);
  audio.stop();
});
