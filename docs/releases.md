# Optional installer and update releases

Source installation is documented in the [README](../README.md). Users can build and update from Git without published installers, an update feed, or signing credentials. This guide describes the packaging/release configuration retained in the repository; it does not imply that a signed installer or a reachable public feed currently exists.

## Current configuration

`package.json` points Electron Builder and the packaged updater at the separate repository **thegregoriancalendar/compusync-releases**. That remains the configured destination even if the source repository is public. Making the source public does not move assets, rewrite the updater feed, or disable the release workflow.

For the current token-free client configuration, binary releases and update metadata must be anonymously readable. Do not embed a GitHub publishing token or private-repository credentials in the app. To use a different public repository or hosting provider, deliberately update/test the builder feed, workflow destination, documentation, and existing clients' upgrade path together.

Packaged apps check stable releases about 30 seconds after startup and then every six hours. Available updates download in the background and install after quitting/reopening. This also applies to locally built apps when Electron considers them packaged; `npm start` source runs do not contact the updater. Set `COMPUSYNC_DISABLE_AUTO_UPDATE=1` in the launching environment for a packaged diagnostic run that should not check the feed.

## Local builds

Quit any running CompuSync instance before building. Install Node.js/Rust and the platform compiler tools described in the README, then run `npm ci` in the checkout.

| Command | Run on | Output under `dist/` |
| --- | --- | --- |
| `npm run build` | Target OS | Unpacked app for the local architecture. |
| `npm run dist:win` | Windows | `CompuSync-Setup-<version>-<arch>.exe` NSIS installer and update files. |
| `npm run dist:mac` | macOS | `CompuSync-<version>-<arch>.dmg`, ZIP, and update files. |

The distribution scripts build/smoke-check the native addon and recovery guard; Windows also builds the Chrome native messaging host. They explicitly pass `--publish never`. A local build does not upload a release.

The native build script currently builds for the local Rust toolchain and copies the addon using Node's platform/architecture. Match those architectures. An Electron Builder architecture flag alone does not cross-compile the Rust components. Build on each intended architecture or first implement and verify the complete cross-compilation path.

Local builds without release credentials are development packages. Signed production packages need the credentials below and real Gatekeeper/installation/update checks. Use the [acceptance checklist](testing.md) for both source and optional package testing.

## Existing GitHub Actions workflows

- **Desktop checks and builds** (`.github/workflows/desktop.yml`) runs native build/smoke, syntax, unit/native tests, and active Electron E2E tests on macOS and Windows. On Windows it also runs the crash-recovery probe. Manual dispatch with packaging enabled adds unsigned installer artifacts; normal pushes/PRs run checks without publishing installers.
- **Release installers** (`.github/workflows/release.yml`) runs on every pushed `v*` tag. It requires the configured binary-release repository to exist/be public and requires publishing/signing credentials. Its build jobs check tag/package version, run syntax/unit tests, run the distribution script, validate installer/update assets, and publish to the separate configured repository only after both platform jobs succeed. It does not run the full native unit/E2E suite itself.

For a source-only release, the existing `v*` trigger still runs and fails if its publishing/signing prerequisites are absent. Decide whether to retain, adapt, or disable that installer workflow before pushing such a tag. Updating this guide does not change the workflow. A GitHub source archive and an installable/updateable desktop package are separate deliverables.

## Production signing and publishing prerequisites

Configure these encrypted repository secrets for the current release workflow:

- `RELEASES_TOKEN`: Contents read/write access to the configured binary-release repository.
- `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`: Windows Authenticode signing credentials.
- `MACOS_CSC_LINK` and `MACOS_CSC_KEY_PASSWORD`: Apple Developer ID Application certificate and password.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`: Apple notarization credentials used by the current macOS build.

Certificate links use Electron Builder's `CSC_LINK` formats, such as a base64-encoded certificate or private authenticated URL. Keep credentials in encrypted secrets, never committed files or packaged configuration. This combined workflow requires Windows credentials even when the immediate audience is Mac users, and Mac credentials even when the immediate audience is Windows users.

Keep the app identifier and signing identity stable across updates. macOS production distribution should be signed/notarized, and macOS automatic updates require signing. Unsigned development packages can trigger Gatekeeper or Windows reputation warnings; successful packaging is not proof that another computer will accept the download.

Once the feed and signing prerequisites are configured, complete source CI and physical/package acceptance for the exact release revision. Update `package.json` and `package-lock.json` to the intended version, then create/push the exact matching version tag. Tagging is the publishing trigger; do not use it merely to test local packaging.

## Release assets and extension updates

Keep generated installer assets, `latest.yml`/`latest-mac.yml`, blockmaps, and the macOS ZIP attached to the same release. The validation script checks platform-specific filenames and update files; do not rename or remove them afterward. Users manually install the Windows EXE or Mac DMG. The Mac updater downloads its ZIP automatically; users do not need a separate local copy of the ZIP.

Windows packages include the unpacked Tab Bridge source plus the native host executable. On startup the app restages extension files and registers the host; Chrome still requires the user to install the managed folder once and reload the unpacked extension when its files change. An app update is not a Chrome Web Store extension update. Macs use Automation instead and need no extension installation.

Verify an actual signed upgrade on each platform, including retained permissions, helper registration, extension reload, and an older running instance's single-instance lock. Do not infer automatic-update success solely from generating metadata or seeing a unit test pass.
