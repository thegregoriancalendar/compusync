# Documentation

Start with the [project README](../README.md) for source installation on macOS and Windows, the Windows Chrome extension, pairing, features, and updates.

## Current guides

| Guide | Purpose |
| --- | --- |
| [Mac setup](mac-setup.md) | Native build prerequisites, first-run permissions, Chrome Automation, and optional Mac features. |
| [Audio routing](audio-routing.md) | Mac-to-Mac and Mac-to-Windows audio in either direction, driver/permission setup, recovery, and measured timing. |
| [Testing](testing.md) | Automated checks and physical acceptance for the current app. |
| [Design choices](DESIGN_CHOICES.md) | Current architecture, platform paths, compatibility, and retired components. |
| [Implementation status](IMPLEMENTATION_REPORT.md) | Implemented paths, verification scope, and how to record evidence. |
| [Development handoff](HANDOFF.md) | Entry points and guidance for the next contributor. |
| [Optional installer releases](releases.md) | Existing packaging/update configuration and its publishing prerequisites. |
| [Native probes](../native/probes/README.md) | Explicit hardware diagnostics and historical probe results. |

## Historical material

The [original v3 proposal](../compusync-spec-v3.md), [September 11 handoff](archive/handoff-2026-09-11.md), and [earlier implementation reports](archive/implementation-history.md) preserve earlier requirements and observations. They are not installation instructions, current feature lists, or proof that the current revision has passed hardware acceptance. In particular, the shared desktop/editor and isolated-profile Chrome setup described there are retired from the active app.

These guides were reconciled with the working source on October 20, 2026. When changing behavior, update its user instructions, design notes, and acceptance steps together. Treat package scripts, platform checks, and the relevant implementation as the authority when a document drifts.
