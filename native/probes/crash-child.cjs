'use strict';

const binding = require(process.argv[2]);
const substrate = new binding.NativeSubstrate();
substrate.installRecoveryGuard(process.argv[3]);
substrate.hideCursor();
substrate.parkCursor();
process.stdout.write('READY\n');
setInterval(() => {}, 1000);
