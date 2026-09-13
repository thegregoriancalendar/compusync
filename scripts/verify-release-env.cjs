'use strict';

const platform = process.argv[2];
const required = platform === 'Windows'
  ? ['WINDOWS_CSC_LINK', 'WINDOWS_CSC_KEY_PASSWORD']
  : platform === 'macOS'
    ? ['MACOS_CSC_LINK', 'MACOS_CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
    : [];

if (!required.length) {
  console.error(`Unknown release platform: ${JSON.stringify(platform)}.`);
  process.exitCode = 1;
} else {
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`Production ${platform} release is missing required repository secrets: ${missing.join(', ')}.`);
    process.exitCode = 1;
  } else {
    console.log(`Production ${platform} signing environment is configured.`);
  }
}
