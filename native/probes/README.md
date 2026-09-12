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
