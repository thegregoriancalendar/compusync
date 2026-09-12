# Windows and Mac acceptance checklist

Local Windows and hosted macOS automation cover state ordering, crop geometry, transport, workspace operations, the host text editor, and real Electron processes. They cannot prove a continuous physical Windows-to-Mac drag, Retina alignment, macOS Pointer Lock retention, firewall behavior, sleep/wake recovery, or packaged behavior on the intended Mac. Complete this checklist on the intended computers before release.

## Version 3 native cursor and Chrome gate

Run these checks before the earlier logical-surface checks below. Use an ordinary Chrome window with seven tabs, including two pinned tabs, duplicate URLs, and one playing video. Add two tabs after the first transfer and round-trip it again.

1. Link the native cursor and cross every configured left/right/bottom seam slowly and quickly using each laptop's mouse or trackpad. Verify either device contributes motion, the owner remains authoritative, and the cursor never waits for the peer. Confirm top-edge crossing remains disabled on macOS.
2. Cross while holding each mouse button and representative Ctrl/Alt/Shift/Meta combinations. Verify the destination sees the held state, typing follows cursor ownership, and no input remains stuck after return. Exercise Ctrl/Cmd+Shift+Y and the Ctrl/Cmd+Shift+U fail-safe while Electron's renderer is busy.
3. Set edge resistance to zero and a nonzero value. Verify the configured push distance applies only without a drag and disappears during a native window drag.
4. On Windows, decline the first Chrome restart offer and confirm Chrome stays local with no repeated modal. Accept on a fresh profile, confirm the isolated Chrome is signed out, and verify only its current session is restored. CompuSync must not start Chrome merely because CompuSync starts.
5. Transfer the seven-tab window in both directions. Verify tab order, both pinned tabs, active tab, geometry, and current pages. After adding two tabs, round-trip again. Duplicate URLs must retain distinct positions. On Mac, grant Automation only when the first Chrome crossing requests it.
6. Pause with roughly 25%, 50%, and 75% of Chrome across the seam. Frame edges must share the same VU origin while native Chrome interiors may differ. Stop, reverse before drop, cross again within three seconds, then wait beyond three seconds and verify no prepared residue remains.
7. Confirm an unsupported or sub-200x150-VU window clamps locally while the cursor crosses and shows only the first nonblocking hint. Confirm maximized/fullscreen Chrome transfers without a live straddle.
8. During a straddle, separately pull the network, force-quit source Chrome, force-quit destination Chrome, suspend each computer, disconnect a display, and hard-kill each CompuSync process. In every case a surviving Chrome copy must return fully on-screen, overlays and hooks must clear, held synthetic input must release, cursors must reappear within two seconds, and CompuSync must enter Unlinked mode.
9. Repeat across multi-monitor desktops with negative/above-primary origins and mixed scale factors. Hotplug each display and verify the normalized desktop refreshes without overlap or a stranded window.
10. On macOS, deny Accessibility, Input Monitoring, and Automation once each. Confirm every denial remains visible with the appropriate System Settings remediation path and no silent capture. On Windows, verify the elevated-window notice is nonblocking and shown once.

Record default structured handoff logs for a success, reversal, and failure. They may contain descriptor ID, phase/duration, hostname, and tab count, but no full URL, title, history URL, or session token.

## Automated gate

Run from a clean checkout with Node.js 22.12 or newer:

```sh
npm ci
npm run check
npm test
npm run test:native
npm run test:e2e
npm run build
npm run dist:win
# Run this on macOS:
npm run dist:mac
```

Use an interactive desktop for the Electron end-to-end suite. Record the command, OS, architecture, commit, result, and any retained Playwright trace. Do not interpret a passing two-process test on one machine as cross-platform acceptance.

## Test record

Before beginning, record:

- commit and app version;
- Windows version, display resolution, scale percentage, and processor architecture;
- macOS version, Mac model, Intel or Apple Silicon architecture, display resolution, and Retina scaling mode;
- physical laptop arrangement and which computer hosts;
- network type, firewall prompts, and whether automatic discovery works;
- package type used on each computer: source, Windows portable executable, macOS ZIP, or DMG.

Use fresh test profiles first, then repeat persistence checks with those profiles. Keep both laptops awake and place their display edges in the same arrangement selected on the host.

## Pairing and topology

