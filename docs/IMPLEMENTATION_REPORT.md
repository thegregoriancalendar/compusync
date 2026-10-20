# CompuSync implementation status and verification scope

Reviewed against the working source on October 20, 2026. This document describes implemented paths and the evidence needed to accept them. It does not certify the current working tree, published artifacts, CI status, physical devices, or every target from the original proposal.

Earlier completion reports, commit checkpoints, artifact names/checksums, and test counts are preserved in [implementation history](archive/implementation-history.md). Those results belong to their recorded revisions. The older handoff is also [archived](archive/handoff-2026-09-11.md).

## Active implementation

| Area | Implemented path and boundary |
| --- | --- |
| Supported pairs | Two Macs or one Mac and Windows; unsupported platforms and Windows-to-Windows are rejected. |
| Shared input | Rust native hooks/event taps, main-process ownership/routing, keyboard/scroll mapping, configurable pointer feel/layout, and native fail-safe controls. |
| Windows Chrome | Existing-profile Tab Bridge extension, managed unpacked-extension setup, per-user native host registration, and named-pipe relay. No isolated-profile restart is required by this runtime. |
| Mac Chrome | Apple Events/JXA plus Accessibility. First-run startup permission checks; optional JavaScript from Apple Events for scroll/draft state. No extension. |
| Handoff | Native Chrome preparation/placement, bounded tab/history/page state, parked splits, reverse reuse, acknowledged commit, and recovery. Site sessions are not transferred. |
| Clipboard | New plain text while connected, with a settings toggle; no image/file synchronization. |
| Audio | Either supported computer can send, full/split stereo, independent device volumes, protocol-v3 shared scheduling, and route recovery. Mac capture needs recording permission; Windows sending needs standard VB-CABLE. |
| Messages Companion | Windows UI, Mac read-only Messages/Contacts access, and Mac Messages Automation for sending. |
| UI/lifecycle | Connection & settings, Latency Monitor, tray/menu, optional Messages window, transient seam overlay, second-instance activation, and background launch. |
| Optional installers | Windows NSIS and macOS DMG/ZIP scripts, packaged updater, and the existing separately configured release workflow. Availability and signing are separate checks. |

The retired grid/shared surface, workspace UI, and host editor are not created by the active entry point. Retained unit tests and modules do not imply that these features are offered. `playwright.config.cjs` excludes the two retired surface/workspace E2E suites.

## Automated verification

For repeatable source checks, follow the prerequisites in the [README](../README.md), quit any running CompuSync instance, and run:

```sh
npm ci
npm run native:build
npm run native:smoke
npm run check
npm test
npm run test:native
npm run test:e2e
```

The desktop workflow applies these checks on macOS and Windows, with the Windows recovery probe as an additional platform step. It builds installer artifacts only when manually dispatched with packaging enabled. The separate tag-triggered installer workflow runs syntax/unit checks, native build/smoke through the distribution scripts, and release-asset validation; it is not a substitute for the full desktop workflow or hardware acceptance.

Record the exact revision, uncommitted changes if any, OS/architecture, command, result, and retained evidence. Avoid undated fixed test counts: adding a test changes the count, and an older pass does not verify newer local changes. No new test/build run is claimed merely because this documentation was reconciled.

Useful automated coverage includes paired session validation, supported device identity, topology and cursor ownership, input mapping, clipboard ordering, Chrome setup/adapters and failure recovery, page-state sanitization, audio negotiation/scheduling models, Messages validation, renderer selection persistence, and application lifecycle. Some tests use fake native adapters, audio engines, Chrome responses, or local fixture profiles. Read the specific test before equating its pass with an OS interaction.

## Hardware and package acceptance

Use the [acceptance checklist](testing.md) with both physical computers and both host roles. Automated checks cannot establish:

- real mouse/trackpad held-input behavior, button release, multi-monitor scaling, or physical window size across the seam;
- first-run macOS TCC prompts and which launching application receives a permission;
- Windows Chrome Developer-mode installation, native messaging with the user's actual profile, and bridge reconnection after Chrome/app updates;
- native Chrome handoff on both operating systems, including parked splits, navigation changes, and loss of either app;
- firewall/discovery behavior, changed host addresses, suspend/wake, process hard-kill recovery, and device hotplug;
- actual capture/playback devices, Windows output-role restoration, acoustic skew/drift, or Bluetooth downstream latency;
- Messages/Contacts access and Messages Automation on the intended Mac;
- Gatekeeper, signatures/notarization, NSIS installation, startup registration, or a real signed automatic-update cycle.

Source-only acceptance does not require publishing installers. When shipping a package, add the packaging/signing/update checks from [releases](releases.md). Do not claim production or sample-exact audio readiness solely from source presence, simulated engines, timing estimates, or a historical build report.

## Evidence and historical records

Store a current run's command output and the result against its revision, keeping private data out of shared logs and traces. Mask pairing codes in screenshots and use disposable profiles for automated tests. Missing or skipped platform checks remain unverified; explain them rather than presenting a previous version's result as current.

The archived implementation report preserves earlier observations, including the 0.2.0 desktop/editor work and early v3 CDP probes. The [native probe guide](../native/probes/README.md) also labels its September 2026 findings as historical. Neither replaces current extension setup, current feature acceptance, or a fresh run on the intended devices.
