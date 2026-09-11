# Run CompuSync on your Mac

CompuSync runs locally on both computers. The grid works on Windows alone, but the Mac must also run CompuSync to receive the shared window or contribute its trackpad. The Windows `.exe` cannot run on macOS.

1. Transfer `CompuSync-0.1.2-source.zip` to your Mac and unzip it.
2. Install Node.js 22.12 or newer if you do not already have it. Use the macOS installer from [nodejs.org](https://nodejs.org/).
3. Open Terminal in the extracted project folder (the one containing `package.json`) and run:

   ```sh
   npm ci
   npm start
   ```

4. Keep both computers on the same Wi-Fi. In the Mac app's pairing screen, select **Join other laptop** and enter the code shown on Windows.
5. Set the direction of the other laptop on each computer. For example, if the Mac is on the right, choose **right** on Windows and **left** on the Mac.

These source instructions use the correct Electron runtime for your Mac, whether it has an Apple Silicon or Intel processor. Install dependencies on the Mac; do not copy the Windows `node_modules` folder.

Opening the app shows the pairing screen whenever it is not connected. To open pairing manually, press **Cmd+,** on the Mac or **Ctrl+,** on Windows, or use **Connection & settings…** in the menu bar/system tray.

You can later build a standalone Mac app by running `npm run dist:mac` on the Mac. The development build is unsigned. Cross-device operation still needs to be checked on your actual Mac; local verification so far uses Windows.
