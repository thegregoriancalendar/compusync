# CompuSync implementation report

## Version 3 completion

The implementation described by `compusync-spec-v3.md` is present through M0-M3. CompuSync now has a native Windows/macOS shared-cursor substrate, authenticated ownership and input routing, Chrome-only native window handoff, live straddling, race recovery, multi-monitor normalization, sleep/display recovery, native fail-safe hotkeys, edge resistance, permission remediation, bounded history handling, seam treatment, and URL-safe structured timing records.

The three non-negotiable invariants are enforced independently: cursor deltas stay on the native/main-process path, a source Chrome window is not destroyed before reliable commit acknowledgement, and local recovery does not depend on the renderer, peer, or network. A redundant out-of-process recovery journal covers hard daemon termination while a window or synthetic input is guarded.

### Platform paths

- Windows uses explicit one-time consent to restart Chrome into a user-private, signed-out isolated profile with loopback-only CDP. A bundled fixed-ID MV3 bridge preserves exact tab order, pin state, and active state by opaque target ID, including duplicate URLs. It is loaded only into that isolated CDP session.
- macOS controls normally launched Chrome through Apple Events and Accessibility. Chrome's public Apple Events dictionary does not expose the full navigation-entry collection; received bounded histories are therefore retained conservatively across unchanged prepared-window round trips and invalidated after navigation or reordering.
- Normal, addressable Chrome windows can straddle. Maximized/fullscreen windows use instant transfer; undersized and unsupported windows remain local while the cursor crosses.

### V3 verification

- `npm run check`: passed for 75 JavaScript files.
- `npm test`: 178/178 tests passed, including the required network-loss, Chrome-force-quit, daemon/panic, suspend/wake recovery matrix, join-side layout identity, and orderly restart recovery.
- `npm run test:native`: 9 Rust addon tests, 1 recovery-guard test, and 3 Node adapter tests passed.
- `npm run test:e2e`: 3/3 real-Electron pairing and startup/profile scenarios passed. The retired v1 shared-surface and workspace UI suites are no longer part of the active E2E contract.
- `npm run build`: rebuilt the Windows x64 native addon and recovery guard, loaded both under Node and Electron, and produced `dist/win-unpacked`. The packaged fixed-ID Chrome bridge was verified under `app.asar.unpacked`.
- A disposable-profile probe against installed Chrome 152 verified loopback CDP extension loading, worker activation, exact CDP target-to-tab identity, tab query/update/move, and fully offscreen window positioning without an extra tab or warning surface.
- The Windows crash-recovery probe and native move-loop guard exercise hard termination and the tagged synthetic-button-up path. macOS uses AX moved/resized notifications rather than a polling loop.

Physical two-computer acceptance remains an environment check: repeat the v3 section in `docs/testing.md` on the intended Windows and Mac hardware to validate real mixed-DPI seam alignment, held hardware input, macOS TCC prompts, and sleep/wake behavior. These paths have automated failure coverage and platform implementations; a one-machine Windows development session cannot prove their physical interaction.

### V3 checkpoint commits

The v3 work was committed and pushed incrementally. Major boundaries are `dac2515` (cursor core), `cd9d007` (native substrate), `cef40b4` and `456c40a` (Windows CDP and macOS Chrome), `ae51df1` (straddle/races), `78e55c9` (native move/crash recovery), `33e5c63` (mandatory failure matrix), `ddac2d7` (Mac history retention), and `b47ce71` (production Windows tab-state bridge).

---

## Earlier HANDOFF implementation

## Status

All implementation work requested by `docs/HANDOFF.md` is present in the repository in the required order. Goals 1 and 3 replaced the old mirrored handoff with one cropped logical window and a shared drag bar. After that gate passed, Goal 2 added the host-owned workspace and the first explicit host-program compatibility slice: the bundled text editor.

The implementation is ready for physical Windows 11 and Mac acceptance. No physical Mac was available during development, so the cross-computer seam, Retina, macOS Pointer Lock, sleep/wake, and intended-device package launch checks remain open. These are validation items rather than missing implementation. Hosted runners successfully built the Windows x64 portable executable and macOS arm64 DMG and ZIP from the final source.

## Completed work

### One logical window

- Replaced independently visible views, per-view sizing, and discrete handoff state with protocol/state version 2 and one authoritative logical window rectangle.
- Built a host-anchored virtual topology from both computers' selected work areas. Each process derives its native fragment by intersecting its display with the shared rectangle.
- Rendered each fragment as a translated crop of one full-size world. Grid, particles, shared cursor, clicks, workspace, editor, and bar use full-content coordinates instead of resizing to each fragment.
- Centered a newly opened surface on the host with no full peer duplicate. Added **Bring window here** for deliberate placement when a computer has no visible fragment.
- Unified close, open, reconnect, topology-change, and lost-display recovery around the single surface.

