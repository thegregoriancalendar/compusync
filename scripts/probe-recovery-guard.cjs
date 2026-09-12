'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

function assessRecoveryProbe(report = {}) {
  const cursorVisibilityObservable = report.BaselineCursorVisible === true;
  const cursorHideObserved = !cursorVisibilityObservable || report.ArmedCursorVisible === false;
  const cursorVisibilityRecovered = !cursorVisibilityObservable || report.RecoveredCursorVisible === true;
  const passed = report.ArmedClipReleased === false
    && report.RecoveredClipReleased === true
    && cursorHideObserved
    && cursorVisibilityRecovered;
  return {
    ...report,
    CursorVisibilityObservable: cursorVisibilityObservable,
    CursorHideObserved: cursorHideObserved,
    CursorVisibilityRecovered: cursorVisibilityRecovered,
    Passed: passed,
  };
}

function main() {
  if (process.platform !== 'win32') {
    console.log('Skipping the hard-kill recovery probe: it requires Windows.');
    return 0;
  }

  const projectRoot = path.resolve(__dirname, '..');
  const probe = path.join(projectRoot, 'native', 'probes', 'windows-crash-recovery.ps1');
  const addon = path.join(projectRoot, 'native', `compusync-native.${process.platform}-${process.arch}.node`);
  const guard = path.join(projectRoot, 'native', 'compusync-recovery-guard.exe');
  const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;
  const command = [
    `$result = & ${quotePowerShell(probe)} -Addon ${quotePowerShell(addon)} -Guard ${quotePowerShell(guard)}`,
    '$result | ConvertTo-Json -Compress',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    cwd: projectRoot,
    encoding: 'utf8',
  });

  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    return result.status ?? 1;
  }

  let report;
  try { report = assessRecoveryProbe(JSON.parse(result.stdout.trim())); }
  catch (error) {
    process.stderr.write(`Recovery guard probe returned invalid output: ${error.message}\n`);
    if (result.stdout) process.stderr.write(result.stdout);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.Passed) {
    process.stderr.write('Recovery guard did not restore observable OS state after hard termination\n');
    return 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { assessRecoveryProbe, main };
