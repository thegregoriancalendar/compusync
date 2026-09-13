const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/e2e',
  // These suites exercise the retired v1 shared surface and workspace UI.
  testIgnore: ['desktop.spec.cjs', 'workspace.spec.cjs'],
  timeout: 60000,
  workers: 1,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
