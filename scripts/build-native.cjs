'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const nativeRoot = path.join(projectRoot, 'native');
const targetRoot = path.join(nativeRoot, 'target');

const libraryNames = {
  win32: 'compusync_native.dll',
  darwin: 'libcompusync_native.dylib',
  linux: 'libcompusync_native.so',
};

const libraryName = libraryNames[process.platform];
if (!libraryName) {
  throw new Error(`Building the Compusync native addon is unsupported on ${process.platform}`);
}

const cargoExecutable = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const rustupCargo = path.join(os.homedir(), '.cargo', 'bin', cargoExecutable);
const cargo = process.env.COMPUSYNC_CARGO || (fs.existsSync(rustupCargo) ? rustupCargo : cargoExecutable);
const result = spawnSync(cargo, [
  'build',
  '--locked',
  '--release',
  '--lib',
  '--manifest-path',
  path.join(nativeRoot, 'Cargo.toml'),
], {
  cwd: projectRoot,
  env: { ...process.env, CARGO_TARGET_DIR: targetRoot },
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const source = path.join(targetRoot, 'release', libraryName);
const destination = path.join(nativeRoot, `compusync-native.${process.platform}-${process.arch}.node`);
if (!fs.existsSync(source)) throw new Error(`Cargo did not produce the expected library: ${source}`);

fs.copyFileSync(source, destination);
console.log(`Native addon ready: ${path.relative(projectRoot, destination)}`);

const guardRoot = path.join(nativeRoot, 'recovery-guard');
const guardTargetRoot = path.join(targetRoot, 'recovery-guard');
const guardBuild = spawnSync(cargo, [
  'build',
  '--locked',
  '--release',
  '--manifest-path',
  path.join(guardRoot, 'Cargo.toml'),
], {
  cwd: projectRoot,
  env: { ...process.env, CARGO_TARGET_DIR: guardTargetRoot },
  stdio: 'inherit',
});

if (guardBuild.error) throw guardBuild.error;
if (guardBuild.status !== 0) process.exit(guardBuild.status ?? 1);

const guardName = `compusync-recovery-guard${process.platform === 'win32' ? '.exe' : ''}`;
const guardSource = path.join(guardTargetRoot, 'release', guardName);
const guardDestination = path.join(nativeRoot, guardName);
if (!fs.existsSync(guardSource)) throw new Error(`Cargo did not produce the recovery guard: ${guardSource}`);

fs.copyFileSync(guardSource, guardDestination);
if (process.platform !== 'win32') fs.chmodSync(guardDestination, 0o755);
console.log(`Recovery guard ready: ${path.relative(projectRoot, guardDestination)}`);
