# Mac-to-Mac and Mac-to-Windows acceptance checklist

Use the [README](../README.md) for prerequisites and source/extension installation. Automated tests cover cursor state, topology, authenticated transport, Chrome adapters, recovery, and real Electron processes; some native/audio/Chrome behavior is simulated. They cannot prove physical input, Retina alignment, system permission prompts, firewall behavior, sleep/wake recovery, or packaged behavior. Complete the applicable physical sections on the intended computers before claiming those features are accepted.

The legacy shared surface, workspace/sandbox, and bundled editor are retired. They are not an optional mode and must never be created, shown, or offered by current UI, tray/menu items, shortcuts, startup, reconnect, or second-instance activation. Connection & settings (including Latency Monitor), the optional Windows Messages Companion, and the temporary Chrome seam overlay are current UI.

## Automated gate

Run from a clean checkout with Node.js 22.12 or newer and the stable Rust toolchain:

```sh
npm ci
npm run native:build
npm run native:smoke
npm run check
npm test
npm run test:native
npm run test:e2e
```

Use an interactive desktop for Electron end-to-end tests. Record the command, OS, architecture, revision (including local changes), result, and retained trace. `playwright.config.cjs` excludes the two retired surface/workspace suites; active coverage includes pairing, startup, settings, selection persistence, mouse diagnostics, and audio controls. A passing two-process test on one OS is not cross-platform acceptance.

For optional package acceptance, also run `npm run build` and the distribution command for that OS: `npm run dist:win` on Windows or `npm run dist:mac` on macOS. These build local native components; selecting another Electron architecture alone does not cross-compile them. Signing/publishing prerequisites are separate; see [releases](releases.md). Source-only acceptance does not require uploading installers.

On Windows, `npm run native:probe:crash` exercises the hard-kill recovery helper. On other platforms the script skips, which is not a Windows recovery pass. Capture screenshots/traces with disposable profiles and mask pairing codes; review logs and screenshots before sharing them publicly.

## Mac-to-Mac acceptance

Run the updated app on two physical Macs, testing either as host. Confirm pairing
and reconnect show both OS types and distinct names (Mac 1/Mac 2 for identical
names). Arrange the Macs left/right, including different display sizes and
alignment offsets. Both top edges must remain reserved. Test cursor, keyboard,
scrolling, clipboard, and Chrome handoff in both directions; grant each Mac its
own Accessibility, Input Monitoring, and Chrome Automation permissions.

Start full stereo and split stereo from each Mac in turn. Confirm left/right
channels follow the screen layout, and each volume slider changes only its named
Mac. Test live layout swaps, stopping from the receiver, disconnect, sleep/wake,
and saved reconnect. Verify native capture permission and physical speaker timing
on the actual devices. Automated audio negotiation tests use simulated engines.

## Test record

Record:

- commit and app version;
- Windows version, processor architecture, displays, origins, resolutions, and scale percentages;
- macOS version, Mac model, Intel or Apple Silicon, displays, resolutions, and Retina modes;
- physical laptop arrangement and which computer starts the host session;
- network type, firewall prompts, and whether automatic discovery works;
- source revision or exact optional package: Windows NSIS installer/unpacked app, macOS ZIP, or macOS DMG;
- launching application identity and permission state for macOS Accessibility, Input Monitoring, and Chrome Automation;
- Chrome version/profile, Windows extension ID/version and managed folder, and the Mac JavaScript-from-Apple-Events setting;
- audio source/output devices, driver versions, and recording permission when testing audio;
- Full Disk Access and Messages Automation when testing Messages Companion.

Start with fresh profiles, then repeat persistence checks with saved profiles.

## Retired-surface regression

1. Start each app normally. Verify **Connection & settings** is the foreground app UI, allowing first-run OS/Chrome setup prompts when applicable. No legacy shared surface, grid, desktop, workspace, editor, frameless sandbox, or taskbar/Dock entry for such a window may appear. Messages Companion should appear only when explicitly opened.
2. Close settings and activate CompuSync from the Windows tray and Mac menu bar. Verify settings reopens and no retired window is created.
3. Launch CompuSync a second time while it is already running. Verify the existing settings window activates without a legacy window flash.
4. Pair, reconnect a saved pair, link and unlink cursors, transfer ownership, change display layout, suspend/wake, and disconnect/reconnect the network. Verify none of these state changes opens the retired surface.
5. Enable start at sign-in and restart each session. Verify background startup creates no visible settings or retired window until explicitly activated.
6. Inspect tray/menu controls and current shortcuts. Verify there is no **Open shared window**, **Bring window here**, shared-bar action, workspace/editor command, Ctrl/Cmd+Shift+O, or Ctrl/Cmd+Shift+Enter action.
7. Quit each app. Verify no hidden legacy window delays shutdown or becomes visible during teardown.

