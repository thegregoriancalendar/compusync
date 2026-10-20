'use strict';

const dgram = require('node:dgram');
const os = require('node:os');
const { randomBytes } = require('node:crypto');

const DISCOVERY_PORT = 43188;
const GROUP = '239.255.43.187';
const PROTOCOL = 'compusync-discovery-1';

function close(socket) { try { socket.close(); } catch { /* Already closed. */ } }

async function advertise(getHost, options = {}) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(options.port ?? DISCOVERY_PORT, '0.0.0.0', () => { socket.removeListener('error', reject); resolve(); });
  }).catch((error) => { close(socket); throw error; });
  socket.on('error', () => {});
  const interfaces = Object.values(os.networkInterfaces()).flat().filter((entry) => entry?.family === 'IPv4').map((entry) => entry.address);
  for (const address of interfaces) {
    try { socket.addMembership(GROUP, address); } catch { /* Unicast discovery still works. */ }
  }
  let start = Date.now(), count = 0;
  socket.on('message', (raw, remote) => {
    if (raw.length > 512) return;
    if (Date.now() - start > 1000) { start = Date.now(); count = 0; }
    if (++count > 24) return;
    try {
      const query = JSON.parse(raw.toString());
      if (query.protocol !== PROTOCOL || query.type !== 'find' || !/^[a-f0-9]{32}$/.test(query.nonce)) return;
      const host = getHost();
      if (!host) return;
      // Neither the code nor any derivative of it is advertised.
      const reply = Buffer.from(JSON.stringify({ protocol: PROTOCOL, type: 'host', nonce: query.nonce, id: host.id, port: host.port,
        ...(['darwin', 'win32', 'unsupported'].includes(host.platform) ? { platform: host.platform } : {}) }));
      socket.send(reply, remote.port, remote.address, () => {});
    } catch { /* Ignore unrelated LAN packets. */ }
  });
  socket.unref();
  return { port: socket.address().port, stop: () => close(socket) };
}

async function discover({ excludeId, port = DISCOVERY_PORT, timeout = 1600, destinations = [GROUP, '255.255.255.255', '127.0.0.1'] } = {}) {
  const socket = dgram.createSocket('udp4');
  const nonce = randomBytes(16).toString('hex');
  const found = new Map();
  let interval, deadline, finished = false;
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearInterval(interval); clearTimeout(deadline); close(socket);
      if (error) reject(error); else resolve([...found.values()]);
    };
    socket.once('error', () => finish(new Error('Local discovery is unavailable. Enter the other laptop’s address under Connection help.')));
    socket.on('message', (raw, remote) => {
      if (raw.length > 512 || found.size >= 16) return;
      try {
        const message = JSON.parse(raw.toString());
        if (message.protocol !== PROTOCOL || message.type !== 'host' || message.nonce !== nonce || typeof message.id !== 'string' || message.id === excludeId || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return;
        const key = `${remote.address}:${message.port}`;
        found.set(key, { host: remote.address, port: message.port,
          ...(['darwin', 'win32', 'unsupported'].includes(message.platform) ? { platform: message.platform } : {}) });
      } catch { /* Ignore malformed/unrelated packets. */ }
    });
    socket.bind(0, '0.0.0.0', () => {
      if (finished) return;
      try { socket.setBroadcast(true); socket.setMulticastTTL(1); }
      catch { finish(new Error('Local discovery is unavailable. Enter the other laptop’s address under Connection help.')); return; }
      const probe = () => {
        const raw = Buffer.from(JSON.stringify({ protocol: PROTOCOL, type: 'find', nonce }));
        for (const address of destinations) socket.send(raw, port, address, () => {});
      };
      probe();
      interval = setInterval(probe, 450);
      deadline = setTimeout(() => finish(), timeout);
    });
  });
}

module.exports = { advertise, discover, DISCOVERY_PORT };
