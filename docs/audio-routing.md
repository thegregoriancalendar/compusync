# Audio routing: first Mac-to-Windows test

The Electron settings window controls a Rust audio engine in the existing native addon. This first version mirrors the Mac's current default output to a selected Windows playback device. Sound continues on the Mac; the Windows copy has a small delay. Reverse routing, muting the source, and synchronized playback through both sets of speakers are subsequent work.

## Prepare both laptops

Use the same current source revision on both laptops. Quit any running CompuSync instance before rebuilding: Windows locks a loaded native addon.

On Windows:

```powershell
npm ci
npm run native:build
npm start
```

On a Mac running **macOS 14.6 or newer**:

```sh
npm ci
npm run build
```

Open the resulting **CompuSync.app** under `dist/mac*`. The packaged app includes `NSAudioCaptureUsageDescription`, which is required for Core Audio system recording. The stock Electron bundle used by `npm start` does not include that description; capture from that bundle is deliberately refused with an actionable message. Local development packages may need the usual macOS approval to open an unsigned app.

For this first test, set the Mac's system sound output to **built-in speakers**. The current capture backend supports output-only devices. Duplex devices such as some headsets expose a microphone through the same device; CompuSync refuses to open those for capture. The feature never opens a microphone or records the screen.

## Test

1. Pair the laptops normally and wait for **Connected**. Cursor linking is independent of audio and can stay off.
2. On Windows, open **Connection & settings → Audio manager**. Choose **Refresh devices**, then select the Windows speakers or headphones you want to hear.
3. Play music or a video on the Mac through its built-in speakers.
4. In the Mac's **Audio manager**, select **Play Mac audio on Windows**. Approve macOS **System Audio Recording** access when prompted. The setting is under **Privacy & Security → Screen & System Audio Recording**; its name varies across macOS versions. If permission changes require a restart, quit and reopen CompuSync.
5. Confirm the audio plays on the Mac and the selected Windows device. Both managers should report that sharing is active. Listening only to the Windows output makes the stream easier to assess because local Mac playback is earlier.
6. Stop sharing from either laptop. Windows should stop immediately while Mac playback continues.
7. Choose another Windows output while sharing is stopped, then start again from the Mac. The selected Windows device is saved locally.
8. Test stopping during startup, denying Mac audio permission, unplugging the selected Windows device, closing settings while audio plays, disconnecting the network, sleep/wake, and quitting either app. A failed or disconnected route stops. Reconnecting does not silently restart capture; start again from the Mac.

## Connection and format

Device I/O, sample conversion, packet encryption/decryption, resampling, buffering, and playback all run in Rust. Electron exchanges only bounded negotiation messages and status through the existing authenticated connection. Receiver keys are random and fresh for every route; endpoint addresses come from the paired connection rather than peer-supplied hostnames.

The first transport sends 48 kHz, 16-bit stereo PCM over a separate direct UDP socket, with AES-256-GCM authentication and encryption. Five-millisecond packets fit below a typical LAN MTU. A bounded jitter buffer reorders packets, rejects replayed sequences, and inserts silence for loss. Audio callbacks use bounded lock-free queues and do not invoke JavaScript. The Windows output is converted to the device's native sample rate and channel layout, with a small rate adjustment to keep its queue bounded.

PCM uses about **1.6 Mbit/s** including audio packet headers, before UDP/IP overhead. This is intended for the existing local-network pairing. It does not use a cloud service or relay. Allow CompuSync through the Windows firewall on the private network; audio uses a negotiated ephemeral UDP port in addition to the existing pairing/control ports. Weak Wi-Fi can cause gaps. Stop and restart sharing after changing the Mac's source output or a default Windows output. Explicitly selected unavailable outputs produce an error rather than playing through an unexpected device.

## Verification boundary

Automated checks cover encryption/tampering, packet reordering/replay/loss, sample conversion, native sender/receiver socket delivery, authenticated negotiation in either pairing host role, cancellation, disconnect recovery, and the Windows settings controls. Mac code can be type-checked from Windows with the Apple target installed. Actual Core Audio capture, permission prompts, physical output selection, Windows firewall behavior, and audible quality require this test on the two computers.
