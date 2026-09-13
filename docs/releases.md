# Installer and update releases

CompuSync publishes a Windows NSIS installer and macOS DMG through the separate public `thegregoriancalendar/compusync-releases` GitHub repository. The source repository is private, and an installed application cannot safely embed credentials to read private release assets. The binary release repository must therefore exist and remain public. Electron Builder also emits `latest.yml`, `latest-mac.yml`, blockmaps, and a macOS ZIP; these are update payloads and must remain attached to the release. Users install the Windows `.exe` or macOS `.dmg`, not the YAML files.

Packaged applications check the repository's latest stable GitHub Release after startup and every six hours. Updates download in the background and install when the user next quits and reopens CompuSync. Source/development runs never contact the update provider. Set `COMPUSYNC_DISABLE_AUTO_UPDATE=1` to disable checks in a packaged diagnostic run.

## Create a release

1. Update `version` in `package.json` and `package-lock.json` and merge the release commit to `main`.
2. Complete the packaged acceptance checks in [testing.md](testing.md).
3. Create and push an exact matching tag. For version `0.3.0`:

   ```sh
   git tag v0.3.0
   git push origin v0.3.0
   ```

The `Release installers` workflow verifies that the tag and package version match, runs checks and tests on both operating systems, builds the platform-native addon and recovery guard, and creates the GitHub Release with the installers and update metadata. Do not rename or remove its generated assets.

## Signing and notarization

Configure these GitHub Actions repository secrets before a production release:

- `RELEASES_TOKEN`: fine-grained token with Contents read/write access to the public `compusync-releases` repository.
- `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`: Windows Authenticode certificate and password.
- `MACOS_CSC_LINK` and `MACOS_CSC_KEY_PASSWORD`: Apple Developer ID Application certificate and password.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`: Apple notarization credentials.

The certificate-link secrets use Electron Builder's `CSC_LINK` formats, such as a base64-encoded certificate or a private authenticated URL. Keep certificates and passwords only in encrypted repository secrets.

The manually dispatched desktop workflow can produce unsigned test artifacts. The tag-triggered production release workflow intentionally fails when its publishing or signing secrets are absent. macOS automatic updates require a signed app, unsigned macOS builds trigger Gatekeeper, and unsigned Windows builds trigger reputation/SmartScreen warnings. Keep the application identifier and signing identity stable across releases or operating systems may reject the replacement.
