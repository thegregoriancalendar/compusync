# Synchronized audio between two Macs or Mac and Windows

The Electron Audio manager controls a Rust audio engine. Either laptop in a Mac-to-Mac or Mac-to-Windows pair can send. CompuSync suppresses the source's immediate playback and renders a delayed copy on both laptops against the same presentation timeline. Mac uses a muted Core Audio tap. Windows uses WASAPI loopback on a dedicated VB-CABLE virtual output and pins delayed playback to physical speakers. Stopping restores ordinary source playback. Only one direction runs at a time. Windows-to-Windows pairing is not supported.

## Prepare both laptops

Install the platform prerequisites from the [README](../README.md#install-and-run), and use the same current source revision on both laptops. Quit any running CompuSync instance before rebuilding: Windows locks a loaded native addon. Audio protocol v4 requires rebuilding the addon on **both** computers; older addons cannot advertise synchronized audio. Audio protocol version 4 is separate from the session handshake and package version. The Chrome extension is only needed for Windows Chrome handoff, not for audio routing.

On Windows and on a Mac running **macOS 14.6 or newer**:

```sh
npm ci
npm run native:build
npm run native:smoke
npm start
```

Use **built-in or wired speakers** for the first test. Outputs with a predicted device lead above 100 ms are refused; Bluetooth and other devices with variable downstream latency are outside the initial verification target. The Mac tap follows its selected output device. It never opens a microphone or captures the screen.

No extra npm flag is needed. Normal app operation does not require administrator access; the one-time Windows driver installation does. The pinned Electron runtime includes `NSAudioCaptureUsageDescription`. [macOS requests System Audio Recording permission the first time recording starts](https://developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps), after creating the tap and aggregate device. Creating the tap alone does not trigger the prompt. During development the prompt may name Electron or the terminal/IDE that launched it; packaged builds use CompuSync. After a denial, enable the relevant entry in **System Settings → Privacy & Security → Screen & System Audio Recording**, then fully quit and restart the app.

If `npm start` never produces a prompt, the launching terminal or IDE may lack its own audio usage description. [Electron documents the parent-application requirement](https://www.electronjs.org/docs/latest/api/desktop-capturer#macos-versions-142-or-higher). Quit the development app and launch its bundle through macOS Launch Services from the project root:

```sh
open -n -a "$PWD/node_modules/electron/dist/Electron.app" --args "$PWD"
```

This launch bypasses npm's log redirection. Alternatively, use `npm run build` and open CompuSync.app under `dist/mac*`. Each permission identity needs its own approval.

## Device volumes

The Audio manager has separate, named laptop volume sliders with percentage
readouts and mute status. Either laptop can adjust both outputs while paired;
local volume also works while disconnected and without starting audio sharing.
The sliders control the output devices' system volume, so other apps using those
outputs are affected too. Changes made with the system volume controls appear
within about one second. Windows follows the selected playback output, including
the physical output pinned by an active sharing route. Outputs without software
volume control show a disabled slider and an explanation.

Volume controls require the updated native addon on both laptops. Rebuild with
`npm run native:build` after quitting CompuSync, then restart it.

## Split stereo by screen layout

In Audio manager, choose **Playback mode → Split stereo by screen layout** on the
source laptop, then start sharing. The laptop whose **main display** is farther
left in Screen layout plays the left channel; the other plays the right channel.
Each assigned channel plays through both front speakers on that laptop, including
when its physical output is mono. Full stereo on both laptops remains the default.
The existing shared playback schedule, output selection, and volume controls apply
to both modes. Either Mac or Windows can be the source; Windows sending still
requires VB-CABLE.

For two Macs, update both apps. Negotiation assigns channels and volume controls
by computer ID, so identical OS types and computer names remain separate. Either
Mac can send; the receiving Mac uses its selected output. The source Mac uses its
system default output for delayed local playback. Arrange the Macs left/right,
since both top/menu-bar edges are reserved. Windows-to-Windows is unavailable.

Assignments include the main display's position inside a multi-monitor computer
group and follow saved layout changes while sharing. The source negotiates both
assignments; live channel swaps occur as each laptop processes the update, rather
than as a scheduled simultaneous transition. If the two main displays have the
same horizontal center, split stereo cannot start. Moving to that arrangement
while sharing stops the route; offset a display left or right and start again.
Stop sharing before changing playback mode. The source's selection is saved for
its next start; the receiver displays the active route's mode.

Update and rebuild the native addon on **both** laptops with
`npm run native:build`, then restart CompuSync to enable split stereo. A peer or
addon without split support can still use full stereo. Verify with a track that
alternates left-only and right-only sound, swap the computers in Screen layout,
and repeat with either source. Automated channel isolation and negotiation tests
do not replace listening on both physical outputs.

## Windows sender setup

Windows needs the **standard VB-CABLE** driver; receiving Mac audio does not. Download it from [VB-Audio](https://vb-audio.com/Cable/), extract the package, run its installer as administrator, and reboot as the vendor instructs. CompuSync does not install or redistribute the driver. The Audio manager links to that same official download page.

Keep physical speakers/headphones selected as both Windows default output and default communications output before starting. In Audio manager, refresh devices, choose physical local playback, and leave capture bus on Detect standard VB-CABLE. The bus is verified using the driver interface and endpoint description, not an editable display name; Cable A/B, C/D, Voicemeeter, and arbitrary virtual drivers are not yet supported.

Apps must use **System default** in shared mode. Restart playback after sharing starts if an app does not follow output changes. Avoid exclusive/ASIO playback and protected audio. Disable Windows **Listen to this device**, direct hardware monitoring, or any other monitor of CABLE Output; these would add an unscheduled copy. Leave the virtual cable unmuted and its volume at 100%; CompuSync does not change endpoint volume or mute. Use the physical playback slider to adjust local loudness. After a two-second migration grace period, CompuSync samples audio-session peak meters on non-bus outputs. Silent sessions do not trigger a notice. Nonzero activity produces an advisory in Audio manager with the executable name and PID (or Windows system sounds), and clears when the activity disappears. It does not stop sharing: Windows also lists loopback recorders here, and their meters can reflect the scheduled playback they are recording. Session activity cannot prove that an app is bypassing the capture bus. Explicitly routed playback remains outside the synchronized mix; set playback apps to System default if sound is missing or doubled. Device removal, unexpected default changes, capture failure, and lost heartbeats still stop sharing and restore defaults.

Windows does not show an audio-recording permission dialog for WASAPI output loopback. Firewall approval can still be needed. If formats are unsupported, select stereo 48 kHz in the capture bus's advanced Windows Sound properties.

## Test

1. Pair the laptops and wait for Connected. Cursor linking can remain off.
2. On both laptops, open Connection & settings → Audio manager, refresh devices, and choose an output.
3. Play a click track or music on the source laptop.
4. Start sharing on the source. For Mac sending, approve System Audio Recording. For Windows sending, finish VB-CABLE setup first. Clock negotiation and a valid physical playback clock are required before muting/rerouting; a short buffered startup gap is expected.
5. Confirm the original immediate source sound is replaced by delayed local playback, and both laptops follow the same schedule. The manager reports buffered delay, estimated network clock uncertainty, and recovery count. These values do not measure acoustic speaker alignment.
6. Stop from either laptop. Both scheduled outputs stop, and the source returns to ordinary immediate playback. Verify volume is unchanged. Windows restores each previous default output role; a default you changed manually while sharing is left alone.
7. Repeat start/stop, permission denial, cancellation while the permission dialog is open, unplugged outputs, default-device changes, settings closed, network loss, sleep/wake, and process exit. In particular, confirm ordinary source output returns after every failed start or stopped route. Disconnect and sleep stop sharing; reconnect never starts capture automatically.
8. Brief network jitter or a scheduling discontinuity should preserve the presentation timeline or trigger a new shared epoch. Late/lost audio becomes silence rather than shifting later audio. Larger failures stop the route with a retry message.

Audio buffering also delays sound relative to video playing independently on the source. This feature does not control the video player's timeline.

## Timing and recovery

The **Latency Monitor → Audio** section shows the active direction, scheduled capture-to-playback delay, audio clock-exchange round-trip time, clock uncertainty, and this laptop's playback schedule error. It also shows late packets and resynchronizations for the current route. Readings update every 500 ms once scheduled playback begins, clear when sharing stops or disconnects, and work while cursor linking is off. Scheduled delay and clock estimates do not measure acoustic speaker alignment or downstream Bluetooth latency.

- Both hosts use native monotonic clocks: mach_absolute_time on Mac and QueryPerformanceCounter on Windows. CPAL 0.18.2 output timestamps use those same host clock domains. Mac capture uses the native IOProc input timestamp, converted from mach host time. Windows capture uses WASAPI GetBuffer QPC timestamps (100 ns units converted to the same native QPC timeline), handles silent buffers, and requests resync on discontinuities.
- The source sends authenticated four-timestamp ping/pong exchanges. Startup requires eight valid observations and a best round-trip delay no higher than 10 ms, corresponding to at most 5 ms estimated network offset uncertainty. Models continue every 250 ms, using a recent bounded low-delay window. Small offset updates are slewed; large changes request a resynchronization.
- Every 5 ms audio block carries an epoch, its explicit transition time, first frame index, capture timestamp, and absolute playback timestamp in source host time. Reordering or losing the first packet cannot move the transition. Capture timestamps survive sample-rate conversion. Both local and remote outputs receive the same samples and deadlines.
- Shared delay is measured, with no fixed 150 ms starting floor. The source tracks capture-to-packet age, recent RTT, and its output scheduling horizon. Authenticated receiver feedback every 100 ms reports capture-to-arrival age and the remote output horizon. Each horizon includes predicted DAC lead plus one callback buffer period, covering packets that arrive just after a callback. With two-second peak windows, the budget is `max(capture age + local horizon, max(capture age + RTT/2, remote arrival age) + remote horizon + clock uncertainty) + 5 ms`. Delay is rounded up to milliseconds, with a 10 ms minimum and 500 ms supported limit. The receiver translates deadlines into its own clock domain. Each output uses CPAL's predicted DAC playback time to select samples. Driver predictions do not include unknown downstream Bluetooth or speaker latency.
- A device-clock servo adjusts sample consumption by at most ±0.2% to follow the timeline smoothly. Errors above 20 ms re-anchor the cursor and request a new epoch. It does not use independent queue fullness as its timing reference.
- Queues are bounded. A preallocated presentation buffer reorders packets; missing deadlines produce silence. Old packets are discarded without delaying subsequent samples. Callback code performs no allocation, locking, networking, or JavaScript calls.
- Recovery is owned by the source: a resync starts a new epoch without adding delay. Only measured timing costs increase the shared delay; changes below 2 ms are absorbed by the safety margin. After the measured target stays lower for three seconds, delay decreases by at most 5 ms every 500 ms. Increasing delay may introduce a short shared gap; decreasing it skips the same queued interval on both outputs at the explicit new epoch boundary. No output independently shortens its queue. Previously queued audio may play until that scheduled transition; late packets from retired epochs are rejected.
- Losing clock replies or receiver timing feedback for three seconds, losing established audio for five seconds, invalid device timestamps, or a device error stops the route. The source clock worker continues while the OS permission request is pending.
- The private, device-scoped Core Audio tap uses MutedWhenTapped and excludes CompuSync's audio process. That prevents capturing or suppressing our own delayed copy. Stopping/destroying the tap restores original playback without changing system volume or the default device.
- Capture opens the private aggregate directly using the AudioDeviceID returned by Core Audio. It does not search the public device list, where private devices are absent. Native input accepts 32-bit float PCM in interleaved, planar, or mono buffers; unsupported tap formats return an explicit error.

### Windows default-output recovery

A separate hidden recovery helper owns all three default-output changes (console, multimedia, communications). It saves each prior endpoint before switching, rolls back partial setup failures, checks endpoint availability/default changes, and restores on STOP, stdin EOF, or a three-second heartbeat timeout. Native capture sends heartbeats every 250 ms. A named mutex prevents overlapping routes. Capture errors and invalid/stalled timestamps stop playback and release the route even if Electron is unresponsive.

Windows can link console and multimedia defaults, so switching one can also switch the other. Setup validates all original roles before changing any, accepts roles already moved to the capture bus by a preceding switch, and verifies the complete route afterward. An unrelated output selection still aborts setup and is preserved during recovery.

The helper writes a recovery journal under the user's local app data directory (the folder is named `CompuSync`, file `audio-route.json`). If both processes are terminated, the next app launch/refresh attempts restoration before routing. It restores only roles still pointing at the recorded bus, preserves later user selections, and falls back to the pinned physical output if a previous output was unplugged. Failed restoration retains the journal for retry; if no physical output remains, choose one in Windows Sound settings. Do not manually kill the recovery helper during sharing.

Changing Windows defaults uses the isolated, undocumented IPolicyConfig interface, with activation checks and endpoint readback. Microsoft exposes no supported public API to set a user's default endpoint. This is a Windows compatibility boundary: validate default switching and recovery on supported Windows releases before distributing broadly. Apps still control whether they follow default-device changes. See Microsoft's [loopback documentation](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording) and [stream routing documentation](https://learn.microsoft.com/en-us/windows/win32/coreaudio/automatic-stream-routing).

## Transport and security

48 kHz, 16-bit stereo PCM travels over direct UDP, authenticated/encrypted with AES-256-GCM. Packets remain below 1200 bytes. Receiver keys are fresh for each route and negotiated over the existing encrypted paired connection. Endpoint IPs come from that connection; a UDP endpoint is pinned only after an authenticated clock request.

Protocol v4 uses separate sender/receiver nonce prefixes (CSS4/CSR4) and monotonically increasing counters covering control and audio packets. A 256-counter replay window accepts reordering and rejects duplicates. Timing feedback and metadata are authenticated. Older audio protocol versions are rejected. Rebuild the addon on both laptops for adaptive timing feedback and explicit epoch transitions.

PCM uses roughly 1.7 Mbit/s before UDP/IP overhead. Allow CompuSync through the Windows firewall on the private network; audio uses a negotiated ephemeral UDP port in addition to pairing/control ports. No cloud relay is used.

## Verification boundary and physical alignment

Automated coverage includes measured local/remote timing budgets, resync behavior, stable latency reduction, explicit epoch transitions when the first packet is lost or reordered, authenticated timing feedback and metadata, directional nonces, replay/reordering, clock-offset estimation, timestamp-preserving resampling, scheduled silence/loss handling, drift correction, UDP clock agreement, playback scheduling, cancellation, negotiation, and Electron controls. Some timing/device tests use simulated clocks or engines; inspect the test before treating it as a real-device result. Windows policy tests cover distinct default roles, partial rollback, user changes, unplugged originals, and restoration errors. Native missing-driver checks must not change defaults. Cross-compilation/type-checking for Mac cannot establish real capture, TCC prompts, or playback timing. Run the platform tests and [physical checklist](testing.md#synchronized-audio-in-either-direction) on the intended devices.

Earlier development notes reported native default-output switching/restoration with VB-CABLE on Windows and manual Mac-to-Windows capture before reverse routing was added. Those observations are not a fresh acceptance run of the current revision. The opt-in test in `native/windows-audio/tests/live_guard.rs` checks every role before and after a real route; it is ignored by default because it temporarily changes actual system outputs. Validate either sending direction, Mac-to-Mac routes, Windows capture/recovery, Mac receive playback, and physical alignment on the actual devices. Record the revision and results rather than inferring them from this guide. Device playback timestamps are predictions. The displayed clock uncertainty excludes driver errors, downstream device latency, and sound propagation.

For acoustic acceptance, record a periodic click from both outputs using two channels of one recorder/interface, with equal microphone distances or direct wired capture. Compare click sample positions at startup and throughout a long run, then repeat with network load and a forced resync. Report median, 95th percentile, maximum inter-output skew, dropouts, and recovery behavior. Define an acceptable measured skew for the specific devices before claiming an accuracy figure; automated clock tests do not prove sample-exact speaker alignment.