A temporary transparent seam overlay during a Chrome straddle is expected. It must be click-through and non-focusable and must disappear after commit, reversal, unlink, or recovery; it is not the retired shared surface.

## Pairing and live connection

1. Test both Mac-to-Mac and Mac-to-Windows with either supported computer hosting. Choose **Share from here** on one computer, enter its eight-character code under **Join other laptop** on the other, and verify both report **Connected**. Repeat code entry in lowercase without a dash. For identical Mac names, verify Mac 1/Mac 2 remain distinct in screen groups and volume controls.
2. If automatic discovery is blocked, enter the displayed host address and TCP port under **Connection help**. Confirm direct connection succeeds without weakening machine-wide firewall settings.
3. Fully quit both apps and reopen them. Verify the saved pairing reconnects when both are available. Confirm that settings distinguishes a saved pairing waiting to reconnect from a live **Connected** session.
4. While only one laptop is running, attempt to link. Verify linking remains unavailable and explains that the saved peer must reconnect. Start the other app, wait for **Connected**, and verify linking becomes available.
5. Confirm an obsolete protocol build is rejected rather than treated as a current peer.
6. On Windows, attempt to pair with another Windows computer. Verify the unsupported-pair message, that the unclaimed code remains usable for a supported peer, and that input/audio do not link.

## Screen topology and cursor ownership

1. Configure left/right arrangements in each physical direction. For a mixed pair, also place Windows below the Mac; for two Macs, verify left/right placement and both reserved top edges. The cursor must cross only the configured adjoining edge, never a Mac's top/menu-bar edge.
2. Adjust alignment offset for unequal screen positions. Cross near both ends of the shared edge and verify mapping remains inside the destination display.
3. Link the cursor and cross slowly and quickly using each laptop's mouse or trackpad. Verify either device contributes motion, one owner remains authoritative, keyboard input follows ownership, and movement does not wait for the peer.
4. Exercise **Move cursor to other laptop** and Ctrl/Cmd+Shift+Y from each owner. Verify the cursor parks within the destination screen and input ownership follows it.
5. Cross while holding each mouse button and representative Ctrl/Alt/Shift/Meta combinations. Verify held state transfers correctly and no input remains stuck after returning.
6. Set edge resistance to zero and a nonzero value. Verify the configured extra push applies only when not dragging a native window.
7. Exercise Ctrl/Cmd+Shift+U while settings is closed and while its renderer is busy. Verify immediate unlink, visible local cursors, released buttons/modifiers, and normal local input on both computers.
8. Repeat with multi-monitor desktops, negative and above-primary origins, mixed Windows scale factors, Retina modes, and display hotplug. Verify topology refreshes without overlap, invalid-screen notices, cursor jumps, or a stranded cursor.

With cursor linking active and Windows owning the cursor, use the Windows mouse and trackpad to drag-select text in Notepad and a Chrome text field. Test a short selection, several lines, reversing direction while held, and dragging beyond the text area to scroll. Confirm release ends the selection and a subsequent drag starts a fresh selection. Repeat after a Mac-to-Windows handoff, on secondary monitors with different scale factors, and using the Mac input device to select Windows text. Verify unlink restores ordinary local selection.

With macOS owning the cursor, use the Windows mouse and trackpad to drag Chrome and Finder windows within the Mac desktop. Try slow and fast movement, pauses while held, and reversals; the window must follow until the actual button release. Repeat immediately after switching focus between apps, then drag Chrome across the shared edge and back. Confirm detecting the window move does not drop the held button, crossing still completes or reverses normally, and a subsequent drag starts cleanly.

