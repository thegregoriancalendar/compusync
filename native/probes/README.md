# Native risk probes

These probes deliberately stay outside the shipping addon. Run them on physical
machines before accepting M2; they manipulate only an explicitly selected test
window or a disposable Chrome profile.

## Windows Chrome

```powershell
./windows-chrome.ps1 inspect
./windows-chrome.ps1 offscreen -Execute
./windows-chrome.ps1 uia -Execute
```

The script never opens the normal Chrome profile. It leaves the disposable
profile path in its output so cleanup is an explicit, inspectable operation.

## Windows move-loop termination

Build the addon, link Compusync, and drag a sacrificial Notepad window. At edge
contact call `terminateMoveLoop(windowId)` while continuing to hold the physical
left button. Record whether:

1. `EVENT_SYSTEM_MOVESIZEEND` arrives exactly once;
2. raw deltas continue while the physical button remains down;
3. Notepad receives no content click or command after the injected up;
4. releasing the physical button produces no second application action.

This must remain an interactive probe. A scripted `SC_MOVE` does not exercise
the pointer-clamp/modal-loop path and yields a false positive. The implementation
uses a `SendInput` left-up tagged with Compusync's injection marker at edge
contact. macOS has no corresponding foreign-window modal move loop; its AX
positioning path intentionally makes `terminateMoveLoop` a no-op.

## Windows hard-kill recovery

After building/copying the release addon, run:

```powershell
./windows-crash-recovery.ps1 -Addon ../compusync-native.win32-x64.node
```

The child hides and clips the cursor, and the parent terminates it without a
graceful exit. The probe checks OS recovery with `GetClipCursor` and
`GetCursorInfo`, then unconditionally releases the clip and increments the show
counter as a final safety cleanup.

## macOS

On a signed build with Accessibility and Input Monitoring granted:

- prepare an AX-addressable Chrome window and call `setWindowBounds` with an x
  coordinate one full width beyond the outer display; verify AX reports the
  requested origin and no portion is visible;
- enumerate a normal Chrome window through AppleScript in the Node adapter,
  recreate its active URL, and verify Automation prompts only on first use;
- drag through left, right, and bottom edges while collecting event-tap deltas;
  top is intentionally excluded by the virtual-space controller.

These checks require macOS permission state and real WindowServer behavior and
cannot be represented faithfully by a Windows CI job.

## Recorded Windows findings (2026-09-12)

- Chrome accepted `SetWindowPos(x = -20000)` exactly; `GetWindowRect` returned
  `x = -20000` for a 1050px-wide window, so full offscreen pre-warm is viable.
- UI Automation exposed both test tab titles and zero HTTP URL value patterns.
  It cannot supply the background-tab URLs required by the descriptor, so it is
  not a viable no-relaunch Windows fallback.
- Hard-terminating the addon process left its 1x1 `ClipCursor` active. With the
  independent recovery guard installed, the same probe observed full-desktop
  clipping and a visible cursor 500ms after termination.
- The Windows modal move-loop test still requires a physical held drag; no
  automated claim is made for it.
