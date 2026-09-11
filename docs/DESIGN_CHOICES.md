# CompuSync design choices

This document records the implementation decisions made while carrying out `HANDOFF.md`. It describes the behavior the code is intended to preserve when the implementation is changed later.

## One logical window

- Shared geometry uses integer device-independent pixels (DIPs). Electron screen and window bounds and renderer CSS pixels use the same logical unit at the default zoom. A display's scale factor is retained for diagnostics and canvas backing resolution; it does not multiply shared coordinates.
- The host is the authority for state. It places its selected work area at virtual `(0, 0)` and attaches the peer's selected work area to the configured host edge, centered along the other axis. This creates one deterministic two-display layout even if the two saved edge preferences disagree.
- State contains one logical window rectangle. Each computer derives its native fragment by intersecting that rectangle with its virtual display. A fragment is a crop of the full scene and may be as small as one DIP. Fragment dimensions never resize the logical scene.
- Joining and reconnecting do not add a view or relocate the window. The initial window is centered on the host. `Bring window here` explicitly moves the same logical window to a computer that has no visible fragment.
- The surface is frameless. A 36-DIP bar belongs to the shared logical content, so its fragments line up at the seam and native title bars, shadows, and rounded corners cannot create duplicate chrome.

## Dragging and input

- The shared bar uses DOM pointer events and Pointer Lock. Relative movement continues after the physical cursor reaches an OS display edge. Native title-bar dragging and CSS drag regions cannot provide the cross-computer drag transaction or reliable relative deltas.
- A drag has one authoritative owner and a random transaction ID. The host accepts the first grab, rejects conflicting owners and stale sequence numbers, and applies bounded relative deltas. Mouse release commits; Escape, lost capture, or an interrupted local drag restores the starting rectangle. Disconnect and display changes clear ownership and recover a reachable bar.
- While its last visible pixels disappear, the drag owner's process keeps a tiny transparent capture window focused until release. This is needed to retain Pointer Lock and finish a crossing with the original trackpad. The exact behavior remains a physical macOS acceptance item.
- Interior pointer input is separate from bar input. Cursor positions, clicks, grid distortion, and particles use the full logical content coordinates below the bar. Renderers subtract their viewport offset, allowing both fragments to show complementary parts of the same scene.
- Ordinary OS input remains unchanged outside CompuSync. When no fragment is local, the tray/settings `Bring window here` action is the deliberate remote-control entry point; CompuSync does not install global mouse hooks or leave a duplicate surface behind.

## Mini desktop and host programs

- The computer hosting the CompuSync session also owns the persistent workspace and runs programs. Moving the logical window changes presentation only; it does not migrate storage or processes.
- Renderer and peer requests use named, validated capabilities. They never contain arbitrary host paths, executable paths, shell strings, or unrestricted command-line arguments.
- Imported files live under the host profile's `workspace` directory. Public operations use normalized relative identifiers. Path traversal, reserved internal paths, and symbolic-link escapes are rejected. Writes use temporary files and atomic replacement where the platform permits it.
- Bulk files and rendered program frames use a separate authenticated data channel so cursor, drag, lifecycle, and metadata state cannot queue behind large payloads. Transfers are chunked, bounded, acknowledged, and hash-checked. Program frames may be dropped under backpressure because a newer frame supersedes them.
- The first supported program is a bundled host text editor in a separate sandboxed, offscreen Electron window. This is a real host-run process surface that CompuSync can capture and control consistently on Windows and macOS without global Accessibility or Screen Recording privileges. The supported catalog is explicit; arbitrary native Windows and macOS applications are outside this first compatibility boundary.
- The workspace persists across app restarts. Program process state is transient; saved document bytes are durable. A lost peer does not stop a host program, and a lost host ends the peer's ability to operate it until reconnection.

## Security and limits

- Existing sandboxed renderers, context isolation, disabled Node integration, local-only CSP, navigation blocking, authenticated encryption, counters, origin rejection, and sender-checked IPC remain required.
- Control and data connections use distinct key-derivation contexts. A data connection is accepted only for the member that already owns the active authenticated control connection and is terminated with it.
- The initial implementation favors bounded behavior: one peer, one selected display per member, a finite workspace quota, bounded file count/depth/file size, and one supported editor catalog entry. These limits can be raised deliberately without expanding authority to the host filesystem or shell.

## Recovery and compatibility

- A window must retain a reachable portion of its bar on at least one connected display after drag completion. If its only display disappears, the unchanged-size logical window is centered on a remaining display.
- Protocol/state version 2 deliberately rejects version 1 peers. Mixing the old mirrored-window semantics with the new crop and drag actions would produce unsafe or contradictory behavior.
- Windows automation and local two-process tests can validate reducer ordering, complementary crops, transport, persistence, and Electron behavior. Physical Windows-to-macOS dragging, Retina/mixed-DPI seams, macOS Pointer Lock retention, native packaging/signing, firewall behavior, and sleep/wake remain explicit device acceptance work.
