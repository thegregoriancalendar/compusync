# Run CompuSync on a Mac

CompuSync runs locally on both computers. The Mac application presents its crop of one logical shared window and can import Mac files into the host-owned workspace. A Windows `.exe` cannot run on macOS.

## Run from source

1. Copy or clone the complete repository onto the Mac.
2. Install Node.js 22.12 or newer, Xcode Command Line Tools (`xcode-select --install`), and the stable Rust toolchain from [rustup.rs](https://rustup.rs) if they are not already installed.
3. Open Terminal in the repository directory containing `package.json`.
4. Install the Mac-specific dependencies and start CompuSync:

   ```sh
   npm ci
   npm run native:build
   npm run native:smoke
   npm start
   ```

Install dependencies and build the native addon on the Mac. Do not copy the Windows `node_modules` directory or native build output. Electron and the Rust build select the current Mac architecture.

## Connect to Windows

1. Keep both computers on the same Wi-Fi or wired local network and run CompuSync on each.
2. Decide which computer will host. The host owns the persistent workspace and runs the bundled text editor.
3. On the host, choose **Share from here** and copy its eight-character code.
4. On the other computer, choose **Join other laptop**, enter the code, and select **Connect laptops**.
5. On the host, set **Where is the other laptop?** to match the physical arrangement. If the Mac is physically right of a Windows host, choose **To my right** on Windows. The host setting defines the seam.
6. Select **Open shared window**. The complete surface initially appears on the host; the other computer does not show a duplicate.

Automatic discovery uses local UDP port 43188 and the direct connection normally uses TCP port 43187. If discovery is blocked, expand **Connection help** and enter the host's displayed address and port on the joiner. Allow the app's local-network connection if macOS or the network firewall prompts for it.

## Use the Mac crop

Grab the shared bar at the very top of the frameless surface. As it crosses the configured seam, Windows and macOS show complementary pieces of one unchanged logical scene. Continue holding the same trackpad after the Mac crop becomes narrow; Pointer Lock should allow the drag to finish. Press Escape during a bar drag to return to its starting position.

When the surface is entirely on the other computer, use **Bring window here** from the Mac menu-bar item or settings. CompuSync does not capture global Mac input when it has no visible fragment.

Within the desktop, moving controls the shared cursor. Click the desktop for continuous relative input and press Escape to release it. `Cmd+,` opens settings, `Cmd+W` closes the shared surface, `Cmd+Shift+O` opens it, and `Cmd+Shift+Enter` brings it to the Mac.

## Chrome history limitation

Chrome's public Apple Events interface exposes a tab's current URL, title, and
loading state, but not its back/forward navigation entries or current history
index. CompuSync does not ask you to enable Chrome's disabled-by-default
**JavaScript from Apple Events** setting. When a history-bearing window arrives
from Windows, CompuSync retains that bounded history metadata for a later round
trip while each prepared tab remains at the same indexed URL. Navigating or
rearranging a tab on the Mac discards its retained metadata instead of restoring
a stale history. Chrome's native Back/Forward stack cannot be exactly recreated
or inspected through Apple Events alone.

## Import and edit files

- Select **Import** to choose files from the Mac, or drop files or directories into the desktop. If Windows hosts, Mac imports are copied over the encrypted data channel into the Windows profile's workspace.
- Use **New Folder**, **Rename**, **Delete**, and the breadcrumb controls to organize and browse the host workspace.
- Double-click a valid UTF-8 text file no larger than 2 MiB to open the bundled host text editor. When Windows hosts, the editor runs in Windows and its JPEG interface appears in the Mac crop. Mac mouse, wheel, keyboard, and save input is validated and forwarded to it.
- Saved document bytes persist on the host. Moving the window does not restart the running editor.

The text editor is the only supported program. CompuSync does not run arbitrary Windows or macOS applications, application bundles, or executables inside the surface, and it does not provide virtual-machine isolation.

## Build a Mac application

Run packaging on macOS:

```sh
# DMG and ZIP for the current Mac architecture
npm run dist:mac

# Explicit architecture
npm run dist:mac -- --arm64
npm run dist:mac -- --x64
```

Outputs are written to `dist/`. Development packages are unsigned. Test them according to your organization's Gatekeeper policy; production distribution requires the appropriate Apple signing and notarization workflow. The offscreen bundled editor does not capture arbitrary native applications, so it should not require Screen Recording or Accessibility access for that feature.

## Mac verification still required

The implementation has Windows/local automation and a passing hosted macOS Electron suite, but it has not been physically accepted on the intended Mac. Before release, complete [the Windows and Mac acceptance checklist](testing.md), especially:

- Retina and Windows mixed-scale crop alignment;
- Pointer Lock and the transparent capture keeper after the source crop disappears;
- top-bar dragging in both directions with macOS as host and as peer;
- real network discovery, firewall prompts, weak Wi-Fi, and interrupted imports;
- peer editing and saving to each host operating system;
- sleep/wake, reconnect, menu-bar behavior, and start at sign-in;
- DMG and ZIP launch behavior on the target Mac architecture.
