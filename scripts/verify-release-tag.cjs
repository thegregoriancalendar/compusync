'use strict';

const { version } = require('../package.json');
const tag = process.argv[2];

if (tag !== `v${version}`) {
  console.error(`Release tag ${JSON.stringify(tag)} must exactly match package version v${version}.`);
  process.exitCode = 1;
} else {
  console.log(`Release tag ${tag} matches package version ${version}.`);
}