### Shared top bar and continuous drag

- Replaced native title-bar movement with a frameless 36-DIP shared bar and DOM Pointer Lock.
- Added an authoritative drag transaction with one owner, random ID, ordered sequence numbers, bounded deltas, and a lease. Conflicting or stale actions are rejected.
- Preserved continuous movement after the OS cursor reaches the display edge. A 1x1 transparent native capture keeper retains the original renderer's Pointer Lock when its visible crop disappears.
- Made release commit the current rectangle and Escape, lost capture, disconnect, or topology interruption cancel to a reachable starting rectangle.
- Kept interior pointer capture independent from bar dragging and left ordinary OS input unchanged outside CompuSync.

### Host workspace and imports

- Added a persistent workspace beneath the host's CompuSync profile with listing, breadcrumbs, directories, recursive import, rename, and recursive delete after confirmation.
- Added local file-picker and drag/drop imports on both computers. Peer files and directory trees are copied to the host; the peer does not create a second workspace.
- Added case-insensitive collision handling with numbered names instead of overwrite.
- Enforced portable relative paths and rejected absolute paths, traversal, backslashes, reserved device names, `.compusync`, symbolic links, and unsupported entry types.
- Enforced default limits of 32 path segments, 10,000 entries, 256 MiB per file, 1 GiB total file data, and 2 MiB for editable UTF-8 text.
- Added ordered, acknowledged 128-KiB chunks, SHA-256 verification, transfer ownership, at most four concurrent transfers, and partial cleanup on error, disconnect, and startup.

### Authenticated bulk data channel

- Added a separate encrypted data WebSocket on the session port so files and JPEG frames do not queue behind cursor, drag, lifecycle, and metadata traffic.
- Derived control and data keys with distinct contexts. Bound a fresh data token to the already authenticated active peer and terminated its data connection with the control session.
- Added explicit size and backpressure bounds. Program frames are complete images and may be dropped when backpressured; the next frame restores the current presentation.
- Added bounded desktop request/response envelopes and a fixed capability catalog. No capability accepts host paths, executable paths, shell commands, or unrestricted arguments.

### Bundled host text editor

- Added one supported program catalog entry, **Text Editor**, running in a separate sandboxed offscreen Electron window on the session host.
- Captured its 800x500 interface as JPEG at up to 15 FPS and displayed those frames inside the shared logical surface.
- Mapped validated pointer, wheel, modifier, character, and key events from either computer back into host program coordinates.
- Opened only valid UTF-8 documents within the workspace, up to 2 MiB, and saved through bounded atomic workspace replacement.
- Kept the editor instance alive while the logical window moves between displays and across a peer-only disconnect. Running programs remain transient when the host app or service stops; saved documents remain durable.

## Compatibility and security boundary

The bundled text editor is the complete initial program compatibility target. Arbitrary native Windows and macOS applications, executables or application bundles, cross-operating-system execution, native window capture/reparenting, audio/video streaming, and general remote-desktop behavior are unsupported.

The editor renderer is sandboxed, context-isolated, navigation-blocked, and has Node integration disabled. Workspace and network requests pass through sender checks and named validation capabilities. These controls protect the implemented Electron surface. They do not create a virtual machine, container, or operating-system process sandbox for arbitrary programs.

## Checkpoint commits

The following implementation checkpoints were committed and pushed in order:

| Commit | Checkpoint |
| --- | --- |
| `b923c2f` | Replace mirrored views with logical window geometry |
| `31e1fbf` | Add continuous cross-computer window dragging |
| `dafaeac` | Add authenticated bulk data channel |
| `87514a1` | Add sandboxed host text editor runtime |
| `e78ce88` | Add bounded shared workspace and file transfers |
| `dd16bc1` | Orchestrate host desktop services |
| `f4cc080` | Integrate the shared workspace and host editor |
| `efbbf52` | Harden cross-platform editor input |
| `d3c0f88` | Stabilize hosted macOS drag coverage without claiming physical Pointer Lock |
| `431c11c` | Document and package the 0.2.0 implementation |
| `f47b621` | Make release packaging artifact-only and tolerate cold CI starts |

## Automated verification

The latest local and hosted verification completed during implementation includes:

