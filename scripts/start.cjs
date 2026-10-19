'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const logPath = path.join(root, 'compusync.log');

function start() {
  const log = fs.openSync(logPath, 'a');
  try {
    fs.writeSync(log, `\n[${new Date().toISOString()}] Starting CompuSync\n`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // Pass the file directly so stdout and stderr remain readable while the
    // app is running, including output from native code and early failures.
    const child = spawn(require('electron'), ['.', ...process.argv.slice(2)], {
      cwd: root,
      env,
      stdio: ['inherit', log, log],
      windowsHide: false,
    });
    let closed = false;
    child.once('error', (error) => {
      const message = `Could not start CompuSync: ${error.message}`;
      console.error(message);
      fs.appendFileSync(logPath, `${message}\n`);
    });
    child.once('close', (code) => {
      closed = true;
      process.exitCode = Number.isInteger(code) && code >= 0 ? code : 1;
    });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
      process.on(signal, () => { if (!closed) child.kill(signal); });
    }
    console.log(`CompuSync logs: ${logPath}`);
  } finally {
    // spawn duplicates the handle for the child; the launcher can close its copy.
    fs.closeSync(log);
  }
}

try {
  start();
} catch (error) {
  console.error(`Could not start CompuSync: ${error.message}`);
  process.exitCode = 1;
}