1. Start CompuSync on Windows and macOS. Host on Windows, enter its eight-character code on the Mac, and verify automatic discovery reaches **Connected**. Repeat code entry in lowercase without a dash.
2. If the network blocks discovery, use the host address and TCP port shown under **Connection help**. Confirm that the direct connection succeeds without changing machine-wide firewall or security settings.
3. On the Windows host, choose the physical direction of the Mac. Confirm this one host choice defines the seam; changing the joiner's saved direction must not produce two conflicting layouts.
4. Select **Open shared window**. Verify one complete surface appears centered on the host and no full surface appears on the peer.
5. Fully quit both apps, reopen them, and verify the saved pair reconnects. Confirm a protocol-v1 or old mirrored build is rejected rather than allowed to create contradictory views.

Repeat the main checks later with macOS hosting, because host identity also selects workspace storage and program execution.

## One logical window and the shared bar

1. Grab the 36-DIP bar at the top of the host surface. Move slowly toward the configured seam using only the host trackpad.
2. Stop with roughly 25%, 50%, and 75% of the logical window across the seam. At each point verify:
   - the two native fragments meet as adjacent crops of one scene;
   - text, workspace items, the grid, cursor, particles, and program content are not duplicated or stretched;
   - the full logical content keeps the same size;
   - the bar fragments align and provide only one set of controls;
   - there is no flash of a second full window, native title bar, shadow, or rounded-corner gap.
3. Keep holding after the host fragment becomes extremely narrow and then disappears. Verify the original trackpad continues the drag through Pointer Lock and that release completes it on the peer. Check that no visible capture-keeper window remains.
4. Stop halfway, reverse direction without releasing, and return to the host. Release and confirm the final position is stable.
5. Start a drag from the peer's visible bar fragment and move back to the host. Repeat from each bar fragment while the window spans the seam.
6. Begin a drag, move a meaningful distance, and press Escape. Verify the window returns to its exact pre-drag logical rectangle and normal OS pointer control returns.
7. Interrupt a drag by disconnecting the network, sleeping the peer, and changing an available display. Verify ownership clears, the starting or recovered window retains a reachable bar, and no duplicate appears after reconnect.
8. Try near-simultaneous bar grabs from both computers. Verify only one owner moves the window and the losing input does not jump or cancel the accepted drag.
9. Move the window wholly to the other computer. On the computer with no fragment, choose **Bring window here** and verify the same window relocates there. Confirm there is no invisible global drag capture or full duplicate.
10. Close from each computer in turn. Both fragments must close as one surface while the tray/menu processes remain alive. Reopen from the other computer and verify one surface appears. Test Ctrl/Cmd+W, Ctrl/Cmd+Shift+O, and Ctrl/Cmd+Shift+Enter as well as the UI buttons.

Repeat horizontal and vertical arrangements if the intended setup uses them. Test a scaled Windows display against a Retina Mac, including unequal work-area heights and widths. Check all corners and the seam at each scale setting.

## Interior pointer input

1. Move into a visible content fragment without clicking. Verify the shared cursor follows and the OS cursor hides only within CompuSync.
2. Click the desktop to enter interior Pointer Lock. Move to every logical content edge and across the crop boundary. The cursor, grid distortion, click ripple, and particle trail must use one full-content coordinate system and align at the seam.
3. Press Escape and confirm ordinary pointer behavior immediately returns inside and outside the app.
4. Alternate input between both computers while each has a visible interior crop. Verify both operate the same cursor without absolute-position jumps.
5. Interact with workspace buttons and the editor. These actions must not also move the grid cursor or start a bar drag.
6. Confirm no CompuSync input is captured while using unrelated desktop applications.

## Workspace imports and directories

Run these checks first with Windows hosting, then with macOS hosting.

