# Native risk probes

These are explicit diagnostics for physical Windows/macOS behavior, separate from normal installation. Start with the [README](../../README.md), [current design](../../docs/DESIGN_CHOICES.md), and [acceptance checklist](../../docs/testing.md). The commands below assume the repository root as the working directory.

Build the local native components before using them:

```sh
npm ci
npm run native:build
npm run native:smoke
```

Interactive probes manipulate a selected test window or cursor state. Use a dedicated test session and record the OS, architecture, revision, addon/guard paths, and outcome. A probe's presence, a non-Windows skip, or a historical result is not current physical acceptance.

## Windows Chrome research probe

```powershell
./native/probes/windows-chrome.ps1 -Mode inspect
./native/probes/windows-chrome.ps1 -Mode offscreen -Execute
./native/probes/windows-chrome.ps1 -Mode uia -Execute
```

`inspect` reports Chrome's location/running state. The other modes deliberately launch a disposable isolated profile with a local debugging port. They do not open or migrate the normal Chrome profile. The script reports its temporary profile location and stops only the probe's processes; inspect/remove that disposable profile when finished.

This CDP/UI Automation probe is historical research tooling, not the product's current Windows setup or a workaround that users need to run. The active runtime uses the unpacked Tab Bridge extension, per-user native host registration, and the user's existing Chrome profile. Follow the [Windows extension instructions](../../README.md#install-the-chrome-extension-on-windows) to test that path.

## Windows move-loop termination

With the app/addon running in a test session, link the cursors and drag a sacrificial Notepad window. At edge contact, instrument the native call to `terminateMoveLoop(windowId)` while continuing to hold the physical left button. Record whether:

1. `EVENT_SYSTEM_MOVESIZEEND` arrives exactly once;
2. raw deltas continue while the physical button remains down;
3. Notepad receives no content click or command after the injected release;
4. releasing the physical button produces no second application action;
5. unlinking restores ordinary local held dragging and selection.

A scripted `SC_MOVE` does not exercise the same physical pointer-clamp/modal-loop path. The implementation tags injected input and guards button release at edge contact. macOS has no corresponding Windows foreign-window modal move loop; its Accessibility/event-tap positioning needs its own held-drag tests.

## Windows hard-kill recovery

Use the wrapper from the repository root; it selects the current Node architecture and passes both the copied addon and recovery guard paths:

```powershell
npm run native:probe:crash
```

On non-Windows systems this command skips. For a direct PowerShell invocation, pass both paths rather than relying on the probe script's older guard default:

```powershell
./native/probes/windows-crash-recovery.ps1 -Addon ./native/compusync-native.win32-x64.node -Guard ./native/compusync-recovery-guard.exe
```

Replace `x64` with the actual addon architecture when necessary. The child arms cursor hide/clip state and the parent hard-terminates it. The probe reads `GetClipCursor`/`GetCursorInfo`, then releases the clip and performs visibility cleanup in `finally`.

Record `Passed` together with `CursorVisibilityObservable`. If the baseline OS session did not expose cursor visibility, the probe cannot establish hide/show recovery even if clipping recovery passed. A hardware held-input/window recovery check remains separate from this cursor-clip probe.

## macOS

Use a current source or packaged app with Accessibility, Input Monitoring, and Chrome Automation approved under its real launch identity. Signing/notarization is a separate package-distribution check; source testing does not require a signed installer. The current app checks input/Chrome permissions during startup onboarding, rather than deferring the first check to a crossing.

- Prepare an Accessibility-addressable test Chrome window and use the native `setWindowBounds` path to place it beyond the display. Verify the OS-reported position and restore the original bounds afterward.
- Enumerate/recreate a supported Chrome window through the Apple adapter. Verify ordinary tabs work without JavaScript from Apple Events, and that scroll/draft transfer reports its limitation until the optional Chrome setting is enabled. No extension is required on the Mac.
- Test held local/remote mouse and trackpad drags, including tiny initial movement, pause, reversal, parked split pickup, and actual physical release.
- Test left/right crossings on two Macs. For a mixed pair with Windows below the Mac, also test the Mac's bottom seam. A Mac top/menu-bar edge must remain reserved.
- Hard-quit the app during separate input/window tests and verify the OS-local recovery guard restores local control and reachable windows.

These checks require real WindowServer/TCC/input behavior. A Windows cross-compile or fake native adapter cannot establish the result.

## Historical Windows observations — September 12, 2026

The following were recorded in the original probe report and were not rerun by the documentation reconciliation:

- A disposable Chrome window accepted `SetWindowPos(x = -20000)`; `GetWindowRect` reported the requested origin for a 1050-pixel-wide window.
- UI Automation exposed the test tab titles but no HTTP URL value patterns. That observation ruled out that UIA-only approach for background URLs; it did not rule out the extension/native-messaging approach used today.
- Hard termination without an independent guard left a 1×1 `ClipCursor` active. With the guard, the report observed full-desktop clipping and a visible cursor 500 ms after termination.
- The modal move-loop test required a physical held drag; no automated result was recorded for it.

Repeat relevant probes against the current revision before using these observations as acceptance evidence.
