# Run CompuSync on a Mac

CompuSync runs natively on both computers. On the Mac it provides the menu-bar/settings UI, native shared-cursor input, and Chrome handoff. The legacy shared surface, workspace, and bundled editor are retired and are never created.

## Run from source

1. Install Node.js 22.12 or newer.
2. Install Xcode Command Line Tools:

   ```sh
   xcode-select --install
   ```

3. Install the stable Rust toolchain from [rustup.rs](https://rustup.rs). If `npm run native:build` reports `spawnSync cargo ENOENT`, Cargo is missing or is not on the shell's `PATH`. After installing Rust, open a new Terminal or load it in the current shell:

   ```sh
   source "$HOME/.cargo/env"
   cargo --version
   ```

4. In the repository directory, install, build, verify, and start:

   ```sh
   npm ci
   npm run native:build
   npm run native:smoke
   npm start
   ```

Build the native addon on the Mac. Do not copy Windows `node_modules` or native output. Apple Silicon produces `native/compusync-native.darwin-arm64.node`; Intel produces the corresponding `darwin-x64` addon. A Windows `.exe` cannot run on macOS.

## Grant macOS permissions

CompuSync uses:

- **Accessibility** to detect and position Chrome windows and to participate in native input recovery.
- **Input Monitoring** so either computer's mouse and keyboard can drive the shared cursor.
- **Automation** for Chrome tab handoff. This prompt is deferred until the first eligible Chrome crossing.

Use the action in the settings notice to open the relevant System Settings pane. If macOS still shows the old permission state after granting access, fully quit and reopen CompuSync. Do not enable Chrome's **JavaScript from Apple Events** setting; CompuSync does not require it.

## Connect and link

1. Run the same current CompuSync revision on both laptops and keep them on the same local network.
2. On one computer, choose **Share from here** and copy its eight-character code.
3. On the other, choose **Join other laptop**, enter the code, and select **Connect laptops**.
4. Wait for **Connected** on both computers. A saved pairing alone is not a live connection.
5. Under **Screen layout**, choose the arrangement matching the desk and adjust the alignment offset if needed.
6. Select **Link cursors**.

Automatic discovery uses UDP port 43188 and the direct connection normally uses TCP port 43187. If discovery is blocked, use **Connection help** to enter the host address. Allow local-network access if macOS or a firewall prompts for it.

There is no **Open shared window** step. Starting or activating CompuSync opens only **Connection & settings**. Closing settings leaves the menu-bar process running, and Cmd+, reopens it.

## Use the Mac cursor and Chrome

Move through the configured left, right, or bottom seam to transfer cursor and keyboard ownership. Cmd+Shift+Y transfers ownership directly. Cmd+Shift+U unlinks immediately and restores local input.

Drag a normal Chrome window through the seam to hand it to the other computer. CompuSync prepares a native destination Chrome window, preserves its supported tab state, and commits based on which side contains most of the window when released. Maximized and fullscreen Chrome use an instant transfer; unsupported windows remain local.

Chrome's public Apple Events interface exposes current tab state but not the complete native back/forward entry collection. CompuSync retains bounded history metadata only while the prepared tabs remain unchanged. Navigating or rearranging tabs on the Mac discards retained metadata instead of restoring stale history.

## Build a Mac application

Run packaging on macOS:

```sh
# DMG and ZIP for the current Mac architecture
npm run dist:mac

# Explicit architecture
npm run dist:mac -- --arm64
npm run dist:mac -- --x64
```

Outputs are written to `dist/`. Development packages are unsigned. Production distribution requires the appropriate Apple signing and notarization workflow.

## Physical verification

Hosted automation cannot prove actual Windows-to-Mac behavior. Before release, complete [the acceptance checklist](testing.md), especially:

- cursor ownership and input recovery in both directions;
- Retina and Windows mixed-scale seam alignment;
- Accessibility, Input Monitoring, and Automation denial/remediation;
- Chrome transfer, reversal, and failure recovery;
- real network discovery, firewall prompts, weak Wi-Fi, and reconnect;
- sleep/wake, display hotplug, menu-bar behavior, and start at sign-in;
- DMG and ZIP launch behavior on the target architecture;
- confirmation that the retired shared surface never appears.
