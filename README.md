# CompuSync

CompuSync links a Windows 11 laptop and a Mac into one native cursor space. The cursor crosses the configured screen seam, keyboard input follows cursor ownership, and supported Google Chrome windows can be handed from one computer to the other.

The old shared surface, sandbox/workspace, and bundled editor are retired. CompuSync never creates or opens that window. The only persistent application UI is **Connection & settings**; a temporary transparent seam overlay may appear while Chrome is crossing.

## Run on both laptops

CompuSync must run on both computers on the same local network. A source build requires Node.js 22.12 or newer, the stable Rust toolchain, and platform compiler tools: Xcode Command Line Tools on macOS or Visual Studio Build Tools with the C++ workload on Windows.

For normal use, download the current installer from [CompuSync Releases](https://github.com/thegregoriancalendar/compusync-releases/releases/latest):

- Windows: run `CompuSync-Setup-<version>-x64.exe`.
- macOS: open the `.dmg` matching the Mac architecture and drag CompuSync to Applications.

Installed builds check GitHub for stable updates in the background. An available update downloads automatically and installs after CompuSync is quit and reopened.

Install and build independently on each computer:

```sh
npm ci
npm run native:build
npm run native:smoke
npm start
```

Do not copy `node_modules` or native build output between operating systems. The build creates the platform addon used for global input, cursor recovery, native window discovery, and Chrome handoff. See the [Mac setup guide](docs/mac-setup.md) for macOS prerequisites and permissions.

## Pair the computers

1. Open **Connection & settings** on both computers. Use **Share from here** on one computer and copy its eight-character code.
2. On the other computer, choose **Join other laptop**, enter the code, and select **Connect laptops**. Lowercase and an omitted dash are accepted.
3. Wait until each computer reports **Connected**. A saved pairing can appear in settings before its live connection has returned; cursor linking is available only after both apps reconnect.
4. Under **Screen layout**, describe the physical arrangement. Choose which laptop is left or right, or place the other laptop below, and adjust the alignment offset if needed.
5. Select **Link cursors**.

Pairing uses local UDP discovery and an encrypted direct WebSocket connection. There is no cloud account or relay. Discovery uses UDP port 43188 and the connection normally uses TCP port 43187. If discovery is blocked, expand **Connection help** and enter the displayed host address manually.

One computer starts the saved session as the host and the other rejoins it. Both applications must remain running. Opening CompuSync from the tray or menu bar shows settings; it does not open the retired shared surface.

## Use the shared cursor

When linked, either laptop's mouse or trackpad contributes movement to one cursor. Cursor ownership crosses the configured left, right, or bottom seam, and keyboard input follows the owner. The top edge is not a crossing edge on macOS.

The settings panel controls common acceleration, edge resistance, alignment offset, and linked mode. Edge resistance requires an extra push at the seam when no native window is being dragged.

| Action | Result |
| --- | --- |
| Move through the configured seam | Transfers cursor and keyboard ownership to the other laptop. |
| **Move cursor to other laptop** | Transfers ownership without crossing the seam. |
| Ctrl/Cmd+Shift+Y | Transfers ownership to the other laptop. |
| Ctrl/Cmd+Shift+U | Toggles cursor linking and immediately restores local input when unlinking. |
| Ctrl+, on Windows / Cmd+, on Mac | Opens **Connection & settings**. |

Unlinking removes global input hooks, releases synthetic buttons and modifiers, restores cursor visibility, and leaves both computers fully local. The native recovery path does the same after transport loss, suspend, addon failure, or process exit.

## Hand off Chrome windows

Drag a supported Chrome window through the linked seam. CompuSync prepares a real native Chrome window on the destination, preserves tab order, pinning, active tab, geometry, and the history state available on that platform, and aligns the two native windows while they straddle the seam. Releasing before halfway keeps the source; releasing after halfway commits the destination. Reversing briefly reuses the prepared copy.

Normal addressable Chrome windows support live straddling. Maximized or fullscreen windows transfer without a live straddle. Unsupported applications and very small windows stay local while the cursor crosses and produce a brief notice.

On macOS, the first Chrome crossing requests Automation permission. Accessibility is required for native window detection and placement, and Input Monitoring is required for shared input. On Windows, the first eligible crossing may offer to restart Chrome into CompuSync's isolated, signed-out profile because current Chrome releases do not expose the required tab state from the default profile. Declining is remembered. CompuSync never launches Chrome merely because CompuSync starts.

Chrome's public macOS automation API does not expose its complete back/forward stack. CompuSync retains bounded history metadata while a prepared window remains unchanged, but navigation or tab rearrangement on the Mac invalidates stale retained history.

## Recovery and privacy boundaries

Pairing settings are stored in CompuSync's OS user-data directory. Pairing secrets use Electron safe storage where available, with a restricted local-file fallback.

Control messages are authenticated and encrypted. Cursor input is not queued while disconnected. A watchdog and independent recovery guard restore local input and guarded windows if the peer, network, or app disappears. Chrome handoff logs may contain a descriptor ID, phase, duration, hostname, and tab count, but not full URLs, titles, history URLs, or session tokens.

CompuSync is not remote desktop, a virtual machine, file synchronization, or application streaming. The retired workspace and editor code is outside the active v3 product surface and is never instantiated by the app.

## Build packages

```sh
# Windows NSIS installer in dist/
npm run dist:win

# macOS DMG and ZIP for the current architecture; run on a Mac
npm run dist:mac

# Explicit Mac architectures
npm run dist:mac -- --arm64
npm run dist:mac -- --x64

# Unpacked app for the current platform
npm run build
```

Local development packages are unsigned. Production macOS releases must be signed and notarized for installation and automatic updates; production Windows releases should be signed to avoid SmartScreen warnings. See [the release guide](docs/releases.md).

## Develop and verify

```sh
npm run check        # JavaScript syntax checks
npm test             # Cursor, topology, handoff, recovery, and transport tests
npm run test:native  # Rust addon, recovery guard, and native adapter tests
npm run native:smoke # Load and exercise the release addon
npm run test:e2e     # Real Electron pairing and lifecycle behavior
```

Automated tests cannot establish actual Windows-to-Mac input, Retina/mixed-scale alignment, operating-system permission prompts, firewall behavior, sleep/wake behavior, or signed-package behavior. Complete the [physical acceptance checklist](docs/testing.md) on the intended computers.

## Implementation map

- `src/core/session.cjs` and `src/core/wire.cjs` manage pairing and the authenticated connection.
- `src/main/cursor.cjs` and `src/main/runtime.cjs` own v3 cursor topology, ownership, input routing, and recovery.
- `src/main/drag.cjs` and `src/main/window-runtime.cjs` coordinate native-window crossing and handoff transactions.
- `src/main/adapters/chrome/` implements Chrome detection, CDP, Apple Automation, preparation, and commit.
- `src/main/seam-overlay.cjs` presents the temporary noninteractive Chrome seam treatment.
- `native/` contains the napi-rs Windows/macOS substrate and independent crash-recovery guard.
- `src/main.cjs` integrates the settings window, tray/menu controls, native runtime, display changes, and app lifecycle. It deliberately does not create the retired shared-surface `BrowserWindow`.

Implementation rationale and compatibility boundaries are recorded in [docs/DESIGN_CHOICES.md](docs/DESIGN_CHOICES.md). Current validation evidence is in [docs/IMPLEMENTATION_REPORT.md](docs/IMPLEMENTATION_REPORT.md).
