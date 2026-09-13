# Windows and Mac acceptance checklist

Automated tests cover cursor state, topology, authenticated transport, Chrome handoff, recovery, and real Electron pairing processes. They cannot prove physical Windows-to-Mac input, Retina alignment, system permission prompts, firewall behavior, sleep/wake recovery, or packaged behavior. Complete this checklist on the intended computers before release.

The legacy shared surface, workspace/sandbox, and bundled editor are retired. They are not an optional mode and must never be created, shown, or offered by current UI, tray/menu items, shortcuts, startup, reconnect, or second-instance activation.

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
npm run build

# Platform package, run on its target OS:
npm run dist:win
npm run dist:mac
```

Use an interactive desktop for Electron end-to-end tests. Record the command, OS, architecture, commit, result, and retained trace. A passing two-process test on one operating system is not cross-platform acceptance.

## Test record

Record:

- commit and app version;
- Windows version, processor architecture, displays, origins, resolutions, and scale percentages;
- macOS version, Mac model, Intel or Apple Silicon, displays, resolutions, and Retina modes;
- physical laptop arrangement and which computer starts the host session;
- network type, firewall prompts, and whether automatic discovery works;
- source, Windows portable executable, macOS ZIP, or macOS DMG;
- permission state for macOS Accessibility, Input Monitoring, and Chrome Automation.

Start with fresh profiles, then repeat persistence checks with saved profiles.

## Retired-surface regression

1. Start each app normally. Verify only **Connection & settings** appears. No legacy shared surface, grid, desktop, workspace, editor, frameless sandbox, or taskbar/Dock entry for such a window may appear.
2. Close settings and activate CompuSync from the Windows tray and Mac menu bar. Verify settings reopens and no retired window is created.
3. Launch CompuSync a second time while it is already running. Verify the existing settings window activates without a legacy window flash.
4. Pair, reconnect a saved pair, link and unlink cursors, transfer ownership, change display layout, suspend/wake, and disconnect/reconnect the network. Verify none of these state changes opens the retired surface.
5. Enable start at sign-in and restart each session. Verify background startup creates no visible settings or retired window until explicitly activated.
6. Inspect tray/menu controls and current shortcuts. Verify there is no **Open shared window**, **Bring window here**, shared-bar action, workspace/editor command, Ctrl/Cmd+Shift+O, or Ctrl/Cmd+Shift+Enter action.
7. Quit each app. Verify no hidden legacy window delays shutdown or becomes visible during teardown.

A temporary transparent seam overlay during a Chrome straddle is expected. It must be click-through and non-focusable and must disappear after commit, reversal, unlink, or recovery; it is not the retired shared surface.

## Pairing and live connection

1. Start CompuSync on Windows and macOS. Choose **Share from here** on one computer, enter its eight-character code under **Join other laptop** on the other, and verify both report **Connected**. Repeat code entry in lowercase without a dash.
2. If automatic discovery is blocked, enter the displayed host address and TCP port under **Connection help**. Confirm direct connection succeeds without weakening machine-wide firewall settings.
3. Fully quit both apps and reopen them. Verify the saved pairing reconnects when both are available. Confirm that settings distinguishes a saved pairing waiting to reconnect from a live **Connected** session.
4. While only one laptop is running, attempt to link. Verify linking remains unavailable and explains that the saved peer must reconnect. Start the other app, wait for **Connected**, and verify linking becomes available.
5. Confirm an obsolete protocol build is rejected rather than treated as a current peer.

## Screen topology and cursor ownership

1. Configure left/right arrangements in each physical direction and an other-laptop-below arrangement. Verify the cursor crosses only the adjoining edge and macOS does not cross its top edge.
2. Adjust alignment offset for unequal screen positions. Cross near both ends of the shared edge and verify mapping remains inside the destination display.
3. Link the cursor and cross slowly and quickly using each laptop's mouse or trackpad. Verify either device contributes motion, one owner remains authoritative, keyboard input follows ownership, and movement does not wait for the peer.
4. Exercise **Move cursor to other laptop** and Ctrl/Cmd+Shift+Y from each owner. Verify the cursor parks within the destination screen and input ownership follows it.
5. Cross while holding each mouse button and representative Ctrl/Alt/Shift/Meta combinations. Verify held state transfers correctly and no input remains stuck after returning.
6. Set edge resistance to zero and a nonzero value. Verify the configured extra push applies only when not dragging a native window.
7. Exercise Ctrl/Cmd+Shift+U while settings is closed and while its renderer is busy. Verify immediate unlink, visible local cursors, released buttons/modifiers, and normal local input on both computers.
8. Repeat with multi-monitor desktops, negative and above-primary origins, mixed Windows scale factors, Retina modes, and display hotplug. Verify topology refreshes without overlap, invalid-screen notices, cursor jumps, or a stranded cursor.

## macOS permissions

1. Deny Accessibility, Input Monitoring, and Chrome Automation individually on fresh permission state. Verify each denial remains visible with the correct System Settings remediation action and cursor/window capture does not silently proceed.
2. Grant Accessibility and Input Monitoring, fully restart CompuSync if requested by macOS, reconnect, and verify cursor linking succeeds.
3. Verify Automation is requested only on the first eligible Chrome crossing, not at application startup or simple cursor linking.
4. Confirm CompuSync works without enabling Chrome's **JavaScript from Apple Events** option.

## Windows Chrome profile consent

1. Use a normal Chrome profile and drag an eligible Chrome window toward the seam. Decline the first restart offer and verify Chrome stays local with no repeatedly blocking prompt.
2. Use a fresh CompuSync profile, accept the offer, and confirm Chrome restarts into CompuSync's isolated signed-out profile with only the intended current session restored.
3. Restart CompuSync without dragging Chrome. Verify it never launches Chrome merely because CompuSync starts.
4. Try an elevated application window and verify any limitation notice is nonblocking and shown only as designed.

## Chrome handoff

Use a normal Chrome window with seven tabs, including two pinned tabs, duplicate URLs, and one playing video. Add two tabs after the first transfer and round-trip it again.

1. Transfer in both directions. Verify tab order, pinned state, active tab, geometry, and current pages. Duplicate URLs must retain distinct positions.
2. Pause with roughly 25%, 50%, and 75% of Chrome across the seam. Verify the native window edges share the same virtual origin while platform-specific Chrome interiors may differ.
3. Stop and reverse before release. Cross again within three seconds, then repeat after waiting beyond three seconds. Verify prepared copies are reused only within the retention window and no residue remains afterward.
4. Release before halfway and verify the source survives. Release after halfway and verify the destination commits. The source must never be destroyed before reliable commit acknowledgement.
5. Confirm maximized/fullscreen Chrome transfers without a live straddle. Confirm unsupported applications and sub-200x150-VU windows clamp locally while the cursor crosses and show only a brief nonblocking hint.
6. Navigate and reorder tabs after a Windows-to-Mac transfer, then return to Windows. Verify changed Mac state wins and stale retained history is not restored.
7. Record structured logs for success, reversal, and failure. They may contain descriptor ID, phase/duration, hostname, and tab count, but no full URL, title, history URL, or session token.

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
4. Change the host's DHCP address. Verify automatic discovery or manual address entry can restore the saved relationship without exposing pairing secrets.
5. Leave settings closed during reconnect and recovery. Verify tray/menu status updates and no unrelated foreground window is opened.

## Packaged applications

1. Build and launch the Windows portable executable. Quit any older tray instance first so Electron's single-instance lock does not redirect to stale code.
2. Build and launch the macOS artifact matching the Mac architecture. Exercise the expected unsigned-development Gatekeeper flow; production distribution requires signing and notarization.
3. Verify local-network and macOS permission prompts, tray/menu controls, settings activation, cursor link/unlink, ownership transfer, and optional start at sign in.
4. Repeat cursor crossings, Chrome round trips, reversal, and one failure-recovery case from packaged builds.
5. Repeat the retired-surface regression from packaged builds. No obsolete window or command may return because of packaging, saved state, or an older profile.

## Completion record

For every failure, record the host, exact step, expected and actual behavior, relevant logs or trace, and whether it reproduces after both apps restart. Release acceptance requires successful pairing/reconnect, cursor ownership in both directions, mixed-scale topology, permission remediation, Chrome commit/reversal, network and process recovery, sleep/wake, packaged-app checks, and confirmation that the retired surface never appears.
