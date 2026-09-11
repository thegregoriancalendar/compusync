'use strict';

const { randomBytes, scrypt } = require('node:crypto');
const { promisify } = require('node:util');
const { WebSocket } = require('ws');
const { newSecret, createChannel, handshakeSalt, validHost } = require('./wire.cjs');
const { discover } = require('./discovery.cjs');

// Crockford's alphabet avoids ambiguous I/L/O; typed aliases are accepted.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LIFETIME = 15 * 60 * 1000;
const derive = promisify(scrypt);

function normalizeCode(value) {
  if (typeof value !== 'string' || value.length > 32) throw new Error('Enter the 8-character code shown on the other laptop.');
  const code = value.trim().toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(code)) throw new Error('Enter the 8-character code shown on the other laptop.');
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function newCode() {
  return normalizeCode([...randomBytes(8)].map((byte) => ALPHABET[byte & 31]).join(''));
}

async function pairingSecret(code, salt) {
  const key = await derive(normalizeCode(code), `compusync-pairing-v1:${salt}`, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return key.toString('base64url');
}

function claimCode(endpoint, code, { timeout = 3500 } = {}) {
  if (!validHost(endpoint.host) || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) return Promise.reject(new Error('Invalid laptop address.'));
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${endpoint.host}:${endpoint.port}`, { handshakeTimeout: timeout, maxPayload: 16384, perMessageDeflate: false });
    let channel, stage = 'challenge', done = false;
    const timer = setTimeout(() => finish(new Error('The laptop did not respond to pairing.')), timeout);
    function finish(error, result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.terminate();
      if (error) reject(error); else resolve(result);
    }
    socket.on('error', () => finish(new Error('Could not reach this laptop.')));
    socket.on('close', () => finish(new Error('The code was not accepted.')));
    socket.on('message', async (raw) => {
      if (done) return;
      try {
        if (stage === 'challenge') {
          stage = 'deriving';
          const message = JSON.parse(raw.toString());
          if (message.type !== 'challenge' || message.version !== 1) throw new Error('Incompatible app version.');
          const salt = newSecret();
          const combined = handshakeSalt(message.salt, salt);
          channel = createChannel(await pairingSecret(code, combined), combined, false);
          if (done) return;
          stage = 'ready';
          socket.send(JSON.stringify({ type: 'key', mode: 'pair', salt }));
        } else if (stage === 'ready') {
          const message = channel.open(raw);
          if (message.type !== 'pair-ready') throw new Error('Pairing failed.');
          stage = 'claim';
          socket.send(channel.seal({ type: 'claim' }));
        } else if (stage === 'claim') {
          const message = channel.open(raw);
          if (message.type !== 'paired' || typeof message.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(message.secret)) throw new Error('Pairing failed.');
          finish(null, { ...endpoint, secret: message.secret });
        } else throw new Error('Unexpected pairing message.');
      } catch (error) { finish(error); }
    });
  });
}

async function pairWithCode(value, { excludeId, address, port = 43187, discoveryOptions } = {}) {
  const code = normalizeCode(value);
  if (address && !validHost(address)) throw new Error('Enter a hostname or IPv4 address, without a URL prefix.');
  const endpoints = address ? [{ host: address, port }] : await discover({ ...discoveryOptions, excludeId });
  if (!endpoints.length) throw new Error('No laptop found. Keep both apps open on the same Wi-Fi, or enter its address under Connection help.');
  for (const endpoint of endpoints.slice(0, 8)) {
    try { return await claimCode(endpoint, code); } catch { /* Another host may own the code. */ }
  }
  throw new Error('Code not found or expired. Check the code or generate a new one on the other laptop.');
}

module.exports = { newCode, normalizeCode, pairingSecret, claimCode, pairWithCode, CODE_LIFETIME };
