# CompuSync development handoff

Current behavior reviewed against the working source on October 20, 2026. This is a source map and continuation guide, not a record of a clean working tree, a pending implementation request, or permission to publish. The original handoff is preserved in the [historical archive](archive/handoff-2026-09-11.md).

## Product boundary

CompuSync supports two Macs or a Mac and Windows 11 on the same local network. Windows-to-Windows pairing is rejected. Both computers run the app; neither a cloud account nor a relay is required.

The active app provides native cursor/keyboard sharing, plain-text clipboard sharing, Chrome window handoff, bidirectional synchronized audio, and a Windows Messages Companion backed by the paired Mac. Connection & settings includes a separate Latency Monitor page. A transient, noninteractive overlay marks a Chrome straddle.

The old shared surface, grid, mini desktop, workspace/file-transfer UI, and bundled editor are retired. Their source and unit tests remain for historical coverage, but the shipping entry point must not instantiate their windows or advertise them as current features. The optional Messages Companion window is part of the current product.

## Platform setup

Use the [README](../README.md) for build commands and the [Mac guide](mac-setup.md) for permissions. Build independently on each platform/architecture; never copy Windows dependencies or native output onto a Mac.

- **Windows Chrome:** `ChromeAdapterRuntime` uses the Tab Bridge extension with the user's existing Chrome profile. Setup stages three extension files into CompuSync user data, writes/registers the per-user native host manifest, and opens Chrome Extensions plus the managed folder after consent. The user enables Developer mode and loads that folder. The Rust host relays native messages through a Windows named pipe. Restarting Chrome into an isolated profile and opening a loopback debugging port are not the active setup path.
- **Mac Chrome:** the runtime uses JXA/Apple Events and Accessibility; no extension or native messaging registration is required. Accessibility, Input Monitoring, and Chrome Automation are checked during first-run startup. The optional Chrome setting **Allow JavaScript from Apple Events** enables scroll/draft transfer; basic tab/URL handoff works without it.
- **Audio:** either supported computer can send, with one route active at a time. Mac capture requires macOS 14.6+ and recording permission. Windows sending requires standard VB-CABLE; Windows receiving does not. See the [audio guide](audio-routing.md).
- **Messages:** Windows displays the companion. The Mac reads Messages/Contacts locally with Full Disk Access and uses Messages Automation to send. Permissions apply to the actual launching application identity.

## Implementation map

| Area | Entry points |
| --- | --- |
| App lifecycle, settings, tray/menu, permissions | `src/main.cjs`, `src/main/macos-permissions.cjs` |
| Pairing, discovery, encrypted sessions | `src/core/pairing.cjs`, `src/core/discovery.cjs`, `src/core/session.cjs`, `src/core/wire.cjs` |
| Supported pairs, names, layout slots | `src/shared/devices.js`, `src/core/cursor-preferences.cjs` |
| Native cursor, keyboard, scrolling, recovery | `src/main/runtime.cjs`, `src/main/cursor.cjs`, `src/main/input-runtime.cjs`, `src/main/keyboard.cjs`, `src/main/scroll.cjs`, `src/main/watchdog.cjs`, `native/` |
| Chrome handoff and straddles | `src/main/window-runtime.cjs`, `src/main/drag.cjs`, `src/main/adapters/chrome/runtime.cjs` |
| Windows Chrome setup and bridge | `src/main/adapters/chrome/setup.cjs`, `native-messaging-server.cjs` and `extension-adapter.cjs` in that directory, its `extension/` subdirectory, `native/chrome-host/` |
| Mac Chrome | `src/main/adapters/chrome/apple.cjs` |
| Settings and layout editor | `src/renderer/settings.*`, `src/renderer/screen-layout.js` |
| Clipboard and shared development logs | `src/main/clipboard-sync.cjs`, `src/main/log-sync.cjs` |
| Audio and timing | `src/main/audio-router.cjs`, `src/main/audio-engine.cjs`, `src/core/audio-contract.cjs`, `native/src/audio/`, `native/windows-audio/` |
| Messages Companion | `src/messages/`, `src/renderer/messages.*` |
| Optional packaged updates | `src/main/updates.cjs`, `docs/releases.md` |
| Retired surface/workspace/editor | `src/core/workspace.cjs`, `src/core/transfer.cjs`, `src/desktop-service.cjs`, `src/programs/`, `src/renderer/surface.*` and `desktop.js` |

Paths in this table are relative to the repository root unless a directory is stated. Retained CDP/profile utilities under `src/main/adapters/chrome/` are not selected by the active Windows runtime.

## Before changing code

1. Read applicable repository instructions and inspect the actual branch and working tree. Do not assume the historical handoff's paths, version, clean status, artifacts, or commit are current. Preserve unrelated local changes.
2. Follow the current platform path in `src/main.cjs` and the relevant runtime before editing a retained adapter or renderer. Existing files are not proof that a feature is shipped.
3. Preserve native/main-process input routing, reliable acknowledgement before normal source-window destruction, and local recovery without a live peer or renderer.
4. Keep supported-pair identity separate from legacy `mac`/`windows` geometry slots: a slot can contain the second Mac. Do not use those slot names to infer the operating system.
5. Record validation against a specific revision and OS. Use the [testing checklist](testing.md); distinguish simulated engines and same-machine Electron tests from hardware acceptance.

Use `npm run check`, `npm test`, `npm run test:native`, and `npm run test:e2e` as appropriate after following the native build prerequisites. The desktop workflow runs on macOS and Windows. The two retired surface/workspace E2E suites are excluded by `playwright.config.cjs`; their presence does not make those UIs supported.

`scripts/demo.cjs` is an older two-process harness whose console text still refers to the retired shared window. It is not the installation or acceptance procedure; use the current app and active E2E suites. Legacy Windows CDP probes likewise test an explicit disposable profile, not the normal extension setup.

## Releases and evidence

Source runs update manually and do not use the installer updater. The existing `v*` tag workflow still targets a separate binary release repository and requires publishing and signing secrets for both platforms. See [releases](releases.md) before creating a version tag; merely making the source public does not change that configuration.

The [implementation status](IMPLEMENTATION_REPORT.md) describes verification limits. Historical reports are retained as evidence for their recorded revisions, not as a current release gate. No physical result, CI status, artifact existence, or publication readiness should be inferred from this handoff alone.
