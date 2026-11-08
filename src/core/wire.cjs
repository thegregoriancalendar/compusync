'use strict';

const { randomBytes, hkdfSync, createCipheriv, createDecipheriv, createHash } = require('node:crypto');

const FRAME_AAD = Buffer.from('compusync-v1-frame');
const FRAME_PREFIX = 8 + 16;
const FRAME_HEADER_MAX = 64 * 1024;
const EMPTY = Buffer.alloc(0);

const newSecret = () => randomBytes(32).toString('base64url');
function secretBytes(secret) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Invalid pairing secret.');
  const key = Buffer.from(secret, 'base64url');
  if (key.length !== 32) throw new Error('Invalid pairing secret.');
  return key;
}

function validHost(host) {
  return typeof host === 'string' && host.length <= 253 && /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host);
}

function handshakeSalt(hostSalt, peerSalt) {
  // Both endpoints supply freshness: replaying an old server challenge must
  // never make the client reuse an AES-GCM key/nonce pair after reconnecting.
  secretBytes(hostSalt);
  secretBytes(peerSalt);
  return createHash('sha256').update(hostSalt).update(peerSalt).digest('base64url');
}

function makeInvitation(host, port, secret) {
  return `CS1.${Buffer.from(JSON.stringify({ host, port, secret })).toString('base64url')}`;
}

function parseInvitation(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048 || !value.trim().startsWith('CS1.')) throw new Error();
    const { host, port, secret } = JSON.parse(Buffer.from(value.trim().slice(4), 'base64url').toString());
    if (!validHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    secretBytes(secret);
    return { host, port, secret };
  } catch {
    throw new Error('Paste the complete invitation from the other laptop.');
  }
}

// Every connection has a fresh challenge and separate directional keys. Strict
// counters reject replay/reordering, and AES-GCM authenticates each message.
function createChannel(secret, salt, isHost, options = {}) {
  const root = secretBytes(secret);
  if (typeof salt !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(salt)) throw new Error('Invalid handshake.');
  const context = options.context ?? 'control';
  const maxMessage = options.maxMessage ?? 65536;
  if (typeof context !== 'string' || !/^[a-z0-9-]{1,32}$/.test(context)
    || !Number.isSafeInteger(maxMessage) || maxMessage < 64 || maxMessage > 16 * 1024 * 1024) throw new Error('Invalid channel options.');
  // Keep the original control KDF labels stable while giving every auxiliary
  // channel a distinct cryptographic context.
  const label = (direction) => context === 'control'
    ? `compusync-v1-${direction}`
    : `compusync-v1-${context}-${direction}`;
  const derive = (direction) => Buffer.from(hkdfSync('sha256', root, Buffer.from(salt, 'base64url'), label(direction), 32));
  const sendKey = derive(isHost ? 'host-to-peer' : 'peer-to-host');
  const receiveKey = derive(isHost ? 'peer-to-host' : 'host-to-peer');
  let sent = 0;
  let received = 0;
  const nonce = (n) => { const bytes = Buffer.alloc(12); bytes.writeBigUInt64BE(BigInt(n), 4); return bytes; };
  return {
    seal(message) {
      const n = sent + 1;
      const cipher = createCipheriv('aes-256-gcm', sendKey, nonce(n));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(message)), cipher.final()]);
      const packet = JSON.stringify({ n, data: encrypted.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
      if (Buffer.byteLength(packet) > maxMessage) throw new Error('Message too large.');
      sent = n;
      return packet;
    },
    open(raw) {
      if (raw.length > maxMessage) throw new Error('Message too large.');
      const packet = JSON.parse(raw.toString());
      if (!Number.isSafeInteger(packet.n) || packet.n !== received + 1 || typeof packet.data !== 'string' || typeof packet.tag !== 'string') throw new Error('Invalid message sequence.');
      const decipher = createDecipheriv('aes-256-gcm', receiveKey, nonce(packet.n));
      const tag = Buffer.from(packet.tag, 'base64');
      if (tag.length !== 16) throw new Error('Invalid authentication tag.');
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(Buffer.from(packet.data, 'base64')), decipher.final()]);
      const message = JSON.parse(plaintext.toString());
      received = packet.n;
      return message;
    },
    // Binary frames carry a small JSON header plus raw bytes without the
    // double base64 cost of `seal`. They share the strict counter (and so the
    // nonce space) with JSON packets; the AAD label keeps one kind from ever
    // authenticating as the other. Layout: n (u64 BE) | tag (16) | ciphertext
    // of [header length (u32 BE) | header JSON | payload].
    sealFrame(header, payload = EMPTY) {
      if (!Buffer.isBuffer(payload)) throw new TypeError('Frame payload must be a Buffer.');
      const headerBytes = Buffer.from(JSON.stringify(header));
      if (headerBytes.length > FRAME_HEADER_MAX) throw new Error('Frame header too large.');
      const total = FRAME_PREFIX + 4 + headerBytes.length + payload.length;
      if (total > maxMessage) throw new Error('Message too large.');
      const n = sent + 1;
      const cipher = createCipheriv('aes-256-gcm', sendKey, nonce(n));
      cipher.setAAD(FRAME_AAD);
      const frame = Buffer.allocUnsafe(total);
      frame.writeBigUInt64BE(BigInt(n), 0);
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(headerBytes.length, 0);
      let offset = FRAME_PREFIX;
      for (const part of [length, headerBytes, payload]) offset += cipher.update(part).copy(frame, offset);
      offset += cipher.final().copy(frame, offset);
      cipher.getAuthTag().copy(frame, 8);
      if (offset !== total) throw new Error('Frame encryption length mismatch.');
      sent = n;
      return frame;
    },
    openFrame(raw) {
      if (!Buffer.isBuffer(raw) || raw.length < FRAME_PREFIX + 4 || raw.length > maxMessage) throw new Error('Invalid frame size.');
      const n = raw.readBigUInt64BE(0);
      if (n !== BigInt(received + 1)) throw new Error('Invalid message sequence.');
      const decipher = createDecipheriv('aes-256-gcm', receiveKey, nonce(received + 1));
      decipher.setAAD(FRAME_AAD);
      decipher.setAuthTag(raw.subarray(8, FRAME_PREFIX));
      const plaintext = Buffer.concat([decipher.update(raw.subarray(FRAME_PREFIX)), decipher.final()]);
      const headerLength = plaintext.readUInt32BE(0);
      if (headerLength > FRAME_HEADER_MAX || 4 + headerLength > plaintext.length) throw new Error('Invalid frame header.');
      const header = JSON.parse(plaintext.subarray(4, 4 + headerLength).toString());
      received += 1;
      return { header, payload: plaintext.subarray(4 + headerLength) };
    },
  };
}

module.exports = { newSecret, createChannel, handshakeSalt, makeInvitation, parseInvitation, validHost, FRAME_HEADER_MAX };
