# CompuSync design choices

This document describes the active implementation reviewed on October 20, 2026. Start with the [README](../README.md) for installation and [testing](testing.md) for acceptance. The [original v3 proposal](../compusync-spec-v3.md) and [earlier reports](archive/implementation-history.md) preserve historical designs; they do not override current runtime selection.

## Product and platform boundary

- Supported pairs are Mac-to-Mac and Mac-to-Windows. Windows-to-Windows and unsupported operating systems are rejected by the pairing/session checks in `src/shared/devices.js` and `src/core/session.cjs`.
- The active UI is Connection & settings, its Latency Monitor page, the optional Windows Messages Companion, and a temporary Chrome seam overlay.
- The shared scene, workspace, file-transfer UI, offscreen editor, and shared drag bar are retired. Their modules remain in the tree but are not instantiated by `src/main.cjs`. The renderer's Pointer Lock permission handler is not the mechanism for current OS-wide cursor sharing.

## Native shared input and geometry

- Rust exposes input hooks/event taps, input synthesis, cursor visibility and positioning, foreign-window access, display metrics, and recovery through the N-API adapter in `native/index.cjs`.
- Pointer input goes through the native addon, Electron main-process runtime, and paired transport. It does not round-trip through a renderer. Settings render state and diagnostics; they do not own authoritative input timing.
- One computer owns the visible cursor at a time. Either computer's input can contribute while linked; keyboard and scrolling follow ownership. The runtime exchanges the owner computer's pointer-feel curve so it applies consistently while the cursor is on that computer.
- Virtual units normalize desktop metrics and scale for shared topology. OS-global native bounds and per-display physical dimensions remain available for window matching, placement, and recovery. The layout editor shows individual monitors inside computer groups; screen positions within each group come from the OS.
- Mixed pairs support left/right arrangements or Windows below the Mac. Two Macs use left/right arrangements. Both Macs' top/menu-bar edges remain reserved. Legacy `mac` and `windows` slot names are geometry compatibility fields, not device identities; in a Mac pair, the second slot is another Mac.
- Edge resistance applies when crossing without a native drag and is bypassed during a drag. Cmd/Ctrl+Shift+U toggles linking and Cmd/Ctrl+Shift+Y transfers ownership. Native fail-safe handling remains available independently of renderer responsiveness.

## Chrome platform paths

### Windows: extension and native messaging

`src/main/adapters/chrome/runtime.cjs` selects the extension adapter and native messaging bridge on Windows. `setup.cjs` copies the manifest, service worker, and page-state helper into a stable `chrome-extension` directory under CompuSync user data. It writes a native host manifest and registers it under the current user's Chrome NativeMessagingHosts registry key.

Chrome requires the user to enable Developer mode and use Load unpacked for the managed folder. Setup opens that folder and Chrome's Extensions page after explicit consent. CompuSync stages current extension files on startup; users reload the extension after an update. Installing the source folder alone does not install/register the native host.

The fixed manifest public key provides the extension ID expected by the host manifest and Rust executable. The extension connects to `app.compusync.chrome`; `native/chrome-host/` relays length-framed stdio messages to the desktop app's Windows named pipe. Tab operations use Chrome extension APIs, and bounded history/page-state operations use `chrome.debugger` sessions that detach after the operation.

The active path does not restart the user's Chrome into a copied, signed-out profile or require a remote-debugging port. Older CDP/profile utilities and disposable-profile probes remain for historical testing. At startup, the app may offer setup; accepting setup deliberately opens Chrome. A destination handoff may launch Chrome if needed. These explicit actions differ from launching Chrome merely to scan at startup.

### macOS: Automation and Accessibility

The Mac runtime selects the Apple adapter, which uses JXA/Apple Events to inspect and recreate Chrome tabs and native Accessibility APIs to detect and position windows. No Chrome extension is required.

`runMacPermissionPreflight` checks Accessibility, Input Monitoring, and Chrome Automation during startup and requests them during first-run onboarding when the native preflight APIs are available. Denials produce settings notices. Recording and Messages permissions are separate feature-specific approvals, not part of the three input/Chrome checks.

Chrome's optional **Allow JavaScript from Apple Events** setting enables the page-state helper to capture scroll positions and ordinary drafts. Without it, basic tab/URL handoff remains available and a setup notice explains the page-state limitation. The Mac API does not expose the full native back/forward stack, so retained history is reused only while the prepared window remains unchanged.

## Handoff, parked splits, and recovery

