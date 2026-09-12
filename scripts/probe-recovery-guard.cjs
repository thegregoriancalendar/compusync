'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('Skipping the hard-kill recovery probe: it requires an interactive Windows desktop.');
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, '..');
const probe = path.join(projectRoot, 'native', 'probes', 'windows-crash-recovery.ps1');
const addon = path.join(projectRoot, 'native', `compusync-native.${process.platform}-${process.arch}.node`);
const guard = path.join(projectRoot, 'native', 'compusync-recovery-guard.exe');
const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;
const command = [
  `$result = & ${quotePowerShell(probe)} -Addon ${quotePowerShell(addon)} -Guard ${quotePowerShell(guard)}`,
  '$result | ConvertTo-Json -Compress',
  "if (-not $result.Passed) { Write-Error 'Recovery guard did not restore the cursor after hard termination'; exit 1 }",
].join('; ');
const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
  cwd: projectRoot,
  encoding: 'utf8',
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
