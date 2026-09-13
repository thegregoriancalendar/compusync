'use strict';

const fs = require('node:fs');
const path = require('node:path');

const platform = process.argv[2];
const directory = path.resolve(process.argv[3] || 'dist');
const files = fs.readdirSync(directory);
const required = platform === 'Windows'
  ? [/^CompuSync-Setup-.+-[^.]+\.exe$/, /^CompuSync-Setup-.+-[^.]+\.exe\.blockmap$/, /^latest\.yml$/]
  : platform === 'macOS'
    ? [/^CompuSync-.+-[^.]+\.dmg$/, /^CompuSync-.+-[^.]+\.zip$/, /^CompuSync-.+-[^.]+\.zip\.blockmap$/, /^latest-mac\.yml$/]
    : [];

if (!required.length) {
  console.error(`Unknown release platform: ${JSON.stringify(platform)}.`);
  process.exitCode = 1;
} else {
  const missing = required.filter((pattern) => !files.some((file) => pattern.test(file)));
  if (missing.length) {
    console.error(`Release output is incomplete for ${platform}; missing: ${missing.join(', ')}.`);
    process.exitCode = 1;
  } else {
    console.log(`Verified ${platform} installer and auto-update metadata.`);
  }
}
