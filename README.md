# CompuSync

Use two computers as one connected desk. CompuSync shares your cursor, keyboard, copied text, Chrome windows, and audio over your local network.

Supported pairs: **Mac ↔ Mac** and **Mac ↔ Windows 11**. Windows-to-Windows pairing is not supported yet. Install and run CompuSync on both computers.

## Features

- **Shared mouse and keyboard:** move across the screen seam to control the other computer, with adjustable screen layout, acceleration, and edge resistance.
- **Text clipboard sharing:** copy text on either computer and paste it on the other.
- **Chrome window handoff:** drag supported Chrome windows between computers, preserving tabs, pinning, and supported history and page state.
- **Synchronized audio:** share audio in either direction, play full stereo on both computers or split left/right channels, and adjust each computer's volume.
- **Messages Companion:** read and send messages from Windows through your paired Mac, including contact names from the Mac.
- **Local connection and recovery:** pair with an eight-character code, without a cloud account or relay; input returns to local control after unlinking or a connection failure.

## Install and run

These instructions build CompuSync from source. Use the same current revision on both computers, and build separately on each one. Keep both on the same local network. Install [Google Chrome](https://www.google.com/chrome/) on both computers if you want Chrome window handoff.

### macOS

Install these prerequisites:

- [Node.js](https://nodejs.org/en/download) **22.12 or newer**, including npm. CI uses Node.js 22.
- The stable [Rust toolchain](https://rustup.rs/), including Cargo.
- Xcode Command Line Tools, which also provide Git:

```sh
xcode-select --install
```

After installing the tools, open a new Terminal window and run:

```sh
git clone https://github.com/thegregoriancalendar/compusync.git
cd compusync
npm ci
npm run native:build
npm run native:smoke
npm start
```

The first build can take several minutes. Future launches only need `npm start` from the `compusync` directory.

#### Allow macOS permissions

Follow CompuSync's setup prompts. You can also manage access in **System Settings → Privacy & Security**:

| Permission | Used for |
| --- | --- |
| Accessibility | Shared input and detecting/positioning Chrome windows. |
| Input Monitoring | Reading mouse and keyboard input for cursor linking. |
| Automation → Google Chrome | Reading and recreating Chrome tabs during handoff. |

Source builds may appear as **Electron** or the Terminal/IDE that launched them. Grant access to the application macOS identifies, then fully quit and restart CompuSync if the permission state has not updated. Closing the settings window leaves the menu-bar process running; use **Quit on this laptop** to stop it.

#### Chrome on Mac

**No Chrome extension is required on macOS.** CompuSync uses macOS Automation to communicate with Chrome.

For scroll positions and ordinary form drafts to follow a window, enable **Chrome → View → Developer → Allow JavaScript from Apple Events**. Tab and URL handoff still works without this optional setting.

### Windows 11

Install these prerequisites:

- [Git for Windows](https://git-scm.com/downloads/).
- [Node.js](https://nodejs.org/en/download) **22.12 or newer**, including npm. CI uses Node.js 22.
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/) with the **Desktop development with C++** workload, including the MSVC compiler and Windows SDK.
- The stable [Rust toolchain](https://rustup.rs/) for Windows using MSVC. Follow the installer's compiler prerequisite prompts.

Open a new **PowerShell** window after installing the tools. Run CompuSync directly on Windows, outside WSL:

```powershell
git clone https://github.com/thegregoriancalendar/compusync.git
cd compusync
npm ci
npm run native:build
npm run native:smoke
npm start
```

The native build also creates the helper used by the Chrome extension. Future launches only need `npm start` from the `compusync` directory.

If Windows Firewall asks, allow CompuSync/Electron on your **private network** so the computers can discover and connect to each other.

#### Install the Chrome extension on Windows

The **CompuSync Tab Bridge** extension is required for Chrome window handoff on Windows. It is loaded locally from the files included with CompuSync.

1. Start CompuSync and accept **Set up Chrome window handoff → Open setup**. If you previously skipped setup, try handing off a Chrome window to bring the prompt back.
2. CompuSync opens `chrome://extensions` and shows its prepared `chrome-extension` folder in File Explorer.
3. In Chrome, enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the **chrome-extension folder** that CompuSync opened—the folder containing `manifest.json`.
5. Confirm **CompuSync Tab Bridge** appears and is enabled. Install it in the Chrome profile you use for handoff; keep CompuSync running.

Use the prepared folder, normally `%APPDATA%\CompuSync\chrome-extension`. CompuSync refreshes its contents on startup and registers the native helper automatically. Keep this folder in place while the extension is installed.

The extension source lives in [`src/main/adapters/chrome/extension/`](src/main/adapters/chrome/extension/). Loading that source folder alone does not register the native helper; start CompuSync and use its setup flow. The extension requests tab, debugger, and native messaging permissions to capture/restore Chrome state and communicate with the local app. See [Chrome's unpacked-extension instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked) for the browser steps.

The extension is only needed for Chrome handoff. Cursor, keyboard, clipboard, and audio sharing do not require it.

## Connect the computers

1. Start CompuSync on both computers and open **Connection & settings** from the menu bar or Windows system tray.
2. On one computer, choose **Share from here** and copy its eight-character code.
3. On the other, choose **Join other laptop**, enter the code, and select **Connect laptops**.
4. Wait until both computers report **Connected**. A saved pairing alone does not mean the connection is live.
5. Under **Screen layout**, arrange the screens to match your desk and adjust their alignment. For two Macs, place the computers left/right; the top/menu-bar edges remain reserved.
6. Select **Link cursors**.

Keep both apps running. A saved pair reconnects when both computers are available on the same network. Control messages are authenticated and encrypted. If discovery fails, expand **Connection help** and enter the host address shown on the sharing computer. Discovery uses UDP port **43188**; the direct connection normally uses TCP port **43187**. Guest Wi-Fi or client isolation can prevent the computers from reaching each other.

## Everyday use

Move through the configured screen seam to transfer cursor and keyboard ownership. Either computer's mouse or trackpad can move the shared cursor. Clipboard sharing copies newly copied **plain text** while connected; images and files are not synced. You can disable it with **Sync copied text between laptops** in settings. Synced text can also appear in each operating system's clipboard history.

| Shortcut | Action |
| --- | --- |
| Cmd/Ctrl+Shift+Y | Move the shared cursor to the other computer. |
| Cmd/Ctrl+Shift+U | Toggle cursor linking; unlinking restores local input immediately. |
| Cmd+, on Mac / Ctrl+, on Windows | Open Connection & settings. |

Drag a supported Chrome window through the seam to hand it off. Normal windows can straddle both desktops; fullscreen or maximized windows transfer without a live straddle. Page-state transfer is best effort. Passwords, cookies, file inputs, and website login sessions are not copied, so sign into sites independently on each computer. Chrome's macOS automation API does not expose its full back/forward history.

### Share audio

Open **Connection & settings → Audio manager** on both computers, choose playback outputs, and start sharing from the source. Only one direction runs at a time. Cursor linking can remain off.

- **Mac as source:** requires **macOS 14.6 or newer** and approval for System Audio Recording. If denied, check **Privacy & Security → Screen & System Audio Recording**, then restart the app.
- **Windows as source:** install the standard [VB-CABLE driver](https://vb-audio.com/Cable/) and reboot as its installer instructs. Driver installation needs administrator access; normal CompuSync use does not. Receiving audio on Windows does not require VB-CABLE.
- **Playback:** use built-in or wired speakers to start. Choose full stereo or **Split stereo by screen layout**; stop sharing before changing modes. The volume sliders control the selected outputs' system volume.

See the [audio setup and troubleshooting guide](docs/audio-routing.md) for routing, recording-permission issues, and timing limitations. Stopping sharing restores normal source playback.

### Use Messages Companion

For a Mac–Windows pair, right-click CompuSync's Windows system tray icon and choose **Messages Companion…** after connecting.

On the Mac, grant **Full Disk Access** to the app running CompuSync—Terminal when launched with `npm start` in Terminal, or the relevant IDE/installed app. Fully quit and reopen it after changing access. Approve **Automation → Messages** when prompted to send a message. Conversations and contact names come from the paired Mac; sending uses its Messages app.

## Update a source installation

Fully quit CompuSync on both computers before rebuilding. On Windows, a running process locks the native addon. In each computer's checkout, run:

```sh
git pull --ff-only
npm ci
npm run native:build
npm run native:smoke
npm start
```

On **Windows**, after CompuSync restarts, open `chrome://extensions` and click **Reload** on **CompuSync Tab Bridge** to load the refreshed extension files. Source installations update manually; the packaged-app automatic updater does not run for `npm start`.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| `cargo` not found | Install Rust and open a new terminal. On Mac, load an existing install with `source "$HOME/.cargo/env"`. |
| Windows compiler/linker errors | Install the C++ workload and Windows SDK in Visual Studio Build Tools; use the MSVC Rust toolchain. |
| PowerShell blocks `npm.ps1` | Use `npm.cmd` in place of `npm`, for example `npm.cmd ci` and `npm.cmd start`. |
| Native addon missing or incompatible | Quit CompuSync, rebuild on that computer with `npm run native:build`, and run `npm run native:smoke`. Do not copy `node_modules` or native builds between operating systems or architectures. |
| Mac cursor or Chrome handoff unavailable | Check Accessibility, Input Monitoring, and Chrome Automation permissions, then fully quit and restart. |
| Windows Chrome helper disconnected | Keep CompuSync running, check that Tab Bridge is enabled in the correct profile, and reload it. If the checkout moved, restart CompuSync to refresh the helper registration. |
| Computers cannot find each other | Check the local network and firewall, then use Connection help to enter the host address manually. |

`npm start` writes `compusync.log` in the checkout. While paired, each computer also saves the other's shared logs in `compusync-peer.log`. These files are ignored by Git; review them for private information before sharing them in a bug report.

## Development

```sh
npm run check        # JavaScript syntax checks
npm test             # Unit and integration tests
npm run test:native  # Rust and native adapter tests
npm run test:e2e     # Electron end-to-end tests
```

CI checks macOS and Windows. Physical input, permission prompts, audio alignment, and sleep/wake recovery still need testing on real computers; see the [acceptance checklist](docs/testing.md).

Optional local application bundles can be built with `npm run build`. Installer packaging and signing are documented in the [release guide](docs/releases.md). Architecture and design notes are in [docs/DESIGN_CHOICES.md](docs/DESIGN_CHOICES.md).

## Documentation

See the [documentation index](docs/README.md) for current setup, audio, testing, design, and contributor guides. The [Mac setup guide](docs/mac-setup.md) expands on permission identities and optional features. Earlier shared-desktop plans and verification reports are explicitly labeled as historical; they do not describe the current app or prove the current revision has passed device testing.