- `npm run check`: passed for 34 JavaScript files.
- `npm test`: 60/60 tests passed. Coverage includes state/version behavior, topology and crop geometry, drag ownership and recovery, wire encryption, data-channel isolation and binding, pairing/discovery, real WebSocket sessions, workspace paths/quotas/persistence, transfers, capability validation, the program manager, and desktop orchestration.
- `npm run test:e2e`: 5/5 scenarios passed together on Windows in 17.3 seconds. These launch real Electron processes and cover one logical surface, complementary crops, drag from either fragment, Pointer Lock and Escape, interior input, close/open/bring-here lifecycle, pairing, saved profiles, startup activation, host import and folder operations, a real JPEG frame, forwarded edit/save input, metadata synchronization, movement without program restart, peer import stored only under the host profile, a fresh peer frame, peer save, program close, and workspace delete. The workspace test stubs Electron's native file chooser deterministically; real Windows/macOS dialogs remain a physical check.
- GitHub Actions run `34597095488` passed `npm ci`, syntax, all 60 unit tests, and all five Electron scenarios on both `windows-latest` and `macos-latest`. Hosted macOS verified Cmd+A replacement, Cmd+S persistence, peer import, frames, geometry, and authoritative drag actions. The runner rejects automated Pointer Lock, so that one assertion remains Windows-automated and physical-Mac work.
- Final push run `34598020894` repeated syntax, all 60 unit tests, and all five Electron scenarios successfully on both platforms at commit `f47b621`.
- Package run `34598028012` passed the same checks on both platforms, then built and uploaded `CompuSync 0.2.0.exe` for Windows x64 and `CompuSync-0.2.0-arm64.dmg` plus `CompuSync-0.2.0-arm64-mac.zip` for Apple silicon. The retained workflow artifacts are `compusync-windows-latest` (100,048,779-byte archive, SHA-256 `b7639abe8a4f1fe190cdb930e287bbeb22e8f2c7faba7750c53eb647a638ff54`) and `compusync-macos-latest` (254,344,052-byte archive, SHA-256 `58ceefcc455f3e3991c15813cfe682581e3f826f190e45ba27a2f8e7a2b4ee76`). Packaging is explicitly artifact-only and cannot attempt an implicit GitHub release upload.
- `npm run dist:win`: passed for the final package version 0.2.0. It produced `dist/CompuSync 0.2.0.exe` at 100,042,519 bytes. The packaged `app.asar` contains the core, workspace, program, and renderer assets; `main.cjs`, the desktop service, desktop renderer, program manager, and editor matched the final working source byte for byte.

The geometry/state and renderer assertions use exact shared crop coordinates. Windows may round native outer bounds by one or two DIPs at fractional display scaling; tests allow that native-window tolerance while keeping logical and rendered crops exact.

## Physical testing that remains

No physical Mac test was possible in this session. Complete `docs/testing.md` with each operating system acting as host. The release-critical remaining checks are:

- a slow top-bar crossing in both directions, including stop, reverse, release, and Escape at the seam;
- Pointer Lock retention after the source crop disappears into the 1x1 capture keeper on macOS;
- complementary crop and full-world coordinate alignment between a scaled Windows display and Retina macOS;
- drag pickup from either visible bar fragment and **Bring window here** when no fragment is local;
- imports from both physical computers, including nested directories, collision names, interrupted transfers, and exact host bytes;
- peer operation and save of the host editor while the surface is moved across the seam;
- real firewall/discovery behavior, weak Wi-Fi, reconnect, host loss, sleep/wake, and display changes;
- launch and Gatekeeper behavior of the hosted unsigned Apple-silicon DMG/ZIP on the intended Mac, menu-bar controls, start at sign-in, any required Intel build, and eventual signing/notarization requirements;
- Windows portable artifact launch and a paired packaged-app smoke test.

## Items to watch during continued development

- Host identity controls storage and execution. Changing which computer hosts changes which profile owns the workspace; there is no host migration or workspace replication.
- Protocol version 2 intentionally rejects older mirrored-view peers. Both computers must run the updated build.
- Saved pairing reconnects to the recorded host address. A changed DHCP address may require discovery/pairing again or manual address entry.
- Complete JPEG frames favor a dependable first vertical slice over video efficiency. Weak networks can reduce apparent editor frame rate, and backpressure deliberately drops stale frames.
- Workspace files persist; editor processes and unsaved editor state do not survive a host app restart.
- Directory delete is recursive. Collision imports are renamed rather than merged over existing files.
- Only valid UTF-8 text up to 2 MiB opens in the editor. Other file types may be stored but have no supported program interface in this release.
- Renderer sandboxing must not be described as VM isolation. Any future native-program support needs a new execution, capture, permission, and containment design before capability expansion.
- The current Windows development package uses Electron's default icon and is unsigned. Add product artwork and signing configuration before public distribution.
- GitHub Actions currently warns that the `v4` checkout/setup/upload actions target a deprecated Node.js 20 action runtime and are being forced onto Node.js 24. Update those actions when their maintained major releases are available.