Repeat using the Mac's own trackpad with a physical press-and-hold. Rebuild the Mac native addon first; restarting JavaScript alone does not update its event tap. Start with tiny movements, then drag slowly and quickly, pause, and reverse while held. Check both local Chrome/Finder dragging and Chrome handoff from Mac to Windows, including reversing across the seam before release and re-grabbing a parked split. The window must follow the shared cursor without jumping to a second position or dropping before the actual release. Using the same Mac trackpad, select text on each laptop and verify release ends selection. Unlink and confirm ordinary local dragging still works. Repeat with an external Mac mouse; also test tap-and-hold or three-finger dragging if enabled in macOS.

Open **Connection & settings → Latency Monitor → Mouse latency** on both computers while moving the Mac mouse with the cursor on Windows, then the Windows mouse with the cursor on Mac. Confirm the corresponding direction shows an estimated median and p95 in milliseconds on both computers, including while dragging a window. Hover a value for sample count and clock uncertainty. Confirm a slower connection or delayed destination updates increase the values, readings expire after ten idle seconds, and unlink/reconnect clears old samples. Test matching current builds; an older peer should leave timing unavailable while compatible cursor input continues. These numbers cover the application input path through the native cursor update, excluding device/OS input delivery and display redraw. In a Mac pair, verify names/directions distinguish the two computers instead of displaying a Windows label.

## macOS permissions

For the Mac-to-Windows cursor regression, close CompuSync settings and keep another Mac app in the foreground. Using the Mac trackpad, cross to Windows and keep moving, clicking, and scrolling there for at least 30 seconds. Verify the Mac pointer stays hidden and Mac apps receive none of that input. Cross back and repeat with an external Mac mouse, with either computer hosting the session, and after switching the foreground Mac app. Confirm unlinking immediately restores ordinary Mac input.

1. Deny Accessibility, Input Monitoring, and Chrome Automation individually on fresh permission state. Verify each denial remains visible with the correct System Settings remediation action and cursor/window capture does not silently proceed.
2. Grant Accessibility and Input Monitoring, fully restart CompuSync if requested by macOS, reconnect, and verify cursor linking succeeds.
3. On first-run startup with the current native addon, verify Accessibility, Input Monitoring, and Chrome Automation are checked/requested by onboarding. Later launches should reflect the saved OS decisions and show remediation for denials. A fresh CompuSync profile does not reset macOS TCC; record the real OS permission state rather than assuming it is fresh. Approving Automation must not silently enable Chrome's JavaScript preference or grant audio/Messages permissions.
4. Confirm basic tab/URL handoff works without Chrome's **JavaScript from Apple Events** option, and trying page-state transfer shows an actionable setup notice. Enable **View > Developer > Allow JavaScript from Apple Events** and repeat the scroll/draft tests below. Do not silently change Chrome's preference.

## Windows Chrome extension setup

1. Use a fresh CompuSync profile. Decline the startup setup offer and verify no extension is silently installed, Chrome is not restarted into another profile, and its existing tabs/login state are unchanged. Restarting the app after declining should not repeatedly force the startup offer.
2. Attempt Chrome handoff without a connected helper and verify setup can be requested again. Accept **Open setup** and confirm it opens Chrome Extensions and the prepared `chrome-extension` folder. This deliberate setup action may launch Chrome.
3. Enable Developer mode, use Load unpacked to select the managed folder containing `manifest.json`, and confirm **CompuSync Tab Bridge** is enabled in the intended Chrome profile. Verify the native host connects without administrator access or a remote-debugging port. Merely loading the repository's source folder is not the complete native-helper installation.
4. Hand off a window from the existing Chrome profile. Verify the app does not require copying that profile or signing into an isolated profile. Close/reopen Chrome and restart CompuSync; verify the bridge reconnects. Receiving a destination handoff may deliberately launch Chrome if needed.
5. With the helper already installed, start CompuSync without setup/handoff. Verify startup does not open Chrome just to scan. Disable/remove the extension and verify an actionable helper/setup notice without disrupting ordinary local browsing or non-Chrome sharing features.
6. Update/rebuild CompuSync after quitting it, restart it so files/registration are refreshed, then reload Tab Bridge in Chrome Extensions. Verify the new code connects. Repeat after moving a source checkout and restarting the app so the native host path is refreshed; keep the managed extension folder stable.
7. Try an elevated/unsupported application window and verify any limitation notice is nonblocking and local input remains usable. Repeat the Chrome checks from a package when testing optional installers.

## Chrome handoff

Use a normal Chrome window with seven tabs, including two pinned tabs, duplicate URLs, and one playing video. Add two tabs after the first transfer and round-trip it again.