1. On the host, use **Import** to add a small UTF-8 text file. Verify it appears in the shared workspace and exists beneath the host profile's `workspace` directory.
2. On the peer, import a different text file and a file larger than 128 KiB. Verify progress, completion, exact byte contents on the host, and no corresponding CompuSync workspace copy beneath the peer profile.
3. Drop a directory with nested subdirectories and regular files from each computer. Verify its tree is reproduced. A symbolic link or unsupported filesystem entry must be rejected and must not escape the workspace.
4. Import the same filename twice. Verify the second item receives a numbered collision suffix and the first file is unchanged.
5. Create a folder, browse into it, import a file there, rename the file and folder, then browse with the breadcrumb controls.
6. Delete a file and a nonempty folder after the confirmation prompt. Verify the removed entries disappear on both computers and on host disk.
7. Restart the peer; verify the workspace remains available from the host. Restart the host and reconnect; verify files, names, and directories persist.
8. Exercise representative limits: a path deeper than 32 segments, a text file over 2 MiB, a file over 256 MiB, and an import that would exceed 1 GiB total. Verify bounded errors and no partial public file. Avoid filling the host disk merely to exercise a quota.
9. Try names with traversal, absolute paths, backslashes, `.compusync`, Windows device names, trailing dots/spaces, and forbidden characters through the narrowest available test API. Verify every form is rejected and no absolute host path appears in the peer UI or protocol errors.

## Host text editor

1. Double-click a valid UTF-8 text file on the host. Verify the bundled editor window appears inside the shared surface, identifies the host, and receives a valid 800x500 JPEG frame.
2. Click into the image, select and replace text, use keyboard shortcuts, pointer input, and the wheel, then save. Verify the host workspace file contains the exact new UTF-8 bytes.
3. Open another workspace text file from the peer. Edit and save from the peer and verify the result on host disk.
4. While the editor is open, drag the shared surface from host to peer, stop halfway, reverse, and finish. Verify the same editor instance remains open, its image is cropped with the rest of the surface, frames continue, and unsaved text is not reset.
5. Disconnect only the peer while the editor runs. Verify the editor stays alive on the host. Reconnect and confirm control and current program state return.
6. Start a large peer import while typing in the editor and dragging the bar. Verify control remains responsive because bulk data uses a separate channel. Occasional dropped JPEG frames may occur under backpressure; a later full frame must recover the display.
7. Attempt to open binary, invalid UTF-8, and over-2-MiB files. Verify a clear bounded error and no editor launch.
8. Close the editor from each computer. Verify the host process surface closes everywhere. Restart the host app and verify no previous editor process is restored, while saved files remain.
9. Verify there is no UI or protocol path for an arbitrary executable, application bundle, host path, shell command, or unrestricted argument.

## Network, disconnect, and sleep

1. Disconnect the peer mid-import. The partial transfer must be aborted, absent from the public workspace, and cleaned from internal transfer storage. Reconnect and retry the import.
2. Disconnect the peer while holding an interior mouse button and during a bar drag. The host must release stale input/ownership within the expected heartbeat window and preserve a reachable surface.
3. Close or move the window while the peer is offline, then reconnect. The peer must receive current host state without replaying stale inputs or creating a duplicate.
4. Suspend and wake each computer in turn. Verify saved pairing reconnects, current workspace contents return, and window geometry recovers on an available display. Running programs are not promised to survive a host app restart.
5. Quit the host. Verify the peer cannot mutate the workspace or program and presents a bounded connection error. Reopen the host and verify reconnection. There is no automatic host migration.
6. Test both normal and weak Wi-Fi. Confirm a large import or JPEG stream does not cause unbounded memory growth or block close, drag, and cursor control.

## Packaged application checks

1. Build and launch the Windows portable executable. Quit any older tray instance first so Electron's single-instance lock does not redirect to stale code.
2. On a Mac, build the unsigned DMG and ZIP with code-signing identity discovery disabled if needed. Test the artifact built for the Mac's architecture; test both Apple Silicon and Intel artifacts if both will be distributed.
3. Confirm the unsigned-build Gatekeeper flow is understood for development. Production distribution still requires appropriate Apple signing and notarization.
4. Verify local-network prompts, menu-bar/tray controls, settings shortcuts, close/reopen, **Bring window here**, and optional start at sign-in in packaged builds.
5. Enable start at sign-in, reboot or sign out/in, and verify the app starts quietly in the background, reconnects, and can receive **Open shared window** from the other computer.
6. Repeat the shared-bar crossing and editor-save checks from packaged apps. Pay special attention to Pointer Lock when the Mac source crop becomes a 1x1 transparent capture keeper.

## Completion record

For every failure, record the host, exact step, expected and actual behavior, relevant logs or Playwright trace, and whether it reproduces after both apps restart. A release is physically accepted only after the one-window seam, Pointer Lock crossing, peer import/save, mixed scaling, disconnect recovery, sleep/wake, and packaged-app checks pass with each operating system acting as host.
