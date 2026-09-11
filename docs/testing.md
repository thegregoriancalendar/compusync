# Two-laptop acceptance check

Automated coverage includes an actual Windows title-bar drag between two local app instances, but does not substitute for a Windows 11 + macOS physical-device test. Use this checklist on the actual laptops before calling the cross-platform interaction verified.

## Pair and share

1. Start the updated CompuSync on Windows and the Mac. Enter Windows' eight-character code on the Mac, with Windows hosting, and verify automatic discovery pairs them without an address. Both settings windows should show Connected. Try lowercase input without a dash. On networks that block discovery, use the optional address and port under Connection help.
2. Set right on Windows and left on Mac if the Mac sits to the right.
3. Open both grid windows. Move a mouse into each. Verify the native cursor is hidden within each surface and one shared cursor moves on both. The grid should bend around it and the particle trail should appear on both views.
4. Click to capture on both machines. Move both trackpads at the same time, including opposite directions. Verify the shared cursor combines movement without jumping back to the other laptop's local mouse position. Move toward every edge; it should stay inside the surface. Verify clicks strengthen the grid distortion and old particle trails fade away.
5. Press Escape on each laptop. Verify normal OS mouse behavior returns, including outside CompuSync. Re-enter the surface to resume.

## Handoff and lifecycle

1. Drag the Windows window by its native title bar until the pointer reaches its configured physical screen edge. Verify Windows hides its view and the Mac shows the window at the opposite edge.
2. Release the mouse after handoff. Use the Mac trackpad to control the received cursor. Drag back through the Mac's configured edge.
3. Repeat using Send to other laptop and Ctrl/Cmd+Shift+Enter. Use Show here after transfer and verify dual input works again.
4. Close using Windows X. Both shared windows should hide while both tray/menu bar processes remain alive. Reopen from the Mac's menu bar icon. Reverse roles and repeat with the Mac's close button.
5. Resize on each laptop. Verify the other view follows, fitting its own screen even when DPI settings differ. Try a scaled Windows display, a Retina Mac display, and any locally attached monitors.

## Recovery

1. Disconnect Wi-Fi on the joiner while it is holding the cursor button. Verify the host detects the disconnect within about 6 seconds, releases the button, and recovers its own window if needed. Restore Wi-Fi; pairing should reconnect automatically.
2. Close the shared window while the joiner is offline, then reconnect. Verify the joiner receives the host's closed state instead of replaying old input.
3. Quit the host, then reopen it. The joiner should reconnect with its saved invitation. Suspend and wake each laptop and repeat.
4. Fully quit both applications, open them again, and verify the saved pair reconnects. In packaged builds, enable start at sign-in and verify the app starts without a visible window, then receives an open from the other laptop.
5. Pair in the opposite direction, with the Mac hosting. Repeat the primary cursor, close, and edge handoff checks.

## Record

Record OS versions, app version, processor architecture, scale factors, which machine hosted, network/firewall behavior, and each failure. This repository has local Windows automation results, not a completed physical MacBook acceptance run.
