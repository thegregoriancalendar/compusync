'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { newSecret } = require('../src/core/wire.cjs');

async function main() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const root = path.resolve('.demo');
  fs.mkdirSync(root, { recursive: true });
  const profileRoot = fs.mkdtempSync(path.join(root, 'pair-'));
  const secret = newSecret();
  const children = ['host', 'join'].map((role, index) => {
    const profile = path.join(profileRoot, role);
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ id: randomUUID(), name: `Demo laptop ${index + 1}`, role, host: '127.0.0.1', port, secret, edge: index ? 'left' : 'right' }));
    const env = { ...process.env, COMPUSYNC_PROFILE: profile, COMPUSYNC_BIND_HOST: '127.0.0.1' };
    delete env.ELECTRON_RUN_AS_NODE;
    return spawn(require('electron'), ['.'], { env, stdio: 'inherit' });
  });
  console.log('Two local laptops are running. Ctrl/Cmd+, opens settings. Close a shared window to close both; reopen from a tray icon. Quit both apps to end the demo.');
  process.on('SIGINT', () => { children.forEach((child) => child.kill()); });
  await Promise.all(children.map((child) => new Promise((resolve) => child.on('exit', resolve))));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
