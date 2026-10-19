# Synchronized Mac-to-Windows audio

The Electron Audio manager controls a Rust audio engine. While sharing, CompuSync captures the Mac's selected system output, suppresses its original immediate playback, and renders a delayed copy on both laptops against the same presentation timeline. Stopping sharing restores normal Mac output. Windows-to-Mac capture is not implemented yet.

## Prepare both laptops

Use the same current source revision on both laptops. Quit any running CompuSync instance before rebuilding: Windows locks a loaded native addon. Audio protocol v2 requires rebuilding the addon on **both** computers; older addons cannot advertise synchronized audio.

On Windows and on a Mac running **macOS 14.6 or newer**:

```sh
npm ci
npm run native:build
npm run native:smoke
npm start
```

Use **built-in or wired speakers** for the first test. Outputs with a predicted device lead above 100 ms are refused; Bluetooth and other devices with variable downstream latency are outside the initial verification target. The Mac tap follows its selected output device. It never opens a microphone or captures the screen.

No extra npm flag or administrator access is needed. The pinned Electron runtime includes `NSAudioCaptureUsageDescription`. macOS requests System Audio Recording permission when sharing starts. During development the prompt may name Electron or the terminal/IDE that launched it; packaged builds use CompuSync. After a denial, enable the relevant entry in **System Settings → Privacy & Security → Screen & System Audio Recording**, then fully quit and restart the app.

If `npm start` never produces a prompt, the launching terminal or IDE may lack its own audio usage description. [Electron documents the parent-application requirement](https://www.electronjs.org/docs/latest/api/desktop-capturer#macos-versions-142-or-higher). Quit the development app and launch its bundle through macOS Launch Services from the project root:

```sh
open -n -a "$PWD/node_modules/electron/dist/Electron.app" --args "$PWD"
```

This launch bypasses npm's log redirection. Alternatively, use `npm run build` and open CompuSync.app under `dist/mac*`. Each permission identity needs its own approval.

## Test

1. Pair the laptops and wait for Connected. Cursor linking can remain off.
2. On Windows, open Connection & settings → Audio manager, refresh devices, and choose an output.
3. Play a click track or music on the Mac.
4. Start sharing on the Mac and approve System Audio Recording. Clock negotiation finishes before the muted tap is opened; a short buffered startup gap is expected.
5. Confirm the original immediate Mac sound is replaced by delayed local playback, and both laptops follow the same schedule. The manager reports buffered delay, estimated network clock uncertainty, and recovery count. These values do not measure acoustic speaker alignment.
6. Stop from either laptop. Windows stops and the Mac returns to ordinary immediate playback. Verify the Mac's volume and default device settings were not changed.
7. Repeat start/stop, permission denial, cancellation while the permission dialog is open, unplugged outputs, default-device changes, settings closed, network loss, sleep/wake, and process exit. In particular, confirm ordinary Mac output returns after every failed start or stopped route. Disconnect and sleep stop sharing; reconnect never starts capture automatically.
8. Brief network jitter or a scheduling discontinuity should preserve the presentation timeline or trigger a new shared epoch. Late/lost audio becomes silence rather than shifting later audio. Larger failures stop the route with a retry message.

Audio buffering also delays sound relative to video playing independently on the Mac. This feature does not control the video player's timeline.

## Timing and recovery

- Both hosts use native monotonic clocks: mach_absolute_time on Mac and QueryPerformanceCounter on Windows. CPAL 0.18.2 device timestamps use those same host clock domains.
- The Mac sends authenticated four-timestamp ping/pong exchanges. Startup requires eight valid observations and a best round-trip delay no higher than 10 ms, corresponding to at most 5 ms estimated network offset uncertainty. Models continue every 250 ms, using a recent bounded low-delay window. Small offset updates are slewed; large changes request a resynchronization.
- Every 5 ms audio block carries an epoch, first frame index, capture timestamp, and absolute playback timestamp in Mac host time. Capture timestamps survive sample-rate conversion. Both local and remote outputs receive the same samples and deadlines.
- Initial shared delay is `clamp(120 ms + 4 × best RTT, 150 ms, 500 ms)`. The receiver translates deadlines into its own clock domain. Each output uses CPAL's predicted DAC playback time, rather than callback invocation or packet arrival time, to select samples.
- A device-clock servo adjusts sample consumption by at most ±0.2% to follow the timeline smoothly. Errors above 20 ms re-anchor the cursor and request a new epoch. It does not use independent queue fullness as its timing reference.
- Queues are bounded. A preallocated presentation buffer reorders packets; missing deadlines produce silence. Old packets are discarded without delaying subsequent samples. Callback code performs no allocation, locking, networking, or JavaScript calls.
- Recovery is owned by the Mac: a resync request starts a new epoch, clears stale capture data, and increases the shared delay by 25 ms up to 500 ms. Both outputs use the new packets' future deadlines. Previously queued audio may play until that scheduled transition; late packets from retired epochs are rejected.
- Losing clock replies for three seconds, losing established audio for five seconds, invalid device timestamps, or a device error stops the route. The Mac clock worker continues while the OS permission request is pending.
- The private, device-scoped Core Audio tap uses MutedWhenTapped and excludes CompuSync's audio process. That prevents capturing or suppressing our own delayed copy. Stopping/destroying the tap restores original playback without changing system volume or the default device.

## Transport and security

48 kHz, 16-bit stereo PCM travels over direct UDP, authenticated/encrypted with AES-256-GCM. Packets remain below 1200 bytes. Receiver keys are fresh for each route and negotiated over the existing encrypted paired connection. Endpoint IPs come from that connection; a UDP endpoint is pinned only after an authenticated clock request.

Protocol v2 uses separate Mac/Windows nonce prefixes and monotonically increasing counters covering control and audio packets. A 256-counter replay window accepts reordering and rejects duplicates. Timing metadata is authenticated. Old v1 datagrams and peers are rejected.

PCM uses roughly 1.7 Mbit/s before UDP/IP overhead. Allow CompuSync through the Windows firewall on the private network; audio uses a negotiated ephemeral UDP port in addition to pairing/control ports. No cloud relay is used.

## Verification boundary and physical alignment

Automated checks cover authenticated timing metadata, directional nonces, replay/reordering, clock-offset estimation, timestamp-preserving resampling, scheduled silence/loss handling, drift correction, epoch recovery, native UDP clock agreement, actual Windows device playback deadlines, cancellation, negotiation, and Electron controls. The Mac target is type-checked from Windows.

Actual Mac capture/muting, permission prompts, automatic restoration of original output, and physical alignment still require the two-laptop test. Device playback timestamps are predictions. The displayed clock uncertainty excludes driver errors, downstream device latency, and sound propagation.

For acoustic acceptance, record a periodic click from both outputs using two channels of one recorder/interface, with equal microphone distances or direct wired capture. Compare click sample positions at startup and throughout a long run, then repeat with network load and a forced resync. Report median, 95th percentile, maximum inter-output skew, dropouts, and recovery behavior. Define an acceptable measured skew for the specific devices before claiming an accuracy figure; automated clock tests do not prove sample-exact speaker alignment.