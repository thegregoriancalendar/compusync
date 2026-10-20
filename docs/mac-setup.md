# Run CompuSync on a Mac

CompuSync pairs two Macs or a Mac and Windows 11. Run the same current source revision on both computers on the same local network. Windows-to-Windows pairing is not supported. For the Windows app and Chrome extension instructions, use the [README](../README.md#windows-11).

## Install and build from source

1. Install [Node.js](https://nodejs.org/en/download) 22.12 or newer, including npm. CI uses Node.js 22.
2. Install Xcode Command Line Tools, which include Git:

   ```sh
   xcode-select --install
   ```

3. Install the stable Rust toolchain from [rustup.rs](https://rustup.rs/). Open a new Terminal after installation. If Cargo is installed but unavailable in the current shell, load its environment:

   ```sh
   source "$HOME/.cargo/env"
   cargo --version
   ```

4. Clone the repository and build locally:

   ```sh
   git clone https://github.com/thegregoriancalendar/compusync.git
   cd compusync
   npm ci
   npm run native:build
   npm run native:smoke
   npm start
   ```

Future launches need only `npm start` from the checkout unless source/dependencies/native code changed. Build on each computer; do not copy Windows dependencies or native output. Apple Silicon uses `native/compusync-native.darwin-arm64.node`; Intel uses the corresponding `darwin-x64` addon. The smoke command checks that Node and Electron can load the local addon and recovery guard.

## First-run permissions

At startup, CompuSync checks these permissions and requests access during first-run onboarding when the native permission APIs are available:

| Privacy & Security setting | Purpose |
| --- | --- |
| Accessibility | Shared input and native Chrome window detection/positioning. |
| Input Monitoring | Mouse/keyboard capture while cursors are linked. |
| Automation → Google Chrome | Reading and recreating Chrome tabs. |

Use the setup notice's action to open the relevant **System Settings → Privacy & Security** pane. Source runs may be attributed to Electron or the launching Terminal/IDE; grant the application macOS identifies. Fully quit and reopen CompuSync after a permission change if the state remains stale. Closing settings leaves the menu-bar process running; use **Quit on this laptop** to stop it.

Denied permissions remain visible in settings. Rebuild the native addon if the app reports that native permission checks are unavailable; an old/missing addon cannot request the current onboarding permissions. Approval of Chrome Automation does not grant recording, Messages, or Full Disk Access.

## Chrome handoff on Mac

Install Google Chrome and approve its Automation permission. **No Chrome extension, Developer-mode extension installation, or native messaging host is required on the Mac.**

For scroll positions, nested scroll areas, ordinary form drafts, checkbox/selection state, and expanded details to follow a window, enable **Chrome → View → Developer → Allow JavaScript from Apple Events**. This Chrome preference is separate from macOS Automation permission. Basic tab/URL handoff works without it; page-state capture shows a setup notice when the preference is disabled. CompuSync does not enable it on the user's behalf.

Drag a normal supported Chrome window through the linked seam. Releasing while it spans both computers leaves both portions visible. Pick up either portion to continue; the other window closes only after a completed handoff fully onto one computer. Maximized/fullscreen Chrome transfers without a live straddle. Unsupported applications remain local.

Tab order, pinning, and active tab are preserved where supported. Chrome's Mac automation API does not expose the full back/forward stack; retained history is discarded after navigation or tab reordering. Page-state transfer is best effort, not continuous interaction synchronization. Passwords, cookies, storage, file inputs, and website login sessions are not copied; sign into sites separately on each computer.

## Pair and arrange the computers

1. Start both apps. Choose **Share from here** on one and enter its eight-character code under **Join other laptop** on the other.
2. Wait for **Connected** on both. A saved pairing alone is not a live connection.
3. Use **Screen layout** to match the physical arrangement and alignment. Two Macs use left/right placement with both top/menu-bar edges reserved. A mixed pair also supports Windows below the Mac.
4. Select **Link cursors**. Cmd+Shift+Y moves ownership to the other computer; Cmd+Shift+U toggles linking and restores local input when unlinking.

Discovery uses UDP 43188 and the direct connection normally uses TCP 43187. If discovery is blocked, use **Connection help** to enter the sharing computer's address. Saved reconnect retries its recorded address; a changed host address may require fresh pairing/discovery or manual entry. Both apps must remain running.

Activating CompuSync opens **Connection & settings**. Closing settings leaves the menu-bar app running; Cmd+, reopens it. Latency Monitor is a separate page within settings. The optional Windows Messages Companion and temporary Chrome seam overlay are current features; the old shared desktop/workspace/editor are retired.

## Optional audio sharing

Either Mac can send in a Mac pair; either computer can send in a mixed pair. Mac system-audio capture requires **macOS 14.6 or newer** and **System Audio Recording** approval when capture first starts. If access was denied, check **Privacy & Security → Screen & System Audio Recording**, fully quit the source app, and retry.

In **Audio manager**, choose playback outputs and start sharing from the source. Cursor linking can remain off. Choose full stereo or split stereo by screen layout; stop sharing before changing mode. Volume controls affect the selected devices' system volume. Start with built-in or wired outputs, and use the [audio guide](audio-routing.md) for permission identity, launch troubleshooting, Windows sender setup, and physical timing tests. Windows requires standard VB-CABLE only when it sends audio.

## Optional Messages Companion

On Windows, open **Messages Companion…** from CompuSync's system tray menu after pairing with the Mac. Conversations and history come from the Mac's Messages database in read-only mode. Contact names come from locally synced Contacts databases; only names for conversation participants are sent to Windows.

On the Mac, grant **Full Disk Access** to the application running CompuSync: Terminal for `npm start` launched in Terminal, the relevant IDE for an IDE launch, or CompuSync for an installed build. Fully quit the running app and restart it after changing access. A second launch while an older menu-bar instance is running activates the existing process instead of replacing it.

Approve **Automation → Messages** when sending is requested. Full Disk Access and Messages Automation are separate permissions. If names are missing, verify the contacts exist in the Mac's Contacts app. The companion displays read/send errors; it cannot bypass OS permissions.

## Updates and optional packages

Source installations update through Git and a local rebuild; follow [Update a source installation](../README.md#update-a-source-installation). A Mac has no Chrome extension to reload. Windows users must reload their managed extension after the updated app restages it.

Optional local packages must be built on macOS:

```sh
npm run build
npm run dist:mac
```

`build` produces an unpacked app bundle; `dist:mac` produces a DMG and ZIP in `dist/`. These commands build the Rust addon for the local toolchain and name it for Node's architecture. Use matching native Node/Rust toolchains on the intended Mac architecture. Passing `--x64` or `--arm64` to Electron Builder alone does not cross-compile the addon or recovery guard; build on the matching architecture or implement/test cross-compilation first.

Signing/notarization and hosted installer updates are separate from running source locally. See the [optional release guide](releases.md); package configuration does not establish that a downloadable signed release exists.

## Verify on the intended Macs

Use the [acceptance checklist](testing.md), including both host roles for Mac-to-Mac and Mac-to-Windows. Native input, trackpad held drags, Retina/mixed-scale placement, permission identity, Chrome setup/state transfer, network discovery, suspend/wake, audio alignment, and packaged launch behavior require real-device evidence. Same-machine Electron tests cannot establish these results.