1. Transfer in both directions. Verify tab order, pinned state, active tab, geometry, and current pages. Duplicate URLs must retain distinct positions.
2. Pause with roughly 25%, 50%, and 75% of Chrome across the seam. Release at each position and verify both portions remain visible with no midpoint winner or close. Leave the split longer than three seconds, then pick up either portion and continue in either direction. The existing native windows must be reused.
3. Stop and reverse before release. Cross again within three seconds, then repeat after waiting beyond three seconds. Verify prepared copies are reused only within the retention window and no residue remains afterward.
4. Move the window completely onto one laptop and release. Verify only that laptop retains the window. The source must never be destroyed before reliable commit acknowledgement. Repeat partial release and immediate re-grab while destination tab preparation is still running.
5. Confirm maximized/fullscreen Chrome transfers without a live straddle. Confirm unsupported applications and sub-200x150-VU windows clamp locally while the cursor crosses and show only a brief nonblocking hint.
6. Navigate and reorder tabs after a Windows-to-Mac transfer, then return to Windows. Verify changed Mac state wins and stale retained history is not restored.
7. Record structured logs for success, reversal, and failure. They may contain descriptor ID, phase/duration, hostname, and tab count, but no full URL, title, history URL, or session token.
8. Rebuild native modules on both laptops, then measure an ordinary window's physical width and height before and after transfer. Repeat with the Windows internal and external displays at different scaling factors and the Mac Retina display. A window that fits should retain its size in inches; one too large for the receiving monitor should fit within 90% of it with its aspect ratio preserved. Verify sizing is correct from preparation onward, not only after release.
9. While a split is retained, unlink, quit, or change a display. Verify each surviving local Chrome copy returns fully onto its desktop and no window or input guard remains stranded.
10. Restart both updated apps and reload the Windows Chrome extension. On a plain HTTP/HTTPS page, scroll down, scroll a nested pane, enter a text/textarea draft, select a checkbox and an option, and expand a details section. Cross in both directions and verify the destination approximately matches before and after release, including when initial page loading is slow. Passwords and file inputs must remain local; restoration must not submit or replay an action.
11. Release halfway, navigate or change ordinary fields on one copy, then pick up that same portion and finish the crossing. Verify its current tabs and supported page state refresh the existing peer window without creating a third copy. Parked copies do not continuously synchronize interaction; navigation state owned internally by a complex web application may not transfer.

## Failure recovery

During separate Chrome straddles:

1. Pull the network connection.
2. Force-quit source Chrome.
3. Force-quit destination Chrome.
4. Suspend each computer.
5. Disconnect or reconfigure a display.
6. Hard-kill each CompuSync process.
7. Trigger the native crash-recovery probe on Windows with `npm run native:probe:crash`.

For every case, verify a surviving Chrome copy returns fully on-screen, overlays and hooks clear, held synthetic input releases, cursors reappear promptly, and CompuSync enters Unlinked mode. After both apps recover and report **Connected**, linking should succeed again without restarting the operating system.

## Network and lifecycle

1. Test normal and weak Wi-Fi. Verify cursor input is never queued and replayed after a stall.
2. Quit the current session host. Verify the peer reports connection loss, unlinks safely, and regains a live connection when the host returns. There is no automatic host migration.
3. Suspend and wake each computer in turn. Verify the saved pair reconnects, topology refreshes, and local input remains safe throughout.
4. Change the host's DHCP address. Saved reconnect retries the recorded address; do not assume it rediscovers a changed address automatically. Use a fresh code with discovery or manual address entry to restore the connection, then restart both apps and verify the new address reconnects. Do not include pairing/connection secrets in evidence.
5. Leave settings closed during reconnect and recovery. Verify tray/menu status updates and no unrelated foreground window is opened.

## Packaged applications

1. Build, install, and launch the Windows NSIS installer. Quit any older tray instance first so Electron's single-instance lock does not redirect to stale code.
2. Build and launch the macOS DMG matching the Mac architecture. Exercise the expected unsigned-development Gatekeeper flow; production distribution and automatic updates require signing and notarization.
3. Verify local-network and macOS permission prompts, tray/menu controls, settings activation, cursor link/unlink, ownership transfer, and optional start at sign in.
4. Repeat cursor crossings, Chrome round trips, reversal, and one failure-recovery case from packaged builds.
5. Repeat the retired-surface regression from packaged builds. No obsolete window or command may return because of packaging, saved state, or an older profile.
6. With controlled signed releases and a configured update feed, verify an older installed release downloads a newer version and installs after quitting/reopening. Repeat on both platforms, including native host registration and Windows extension reload. Source runs must not check the feed. Keep Mac ZIP/update metadata hosted; users need not manually download a ZIP beside their DMG. This is a package test, not a prerequisite for publishing source.

