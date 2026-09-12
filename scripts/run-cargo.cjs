'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const executableName = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const rustupCargo = path.join(os.homedir(), '.cargo', 'bin', executableName);
const cargo = process.env.COMPUSYNC_CARGO || (fs.existsSync(rustupCargo) ? rustupCargo : executableName);
const result = spawnSync(cargo, process.argv.slice(2), {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
