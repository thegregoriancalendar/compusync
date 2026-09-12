'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const argumentsList = process.argv.slice(2);
const electronChild = argumentsList.includes('--electron-child');
const resourcesIndex = argumentsList.indexOf('--resources');
const resourcesPath = resourcesIndex === -1 ? null : path.resolve(argumentsList[resourcesIndex + 1] || '');
const artifactName = `compusync-native.${process.platform}-${process.arch}.node`;
const artifactPath = resourcesPath
  ? path.join(resourcesPath, 'native', artifactName)
  : path.join(projectRoot, 'native', artifactName);
const guardName = `compusync-recovery-guard${process.platform === 'win32' ? '.exe' : ''}`;
const guardPath = path.join(path.dirname(artifactPath), guardName);

assert.ok(fs.existsSync(artifactPath), `native addon is missing: ${artifactPath}`);
assert.ok(fs.existsSync(guardPath), `recovery guard is missing: ${guardPath}`);

if (resourcesPath) {
  delete process.env.COMPUSYNC_NATIVE_PATH;
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath });
} else {
  process.env.COMPUSYNC_NATIVE_PATH = artifactPath;
}

const { createNativeAdapter, loadBinding } = require('../native/index.cjs');
const loaded = loadBinding();
assert.ok(loaded.binding, loaded.failures.map((failure) => failure.message).join('\n'));
assert.equal(path.resolve(loaded.path), artifactPath);
assert.equal(typeof loaded.binding.NativeSubstrate, 'function');
const adapter = createNativeAdapter({ required: true });
assert.equal(path.resolve(adapter.guardPath), guardPath);

if (electronChild) {
  assert.ok(process.versions.electron, 'smoke child must run with Electron');
  console.log(`Electron ${process.versions.electron} loaded ${artifactName} with ${guardName}`);
  process.exit(0);
}

console.log(`Node ${process.versions.node} loaded ${artifactName} with ${guardName}`);
const electronExecutable = require('electron');
const childArguments = [__filename, '--electron-child'];
if (resourcesPath) childArguments.push('--resources', resourcesPath);
const child = spawnSync(electronExecutable, childArguments, {
  cwd: projectRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});
if (child.error) throw child.error;
if (child.status !== 0) process.exit(child.status ?? 1);
