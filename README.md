# CompuSync

CompuSync links a Windows 11 laptop and a Mac into one cursor space and teleports supported native Chrome windows across their configured seam. During a Chrome crossing, each machine positions a real local Chrome window from the same virtual coordinates, producing a temporary aligned straddle without streaming the browser.

The existing shared surface remains available with its interactive grid, persistent host-owned workspace, and bundled text editor. Files can be imported from either laptop.

## Run on both laptops

CompuSync must run on both computers on the same local network. To run from source, install Node.js 22.12 or newer, the stable Rust toolchain, and the platform compiler tools (Xcode Command Line Tools on macOS or Visual Studio Build Tools with the C++ workload on Windows). Copy or clone this repository onto each computer, then install and build separately on each operating system:

```sh
npm ci
npm run native:build
npm run native:smoke
npm start
```

Do not copy `node_modules` between Windows and macOS. A packaged Windows `.exe` runs only on Windows; build the macOS app on a Mac with `npm run dist:mac`. See the [Mac setup guide](docs/mac-setup.md).

## Pair the computers

1. On the computer that should own the workspace and run programs, choose **Share from here**. It displays an eight-character code such as **AB7K-3M9Q**.
2. On the other computer, choose **Join other laptop**, enter the code, and select **Connect laptops**. Lowercase and an omitted dash are accepted.
3. On the host, set **Where is the other laptop?** to match the physical layout. If the Mac is to the right of the Windows host, choose **To my right** on the host. The host's choice defines the shared seam.
4. Select **Open shared window**. A newly opened surface is centered on the host. It does not open a full duplicate on the peer.

Pairing uses local UDP discovery and an encrypted direct WebSocket connection. There is no cloud account or external server. If discovery is blocked, expand **Connection help** and enter the host's address and port manually. Discovery uses UDP port 43188; the connection normally uses TCP port 43187.

The host owns the authoritative session. It must remain running for the peer to control the surface, browse the workspace, or operate a program. A saved pairing reconnects automatically when its previous host address is reachable.

## Move and control the shared window

When linked, either laptop's mouse or trackpad moves one OS cursor. Cursor ownership crosses the configured left, right, or bottom seam; keyboard input follows the owner. The settings panel controls shared acceleration, edge resistance, layout offset, and linked mode. Ctrl/Cmd+Shift+U immediately unlinks and restores local input; Ctrl/Cmd+Shift+Y moves cursor ownership to the other laptop.

Drag a normal, non-fullscreen Chrome window toward the shared edge to hand it off. CompuSync pre-warms a real offscreen Chrome window on the destination, preserves its tabs, order, pinning, active tab, geometry, and bounded history, and shows both native halves while the pointer crosses. Reversing keeps the prepared copy alive for three seconds; releasing before halfway keeps the source, while releasing after halfway commits the destination. Unsupported windows stay local and show one brief hint.

On macOS, the first Chrome crossing requests Automation permission. On Windows, a normally launched Chrome cannot expose background tabs to CDP; the first crossing offers a one-time restart into CompuSync's isolated, signed-out browser profile. Declining is remembered and Chrome remains non-crossing. CompuSync never launches Chrome at startup.

The frameless window has a 36-DIP shared bar at its top. Grab this bar to move the logical window. CompuSync captures relative pointer movement for the drag, so the same trackpad can continue moving after the physical OS cursor reaches a display edge.

| Action | Result |
| --- | --- |
| Drag the shared top bar | Moves the one logical window. At the seam, the two computers show complementary crops. |
| Release the primary button | Commits the drag at its current position. |
| Press Escape during a bar drag | Cancels the drag and restores its starting position. |
| Choose **Bring window here** | Moves the window to this computer when it has no local fragment. |
| Move within the desktop | Moves the shared application cursor and distorts the grid. |
| Click within the desktop | Captures relative interior movement. Press Escape to restore the OS pointer. |
| Close / Ctrl or Cmd+W | Closes the one shared surface on both computers while leaving the tray or menu process running. |
| Open / Ctrl or Cmd+Shift+O | Reopens the shared surface. |
| Bring here / Ctrl or Cmd+Shift+Enter | Places the shared surface on the computer where the command is invoked. |
| Ctrl+, on Windows / Cmd+, on Mac | Opens connection and placement settings. |

Either computer can start a bar drag from a visible fragment. If the source crop disappears while the button is held, CompuSync retains pointer capture in a tiny transparent local window until release. This behavior has automated Windows coverage; physical macOS and Retina validation remains in the [two-laptop checklist](docs/testing.md).

In Unlinked mode, CompuSync removes its global input hooks, releases any cursor parking and synthetic input, and leaves both computers fully local. A heartbeat watchdog performs the same recovery after transport loss, suspend, addon failure, or process exit.

## Use the workspace and text editor

The desktop panel is the persistent workspace stored on the session host.

- Choose **Import** to select local files, or drop local files into the desktop. Imports made on the peer are transferred to the host.
- Dropped directories are imported recursively. Symbolic links and unsupported filesystem entry types are rejected.
- Use **New Folder**, **Rename**, and **Delete** to organize the workspace. Deleting a directory removes its contents after confirmation.
- Double-click a directory to browse it. Double-click a file to open it in the bundled text editor. The editor accepts valid UTF-8 text documents up to 2 MiB.
- Click the rendered editor to focus it, then use the mouse, keyboard, and wheel normally. Use the editor's **Save** button or Ctrl/Cmd+S to write the document to the host workspace.
- Moving the logical window between computers does not restart the editor. Its process and files remain on the host while its current JPEG frames are shown on whichever crop contains it.