- Descriptors contain bounded HTTP(S) tab data, tab order/pinning/active selection, and supported history. The active tab can include bounded page state; password fields, file inputs, cookies, storage, and login sessions are not copied. Each computer uses its own site authentication.
- The native drag and shared cursor drive window placement. Normal addressable Chrome windows can straddle. Releasing with both portions visible parks the two existing windows; neither closes simply because it contains less than half the window. Re-grabbing either portion refreshes the peer copy's supported state. Parked copies are not continuously interactive replicas.
- Moving completely to one computer completes the handoff. Successful source destruction follows reliable commit acknowledgement. Reverse preparation is reused within the bounded retention window. Maximized/fullscreen windows transfer without a live straddle; unsupported or undersized windows stay local.
- Where native monitor measurements are available, handoff uses physical dimensions to preserve size across Retina and Windows scaling, reducing oversized windows to fit the receiving monitor. Logical sizing is the fallback when measurements are unavailable.
- Windows has a foreign-window modal move loop; its native path ends that loop at edge contact, guards synthetic releases, and continues the drag from captured movement. Mac positioning uses Accessibility and event-tap/window notifications rather than that Windows mechanism.
- Main-process recovery, the native watchdog, and an independent recovery guard release synthetic input, restore cursor visibility, and recover guarded windows on failure. Unlink, peer loss, suspend, process exit, and display changes must clear stale handoffs and overlays. Do not claim a hardware recovery result without exercising it on the target computer.

## Pairing, transport, and persistence

- Short-code discovery uses local UDP, normally port 43188, and the direct connection normally uses TCP 43187. Codes last 15 minutes and one successful pairing. No cloud account or relay participates.
- Discovery bootstraps pairing. Saved reconnect retries the saved host address; a changed DHCP address can require a fresh code plus discovery or manual address entry. There is no automatic host migration or remote startup of a stopped app.
- The custom protocol uses scrypt for code bootstrapping, fresh handshake contributions, directional keys, authenticated encryption, and counters. This description is not an independent cryptographic audit or a claim that it implements a standardized PAKE.
- Large reliable payloads use the authenticated data path with separate key context and active-session binding. Peer message schemas, bounds, priorities, and ordering are defined in `src/main/messages.cjs` and the session/wire modules; legacy workspace capabilities are not an active file-sharing product surface.
- Settings live in the OS user-data directory. Saved connection secrets use Electron safeStorage where available, with the restricted local-file fallback in `src/main.cjs`. Renewing an invitation code does not itself revoke a saved connection secret.

## Clipboard, audio, and Messages

Plain-text clipboard synchronization is enabled by default and can be disabled in settings. It sends new copied text while connected, not images/files or an initial offline backlog. Both computers' clipboard histories may retain received text. Structured clipboard logs record byte counts, not clipboard text.

Audio is a separate explicitly started route. Either supported computer can send to both outputs, with full stereo or layout-based split stereo, independent volume controls, and one direction at a time. Audio protocol v3 uses authenticated/encrypted UDP with fresh route keys and a shared presentation timeline; cursor linking is not required. Mac capture uses Core Audio taps on macOS 14.6+ with recording permission. Windows sending uses standard VB-CABLE and a recovery helper that restores prior output roles. Windows receiving does not require the driver. Disconnect, sleep, or failure stops sharing; reconnect does not resume capture. See [audio routing](audio-routing.md) for clocks, routing, and physical measurement limits.

Windows' Messages Companion reads conversations and participant contact names through the paired Mac, which accesses local databases read-only with Full Disk Access. Sending uses Messages Automation. It is a separate feature-specific window, not the retired workspace/editor.

## Lifecycle, diagnostics, and compatibility

- Explicit launch or tray/menu activation opens Connection & settings. Closing settings leaves the process running. A background launch keeps the app hidden until activation unless an error needs settings. A second launch activates the existing instance, so quit older copies before testing updates.
- The Latency Monitor separates mouse-path and audio-schedule diagnostics. Neither reading includes complete device-to-display latency or proves acoustic speaker alignment. Native input and real speaker timing require physical tests.
- Source runs write `compusync.log` and can share logs over the encrypted paired connection into `compusync-peer.log`. Review logs and screenshots before attaching them publicly. Chrome handoff timing logs deliberately omit full URLs, titles, histories, and session tokens; that is not a promise that every diagnostic file contains no private data.
- Source runs update through Git and local rebuilds. Packaged apps use the feed currently configured in `package.json`; signing, feed hosting, and tag-workflow requirements are described in [releases](releases.md). No installer or public-feed availability is implied by configuration alone.
- Session handshake version 2, Chrome descriptor schema 1, extension RPC version 1, and audio protocol version 3 describe different contracts. The product's package version and the extension manifest version are separate again. Use matching current builds on both computers rather than inferring compatibility from any one number.
- Renderer sandboxing, context isolation, navigation/CSP restrictions, and sender-checked IPC remain required. CompuSync does not provide a VM, arbitrary program execution, remote desktop, or migration of application processes.
