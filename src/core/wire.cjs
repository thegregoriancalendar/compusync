'use strict';

const { randomBytes, hkdfSync, createCipheriv, createDecipheriv, createHash } = require('node:crypto');

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
function createChannel(secret, salt, isHost) {
  const root = secretBytes(secret);
  if (typeof salt !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(salt)) throw new Error('Invalid handshake.');
  const derive = (direction) => Buffer.from(hkdfSync('sha256', root, Buffer.from(salt, 'base64url'), `compusync-v1-${direction}`, 32));
  const sendKey = derive(isHost ? 'host-to-peer' : 'peer-to-host');
  const receiveKey = derive(isHost ? 'peer-to-host' : 'host-to-peer');
  let sent = 0;
  let received = 0;
  const nonce = (n) => { const bytes = Buffer.alloc(12); bytes.writeBigUInt64BE(BigInt(n), 4); return bytes; };
  return {
    seal(message) {
      const n = ++sent;
      const cipher = createCipheriv('aes-256-gcm', sendKey, nonce(n));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(message)), cipher.final()]);
      return JSON.stringify({ n, data: encrypted.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
    },
    open(raw) {
      if (raw.length > 65536) throw new Error('Message too large.');
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
  };
}

module.exports = { newSecret, createChannel, handshakeSalt, makeInvitation, parseInvitation, validHost };