The workspace survives application restarts. Running editor processes are session state and stop when the host session or app stops; saved file contents remain. Import name collisions receive a numbered name such as `notes (1).txt` rather than overwriting an existing entry.

Default workspace limits are 32 path segments, 10,000 files and directories, 256 MiB per file, 1 GiB total stored file data, four concurrent incoming transfers, and 128 KiB transfer chunks. The text editor limit is 2 MiB. Public workspace operations use portable relative paths and never expose the host's absolute workspace path.

## Supported program scope

The bundled **Text Editor** is the only supported host program in this release. It runs in a separate sandboxed, offscreen Electron window at 800x500 and publishes JPEG frames at up to 15 frames per second. CompuSync validates and forwards a small set of mouse, wheel, and keyboard events to that program.

Arbitrary native Windows or macOS applications, dragged executable bundles, audio/video streaming, cross-operating-system execution, and virtual-machine isolation are unsupported. The shared surface visually contains the bundled editor, but that does not constitute a VM or an operating-system process sandbox. Renderer sandboxing limits the Electron renderer; it is not a general isolation boundary for future native programs.

## Persistence, recovery, and boundaries

The workspace is stored beneath CompuSync's OS user-data directory, normally `%APPDATA%\CompuSync\workspace` on Windows or `~/Library/Application Support/CompuSync/workspace` on macOS. Pairing configuration is stored alongside the app profile. Pairing secrets use Electron safe storage where available, with a restricted local-file fallback.

Workspace APIs reject absolute paths, traversal, backslashes, reserved Windows device names, the internal `.compusync` directory, and symbolic-link escapes. Text saves use a temporary file and replacement. Peer imports are transferred in order, acknowledged, SHA-256 checked, and cleaned up if the peer disconnects.

Control traffic and bulk data use separate authenticated channels and separate derived keys, keeping pointer and window actions from queuing behind file or frame payloads. Each data channel is bound to the already authenticated active peer. Requests use a fixed capability catalog; peers and renderers cannot submit host paths, executable paths, shell text, or unrestricted command-line arguments.

Wi-Fi interruption triggers reconnect. Input is not queued while offline. The host continues locally, and its running editor remains available after a peer-only disconnect. There is no automatic host migration. If the host exits, the peer cannot operate the workspace or editor until that host returns.

## Build packages

```sh
# Windows portable executable in dist/
npm run dist:win

# macOS DMG and ZIP for the current architecture; run on a Mac
npm run dist:mac

# Explicit Mac architectures
npm run dist:mac -- --arm64
npm run dist:mac -- --x64

# Unpacked app for the current platform
npm run build
```

Development packages are unsigned. Build and sign macOS releases on a Mac. The GitHub Actions workflow runs syntax, unit/integration, and Electron end-to-end checks on Windows and macOS; manually dispatched runs can also produce unsigned artifacts.

## Develop and verify

```sh
npm run check       # JavaScript syntax checks
npm test            # State, geometry, workspace, program, encryption, and network tests
npm run test:native # Rust addon and native adapter tests
npm run native:smoke # Load and exercise the release addon
npm run test:e2e    # Real Electron windows and local paired-process behavior
npm run demo        # Two isolated profiles paired over loopback
```

The end-to-end suite covers one-window crops and cross-seam drag transactions, Pointer Lock cancellation, lifecycle and pairing, plus the host workspace/editor vertical slice. Automated local processes cannot establish actual Windows-to-Mac behavior, Retina alignment, macOS Pointer Lock retention, firewall behavior, sleep/wake, or signed-package behavior. Run the [physical acceptance checklist](docs/testing.md) before treating those paths as released.

## Implementation map

- `src/core/state.cjs` owns the version-2 logical window, drag, cursor, and lifecycle state.
- `src/core/geometry.cjs` creates the virtual two-display topology and derives per-computer crop rectangles.
- `src/core/session.cjs` and `src/core/wire.cjs` manage pairing and the authenticated control and bulk-data channels.
- `src/core/workspace.cjs`, `src/core/capabilities.cjs`, and `src/core/transfer.cjs` implement bounded storage and transfer authority.
- `src/desktop-service.cjs` coordinates local or remote desktop requests with the host-owned services.
- `src/programs/` contains the bundled host text editor and its offscreen program manager.
- `src/main.cjs` integrates Electron windows, display topology, tray/menu controls, the workspace picker, and program services.
- `src/main/cursor.cjs`, `runtime.cjs`, `drag.cjs`, and `window-runtime.cjs` own v3 cursor and native Chrome handoff state.
- `src/main/adapters/chrome/` implements Chrome detection, CDP, Apple Automation, capture, preparation, and commit.
- `native/` contains the napi-rs cursor/window substrate and independent crash-recovery guard.
- `src/renderer/` renders the cropped shared world, desktop browser, streamed program interface, and settings.

Implementation rationale and compatibility boundaries are recorded in [docs/DESIGN_CHOICES.md](docs/DESIGN_CHOICES.md). Current validation evidence and remaining work are in [docs/IMPLEMENTATION_REPORT.md](docs/IMPLEMENTATION_REPORT.md).
