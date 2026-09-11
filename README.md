# CompuSync

A shared desktop window with an interactive grid and one shared cursor, for a Windows 11 laptop and a MacBook. Pair the apps over your local network, move either trackpad inside the window, and drag the window through a screen edge to hand it to the other laptop.

The window contains a light grid that bends and twists around the cursor, ambient particles, and a fading particle trail. Clicking expands the distortion. The effects use shared cursor history and a host clock reference so both laptops see the same activity. Pairing and preferences live in a separate settings window, accessible from the tray/menu bar or **Ctrl+,** on Windows / **Cmd+,** on Mac.

## Run on both laptops

Install Node.js 22.12 or newer. Copy or clone this project onto each laptop, then run these commands in the project folder:

```sh
npm ci
npm start
```

Node is needed to run from source, but not to run a packaged app. Both Apple Silicon and Intel Macs are supported by Electron; install dependencies separately on each machine instead of copying `node_modules` from Windows to Mac.

1. Put both laptops on the same Wi-Fi or wired network. Allow CompuSync/Electron through the firewall on the private network if prompted.
2. On either laptop, open **Share from here** in settings, choose its Wi-Fi network address, and click **Copy invitation**.
3. On the other laptop, open **Join other laptop**, paste the invitation, and click **Connect laptops**. Wait for both to say **Connected**. There is no cloud account or external server.
4. In **Where is the other laptop?**, choose its physical direction. If the Mac is to the right of Windows, choose **right** on Windows and **left** on Mac.
5. Click **Open on both laptops**. Move either mouse into its grid. Both inputs control the same cursor, bend the grid, and emit particles. Clicks produce a brief shared ripple and strengthen the distortion.

The first laptop is the connection host. Either laptop can serve this role, but the chosen host must stay running for the pair to communicate. Pairing is remembered across restarts. Use **Start sharing from here** to create a new invitation and replace the old connection.

## Use the shared window

| Action | Result |
| --- | --- |
| Move into the grid | Your OS cursor is replaced by the shared application cursor; the grid and particles respond. |
| Click inside | Captures relative trackpad movement so you cannot run out of window space. |
| Press Escape | Releases capture and restores the OS cursor. Re-enter or click to resume. |
| Drag the native title bar to the chosen screen edge | The source window disappears and the other laptop presents it at the opposite edge. Release capture first if necessary. |
| Ctrl/Cmd+Shift+Enter | Sends the window to the other laptop without dragging. |
| Show here (tray/menu/settings) | Adds a local view again after a handoff, so both trackpads can participate. |
| Close the native window / Ctrl/Cmd+W | Closes the shared window on both laptops. |
| Open on both laptops / Ctrl/Cmd+Shift+O | Reopens both views. Keyboard shortcuts operate while the app is focused; tray/menu controls work while its window is hidden. |
| Quit on this laptop | Stops that laptop's background connection. The other laptop remains running. |

Closing the shared window keeps a small tray/menu bar process alive so either laptop can reopen it. To receive a remote open or handoff, CompuSync must already be running and the laptop awake. Installed builds can optionally start in the background at sign-in. Opening the app again from the OS also brings its shared window back.

After handoff, the source laptop needs **Show here** to provide trackpad input again. Input is captured only within a visible CompuSync window; the app does not monitor your mouse while you use other applications.

## What this build does

This is an application-level shared surface. It synchronizes the cursor, button presses, grid distortion, particle history, click feedback, window dimensions, open/close state, and handoff. It does not yet host documents, arbitrary apps, or dropped files. It does not install a virtual display driver or extend the operating system desktop. Handoff is a discrete transfer at the configured edge, rather than a window spanning the two physical screens during the drag.

Normal hover control begins without a click. Continuous pointer capture requires a click because desktop Chromium requires a user gesture for pointer lock. Escape always releases capture.

Wi-Fi interruptions trigger automatic reconnect and a fresh state snapshot. Inputs are not queued while offline. The host continues working locally; the joiner cannot change shared state until reconnected. The host also restores its local view if the laptop holding the only visible window disconnects. There is no automatic host migration if the host quits. Connection state is shown in settings and the tray tooltip, keeping controls out of the shared surface.

## Build a standalone app

```sh
# Windows: portable executable in dist/
npm run dist:win

# macOS, run on the Mac: DMG + ZIP for the current architecture in dist/
npm run dist:mac

# macOS explicit architectures (requires macOS)
npm run dist:mac -- --arm64
npm run dist:mac -- --x64

# Unpacked app for the current platform
npm run build
```

Builds are unsigned during development. macOS packaging and signing should be performed on a Mac. The included GitHub Actions workflow runs tests on Windows and macOS and produces unsigned build artifacts when manually requested. No remote repository or signing identity is configured by this project.

## Develop and verify

```sh
npm run check       # Syntax checks
npm test            # State, geometry, encryption, and real network integration tests
npm run test:e2e    # Launches TWO real desktop apps and exercises the UI
npm run demo        # Two paired local instances with isolated demo profiles
```

The end-to-end test requires an interactive desktop. It tests pairing through the settings UI, mouse movement from both instances, synchronized particle history, pointer lock and Escape, handoff through the UI, native close, and reopen in both directions. On Windows it also performs an actual title-bar drag to the screen edge using a DPI-aware native input helper. Geometry tests cover screen edge detection and differently sized displays. Mac dragging, macOS permissions, sleep/wake, and cross-platform scaling still need the two-laptop checks in [docs/testing.md](docs/testing.md).

The demo creates profiles beneath `.demo/` and uses loopback connections. The normal app stores its small settings file in the OS user-data directory (typically `%APPDATA%/CompuSync` or `~/Library/Application Support/CompuSync`). Session cursor state is transient. Pairing secrets use Electron's OS-backed safe storage when available; a mode-0600 local file is the fallback. Treat an invitation as a password: anyone possessing it and able to reach the host can join while its peer slot is free.

## Implementation

- Electron provides native windows, the tray/menu bar, and Windows/macOS drag events.
- One host orders input actions and publishes snapshots over WebSocket. Relative deltas from both trackpads are accumulated in normalized coordinates, so different DPI settings work without competing absolute cursors.
- Each connection exchanges fresh random values from both endpoints, derives directional keys using HKDF-SHA256, and authenticates/encrypts messages with AES-256-GCM and strict sequence numbers. The invitation contains a random 256-bit shared secret. Browser origins, unauthenticated clients, oversized messages, excess peers, and excessive input rates are rejected.
- Heartbeats detect dead connections; exponential retries reconnect automatically. Cursor updates are coalesced to screen frames and slow connections cannot build unbounded buffers.
- A DPI-aware Canvas renderer bends continuous grid lines around the cursor. Particles are generated deterministically from bounded shared trail samples and a host clock reference, so handoff and reconnect do not reset an independent local simulation. Network latency can produce a small difference in visual phase.
- Renderers load local files with Node access disabled, context isolation, sandboxing, a restrictive content policy, and a narrow IPC bridge, following [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security). Edge transfer uses the native [`will-move` event](https://www.electronjs.org/docs/latest/api/browser-window#event-will-move-macos-windows).

See `src/core/` for the shared state and transport, `src/main.cjs` for OS integration, and `src/renderer/` for the interactive surface and separate connection UI.