## Plain-text clipboard and UI selection

1. While connected, copy fresh plain text on each computer and paste it on the other, with cursor linking both on and off. Verify Unicode text and empty/oversized handling without repeated clipboard echo.
2. Disable **Sync copied text between laptops** and verify new text stays local. Re-enable it and verify only new changes are shared. Reconnect after offline copying and verify the offline/current clipboard is not automatically pushed as a backlog.
3. Copy an image or file and verify it does not become an advertised image/file-sync feature. Use disposable test text; received text can enter OS clipboard history. Logs should not contain the copied text.
4. Drag-select text in settings and in Messages Companion. Leave it selected through periodic status/message/volume updates and verify the selection remains usable for copying. Repeat after selecting a different conversation and after reconnecting.

## Synchronized audio in either direction

Follow the [audio routing guide](audio-routing.md). Rebuild both addons for **audio protocol v3** and use current source on both computers; this protocol is distinct from the session handshake and app version.

1. Test Mac-to-Mac with either Mac sending, and Mac-to-Windows with either computer sending. One route runs at a time. Repeat with cursor linking off and verify pairing alone is enough.
2. For each Mac sender, use macOS 14.6+ and check System Audio Recording approval/denial under the actual launch identity. Test source and package identities separately when packages are in scope.
3. For Windows sending, install standard VB-CABLE and follow the guide's default-output/capture-bus steps. Receiving on Windows must not require the driver. Record original console/multimedia/communications outputs and verify restoration on stop and failed setup, preserving a deliberate user output change.
4. Test full stereo, then stop and choose split stereo. Verify channels follow the main displays' left/right positions, names remain distinct for two Macs, and live arrangement changes either reassign correctly or stop an invalid route with an explanation.
5. Adjust each named device's volume from either computer. Verify only the intended system output changes, external system-volume changes appear, and unsupported volume controls explain their disabled state. Local volume controls should work without starting audio sharing.
6. Stop from either computer. Test denied permissions, missing/removed outputs, failed starts, disconnect, sleep/wake, capture failure, and process exit. Ordinary source playback must recover; reconnect must leave sharing stopped. Windows output-role recovery and Mac tap cleanup are different paths—verify both.
7. Open **Latency Monitor → Audio** and verify directional scheduling readings appear while sharing, update, and clear on stop/disconnect. They must not depend on cursor linking and must not be presented as measured speaker skew.
8. Record clicks from both physical outputs through one recording clock to measure acoustic skew, drift, and resynchronization. Follow the guide's measurement procedure; UI clock/schedule estimates alone do not establish alignment. Audio buffering also delays sound relative to an independently playing video.

## Optional Messages Companion

1. Pair Windows with the Mac and open **Messages Companion…** from the Windows tray. Confirm the current app does not open the retired workspace/editor to display it.
2. Deny Full Disk Access on the Mac and verify a readable permission error. Grant it to the actual launching Terminal/IDE/installed app, fully quit/restart, and verify conversations/history load from the paired Mac.
3. Check known contacts, unknown handles, group titles, and missing Contacts permission/data. Only participant names should be transferred. Select and copy a displayed message while background updates occur.
4. With an explicitly chosen test conversation/recipient, compose and send a test message. Verify Messages Automation approval/denial produces the correct result without retrying into duplicate sends. Do not use production contacts or include real messages in published test traces.
5. Disconnect/reconnect the Mac and verify stale loading/sending states recover or explain the failure. Read/send access must not bypass the Mac's permission decisions.

## Completion record

For every failure, record the host, exact step, expected and actual behavior, relevant redacted logs/trace, and whether it reproduces after both apps restart. Source acceptance covers the supported pair, advertised features, first-run setup, recovery, and the retired-surface regression. Optional installer releases additionally require package/signing/update checks. Record unavailable physical tests as unverified rather than substituting old CI results or a simulated engine.
