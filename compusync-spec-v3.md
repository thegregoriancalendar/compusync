# Compusync — Shared Cursor & Window Teleport
## Implementation Spec v3

---

## 0. Scope

Build two layers, in order:

1. **Cursor substrate.** One logical cursor shared across a Mac and a Windows PC, living in a virtual coordinate space that spans both screens. Independently shippable and testable.
2. **Window teleport.** Dragging a window across the shared edge moves it between machines. Both machines hold a **real, native** window during the crossing; the visible halves add up to one window.

**Only Chrome is supported.** No other application. No mirror/streaming mode. Non-Chrome windows do not cross the edge — the cursor crosses, the window stays.

**Already built, do not rebuild:** pairing, authenticated transport, and an existing Electron app with a custom draggable sandbox window. The sandbox window ships alongside this work untouched; it will be retired later.

**Explicit non-goals:** process migration, emulation, cross-platform binary execution, tab-strip interior alignment across the seam.

---

## 1. Architecture

### 1.1 Stack

Keep Electron. Add a Rust native addon via **napi-rs**.

| Layer | Owner | Responsibility |
|---|---|---|
| UI, settings, pairing, sandbox window, overlay | Electron main + renderer | Existing code. Extend, don't rewrite. |
| Cursor hooks, input synthesis, window enumeration & positioning, move-event hooks, screen metrics | **Rust addon** | All native OS work. Per-platform behind a trait. |
| Chrome control (CDP) | Node (Electron main) | HTTP + WebSocket to localhost. No native code needed. |
| Transport | Existing | Extend with new message types only. |

Rationale: the input hot path cannot tolerate an IPC hop per pointer event, and Electron has no API for foreign-window manipulation. Everything else Electron already does well.

### 1.2 Hot path

Pointer deltas must never round-trip through the renderer. The addon emits deltas on a native thread, the main process forwards them over transport, and the peer addon applies them. Target end-to-end delta latency **< 8ms on LAN**; anything above ~20ms is perceptible as cursor lag.

Window position updates during a straddle may go through the main process (60Hz is fine), but must be driven by the addon's authoritative pointer position, not by a renderer animation loop.

### 1.3 Modules

```
/native/                       Rust addon (napi-rs)
  src/lib.rs                   N-API surface
  src/cursor/                  hide/show, park, warp, delta capture, synthesis
  src/window/                  enumerate, geometry, move-hooks, positioning
  src/platform/darwin.rs
  src/platform/windows.rs
/src/main/
  virtualspace.ts              coordinate math, screen layout, DPI
  cursor.ts                    ownership state machine, edge crossing
  drag.ts                      drag lifecycle + pre-warm state machine
  adapters/chrome/
    detect.ts                  find running Chrome, debug-port availability
    cdp.ts                     HTTP + WS client, browser vs page connections
    capture.ts                 window -> ChromeDescriptor
    prepare.ts                 descriptor -> offscreen real window
  transport/messages.ts        new message types
  watchdog.ts                  failure recovery (§8)
/src/renderer/                 existing UI + settings
```

`drag.ts` must contain no Chrome-specific types. Adapter selection happens at its boundary. This is the seam that future apps plug into.

---

## 2. Virtual coordinate space

### 2.1 Definition

A single continuous 2D space containing both screens, in **virtual units (VU)**. 1 VU = 1 logical point at scale 1.0.

Each machine has a `ScreenPlacement`:

```ts
type ScreenPlacement = {
  machineId: string;
  origin: { x: number; y: number };   // top-left in VU
  size:   { w: number; h: number };   // logical size in VU
  scale:  number;                      // device pixel ratio
};
```

Conversion:
```
toLocal(vu)    = (vu - placement.origin) * placement.scale     // device px
toVirtual(px)  = px / placement.scale + placement.origin
```

Both machines hold the full layout (both placements) and agree on it. On any display change (`NSApplicationDidChangeScreenParameters`, `WM_DISPLAYCHANGE`), re-derive locally and broadcast; peer recomputes.

### 2.2 Layout configuration

v1: one shared edge, configured by the user in settings — which machine is on which side, and vertical offset. Default: Mac left, Windows right, vertically centered.

Multi-monitor per machine: treat each machine's full desktop bounding box as one placement. Only the outermost edge participates in crossing. Interior monitor boundaries are the OS's problem.

macOS clamps the pointer at the top edge (menu bar). **Top is never a crossing edge.** Left, right, bottom only.

### 2.3 Non-overlapping guarantee

Placements must not overlap in VU space. Validate on config change; if overlapping, push the second placement right by the overlap width and log a warning.

---

## 3. Cursor substrate

### 3.1 Model

- Exactly **one logical cursor** exists while linked. Position `virtualCursor: {x, y}` in VU.
- Exactly one machine is **owner** at any time — the one whose placement contains `virtualCursor`.
- Owner: pointer visible, positioned at `toLocal(virtualCursor)`, input applied normally.
- Non-owner: pointer **hidden and parked**, deltas still captured and forwarded.
- Both physical devices always work. Either drives the logical cursor wherever it is.

### 3.2 Delta capture

**Windows:** Raw Input (`WM_INPUT`, `RIDEV_INPUTSINK`) for unaccelerated deltas. `ClipCursor` to a 1×1 rect while non-owner to park the pointer.

**macOS:** `CGAssociateMouseAndMouseCursorPosition(false)` to decouple device movement from cursor position; read deltas via a `CGEventTap` on mouse-moved events. `CGDisplayHideCursor` while non-owner. `CGWarpMouseCursorPosition` to place on re-entry.

### 3.3 Acceleration

Raw deltas are unaccelerated on both platforms. Apply a **single shared acceleration curve** in the addon so pointer feel is identical regardless of which device is driving.

Start with a standard two-segment curve:
```
speed = |delta| / dt
gain  = speed < threshold ? base : base + (speed - threshold) * slope
applied = delta * gain
```

Expose `base`, `threshold`, `slope` in settings. **The implementing agent should expect to tune these empirically** — matching the native feel of both platforms is not derivable from first principles. Budget real time for this; mismatched acceleration is the single most common reason shared-cursor tools feel wrong.

### 3.4 Delta summing

Both machines forward deltas continuously. The **owner** machine is authoritative for position:

```
virtualCursor += accel(localDelta) + accel(remoteDelta)
```

Summed per frame. If both devices move at once the result is the vector sum. This is acceptable and self-correcting. Do not implement device leasing in v1.

The owner broadcasts authoritative `virtualCursor` at ~60Hz. The non-owner treats it as ground truth and does not dead-reckon.

### 3.5 Edge crossing

When `virtualCursor` leaves the owner's placement:

1. Owner clamps its physical pointer, hides it, parks it.
2. Owner sends `cursor.handoff { virtualCursor, buttons, modifiers }`.
3. New owner warps its pointer to `toLocal(virtualCursor)`, unhides it, assumes ownership.
4. Button and modifier state is transferred so a held button stays held across the seam.

Add a configurable **edge resistance** (default 0px, suggest offering ~50 VU): cursor must push against the edge by this distance before crossing. Prevents accidental crossings. Disable resistance entirely while a drag is in progress — crossing mid-drag must be frictionless.

If `virtualCursor` would land outside both placements (vertical offset gap), clamp to the nearest valid point in the target placement.

### 3.6 Keyboard

Keyboard follows the cursor. The owner captures keystrokes; the non-owner forwards its local keystrokes to the owner. Synthesize on the owner via `CGEventPost` / `SendInput`.

**Known limit:** Windows UIPI blocks synthetic input into elevated (admin) windows. Detect the foreground window's elevation; if elevated and we are synthesizing, surface a one-time notice. Do not fail silently.

### 3.7 Link modes

- **Linked** (default): shared cursor, edge crossing active.
- **Unlinked**: two independent native cursors, pairing and transport still alive, no crossing. Bound to a hotkey (default `Ctrl/Cmd+Shift+U`). Also the state entered automatically on any failure (§8).

Add a "toggle ownership" hotkey that jumps the cursor to the other machine without edge-crossing.

---

## 4. Chrome adapter

### 4.1 No auto-launch

Compusync **never launches Chrome at startup.** It detects Chrome whenever it appears and works with what's there.

Detection loop (every 2s while linked, cheap):
- Enumerate windows; identify Chrome by process name / bundle ID.
- Probe `GET http://127.0.0.1:<port>/json/version` across 9222–9250.

### 4.2 Debug access — the constraint

Since Chrome 136, `--remote-debugging-port` is **ignored when Chrome uses its default user data directory.** There is no flag to override this. Consequences:

- A normally-launched Chrome on Windows **cannot** be controlled via CDP.
- Attaching to an already-running default-profile Chrome is impossible.

**macOS path (preferred, zero friction):** AppleScript/JXA reads tabs from a normally-launched Chrome with no flags:
```
tell application "Google Chrome"
  get {URL, title} of every tab of window 1
end tell
```
Requires one-time Automation permission. Use this on macOS for both capture and restore (`make new window with properties {URL:...}`). **Build this path first** — it is free.

**Windows path:** requires a relaunch with an isolated profile:
```
chrome.exe --remote-debugging-port=9222 ^
  --user-data-dir="%LOCALAPPDATA%\Compusync\browser-profile" ^
  --restore-last-session --no-first-run --no-default-browser-check
```

Offer this **per-app, on first crossing attempt**, never at startup:

> "Chrome needs a one-time restart to enable window handoff. Your tabs will be restored."

On decline, remember the choice and treat Chrome windows as non-crossing (§4.6). `--restore-last-session` preserves the current session. The isolated profile starts signed out; surface this once.

The implementing agent may investigate whether UI Automation on Windows can extract background tab URLs as a no-relaunch fallback. Current understanding: it exposes tab *titles* and the active tab's address bar only, which is insufficient. **If a viable no-relaunch path exists on Windows, prefer it.**

### 4.3 Two CDP connection types

- **Browser-level**: from `GET /json/version` → `webSocketDebuggerUrl`. Required for `Browser.*` and `Target.*`. Open once, keep alive.
- **Page-level**: from `/json/list` per-target. Required for `Page.*`. Open on demand, close promptly.

### 4.4 Grouping tabs into windows

`/json/list` is flat. To group:
1. Filter `type == "page"`, exclude `devtools://` and `chrome-extension://`.
2. `Browser.getWindowForTarget(targetId)` → `windowId`.
3. Group by `windowId`.

Cache the mapping; invalidate on `Target.targetCreated` / `targetDestroyed` (subscribe via `Target.setDiscoverTargets`). Calling `getWindowForTarget` for 40 tabs per drag is visibly slow.

Map `windowId` to the OS window handle by matching `Browser.getWindowBounds` against enumerated native window geometry. This is the join between CDP and the drag layer.

### 4.5 Descriptor

```ts
type WindowDescriptor = {
  schemaVersion: 1;
  id: string;              // UUID, STABLE across round trips
  adapterId: "chrome";
  origin: string;          // machine id
  capturedAt: number;
  geometryVU: { x, y, w, h };
  state: "normal" | "maximized";
  payload: ChromePayload;
};

type ChromePayload = {
  activeIdx: number;
  tabs: Array<{
    url: string;
    title: string;
    pinned: boolean;
    index: number;
    history?: { currentIndex: number; entries: string[] };  // active tab only in v1
  }>;
};
```

**`id` is stable.** A→B→A keeps the same id. Required for later ownership leases.

Geometry travels in **VU**, not device pixels. Each side converts locally; DPI differences resolve for free.

`state: "maximized"` → do not straddle. See §5.7.

### 4.6 Non-crossing windows

Any window that is not a CDP/AppleScript-addressable Chrome window. On drag toward the edge: cursor crosses normally, window clamps at the edge and does not straddle. Show a brief non-blocking hint on first occurrence only. No error, no modal.

---

## 5. Drag & pre-warm

### 5.1 Detecting a drag

**Windows:** `SetWinEventHook` on `EVENT_SYSTEM_MOVESIZESTART` / `MOVESIZEEND`.
**macOS:** `AXObserver` on `kAXWindowMovedNotification` (Accessibility permission required).

Between start and end, poll window geometry at 60Hz.

### 5.2 Grab offset

At drag start:
```
grabOffsetVU = virtualCursor - windowOriginVU
```
Fixed for the drag. Thereafter, every frame:
```
windowOriginVU = virtualCursor - grabOffsetVU
```
Both machines compute from the same `virtualCursor`, so the halves align.

### 5.3 Sequence

**1. Arm.** Drag in progress AND window origin within **200 VU** of the shared edge AND net motion toward it. Fires once per drag.

→ Capture descriptor. Send `window.offer`.

**2. Prepare.** Destination creates a **real native Chrome window** with the descriptor's tabs, sized to `geometryVU`, positioned **entirely offscreen past the shared edge**. Replies `window.ready { id }`.

Ordering inside prepare (matters):
- Create window with the **active tab's URL** first.
- Apply geometry via `Browser.setWindowBounds`.
- Create remaining tabs `background: true`, in index order, staggered 80–120ms.
- Apply pinned state.
- Re-activate the active tab (background creation can shift focus).
- Restore active tab history via `Page.navigateToHistoryEntry`.
- Reply ready after the active tab's `Page.loadEventFired` or a 3s cap, whichever first.

**3. Straddle.** As the pointer advances, both machines position their copy at `toLocal(windowOriginVU)`. Source slides off; destination slides in. At any instant source shows N%, destination shows (100−N)%. Both windows are real. Nothing is streamed.

**4. Commit.** On mouse-up:
- Crossed ≥50% → destination is winner.
- Crossed <50% → source is winner.

Winner is positioned fully on-screen, raised, focused. Loser is destroyed — `Target.closeTarget` (CDP) or `close window` (AppleScript). Source closes **only after** `window.committed` is received from the destination.

**5. Settle.** Destination sends `window.committed`. Source releases. Drag state cleared.

### 5.4 Focus

**Per-machine.** The pre-warmed window taking focus on the destination is invisible to the user, who is physically at the source. Do not suppress it. On commit, focus on the destination is desired.

### 5.5 Race conditions

| Race | Required behavior |
|---|---|
| Pointer crosses before `window.ready` | Cursor crosses on schedule; destination shows nothing yet. Real window appears when ready and snaps to correct position. **Never stall the cursor on the network.** |
| Mouse-up before `window.ready` | If destination would win: wait up to 2s for ready, show busy indicator, then commit. If prepare fails, abort — source window stays, fully restored to pre-drag position. |
| `window.ready` arrives after abort | Discard. Destination destroys the prepared window. |
| Drag reverses back across edge | Destination window slides back offscreen, **stays alive 3s** in case of re-cross, then destroyed. |
| Two drags at once | Reject the second `window.offer` with `busy`. One teleport in flight per pair. |
| Chrome quits mid-straddle | Abort. Surviving side restores its window to full on-screen position. |

### 5.6 The seam

Window frame edges align exactly — they are computed from the same VU origin. **Interiors will not match**: different titlebar heights, tab geometry, fonts, scrollbar widths. This is expected and must not be fought.

Render a subtle treatment on the crossing edge during straddle (thin gradient or highlight, via the existing Electron overlay) to read the discontinuity as intentional transformation.

### 5.7 Excluded from straddling

- Maximized or fullscreen windows. Restore-then-drag, or commit instantly on edge contact without a straddle phase. Agent's choice; instant commit is simpler and acceptable.
- Windows smaller than 200×150 VU.
- Windows whose native move loop cannot be intercepted (§6).

### 5.8 Cost to accept

Two Chrome windows with identical tabs exist for the duration of a straddle, possibly both signed into the same profile. Acceptable for a 1–3s drag. **Arm only on motion toward the shared edge** so intra-screen dragging never spawns anything remotely.

---

## 6. Killing the native move loop

Once the physical pointer hits the source machine's screen edge, the OS clamps it. The native move loop follows the clamped pointer, so the window stops at the edge while `virtualCursor` keeps advancing. Fighting it with `SetWindowPos` produces jitter.

**Resolution:** at edge contact, synthesize a **left-button-up** to terminate the move loop while the physical button is still held. The low-level hook knows the true button state; Compusync continues driving the window programmatically from raw deltas. Suppress the synthetic up-event from propagating to the application.

Do this at **edge contact**, not at drag start — letting the OS handle the normal case preserves snap-to-edge and native feel.

The destination **never** starts a native move loop. Its window is positioned programmatically throughout.

Windows: `WM_SYSCOMMAND`/`SC_MOVE` loop, terminated via synthetic `WM_LBUTTONUP` / `SendInput`.
macOS: no equivalent modal loop for foreign windows; position via the Accessibility API (`kAXPositionAttribute`). Verify whether the synthetic-up step is needed at all on macOS — **it likely is not.** The agent should determine this empirically.

---

## 7. Messages

```jsonc
{ "type": "cursor.delta",    "dx": 0, "dy": 0, "t": 0 }
{ "type": "cursor.position", "x": 0, "y": 0, "t": 0 }           // owner authoritative, 60Hz
{ "type": "cursor.handoff",  "x": 0, "y": 0, "buttons": 0, "modifiers": 0 }
{ "type": "cursor.button",   "button": "left", "down": true }
{ "type": "key.event",       "code": 0, "down": true, "modifiers": 0 }

{ "type": "window.offer",     "descriptor": { } }
{ "type": "window.ready",     "id": "" }
{ "type": "window.position",  "id": "", "originVU": { "x": 0, "y": 0 } }   // 60Hz during straddle
{ "type": "window.commit",    "id": "", "winner": "source" | "destination" }
{ "type": "window.committed", "id": "" }
{ "type": "window.abort",     "id": "", "reason": "" }

{ "type": "layout.update",    "placements": [ ] }
{ "type": "heartbeat",        "t": 0 }
```

Cursor and window position messages are high-frequency and loss-tolerant — send unreliably/unordered if the transport supports it, and never let them head-of-line-block file transfer. Control messages must be reliable.

---

## 8. Failure recovery — mandatory

**A bug that leaves a machine with no visible cursor is unrecoverable without a reboot.** This section is not optional.

Watchdog on each machine. Trigger on: peer heartbeat missing >2s, transport error, addon panic, process exit (including crash — install signal handlers and `atexit`), or user hotkey.

On trigger, **immediately and unconditionally**:
1. Unhide local cursor (`CGDisplayShowCursor` / `ShowCursor(TRUE)`).
2. Release parking (`ClipCursor(NULL)` / `CGAssociateMouseAndMouseCursorPosition(true)`).
3. Remove all hooks and event taps.
4. Release any held synthetic buttons/modifiers.
5. Restore any straddling window to a fully on-screen position.
6. Enter Unlinked mode.

Recovery must not depend on the peer, the network, or the renderer process. Implement it in the addon with a native-side guard so it runs even if the JS side is wedged.

**Required tests:** kill the daemon mid-straddle on each side; pull the network mid-straddle; force-quit Chrome mid-straddle; sleep/wake each machine mid-link.

---

## 9. Security

1. CDP port binds `127.0.0.1` only. Never a routable interface.
2. No new network listener. All messages ride the existing authenticated paired channel.
3. Validate incoming descriptors: cap tabs at 200, URL length at 8KB, reject non-`http(s)` schemes, clamp geometry to sane bounds. A malformed descriptor must not crash the daemon.
4. Do not log full URLs at default verbosity — they carry session tokens. Log host + tab count.
5. The isolated Chrome profile holds real credentials. Create it 0700 / user-only ACL.
6. Input synthesis and cursor capture are high-privilege. Never accept `key.event` or `cursor.delta` from an unpaired source.

---

## 10. Permissions

| Platform | Needed for | Prompt |
|---|---|---|
| macOS Accessibility | event taps, window position, drag detection | First run, blocking — explain clearly |
| macOS Automation (Chrome) | AppleScript tab access | First Chrome crossing attempt |
| macOS Input Monitoring | key capture | First run |
| Windows | none for normal-privilege windows | UIPI notice only if elevated window encountered |

Detect missing permissions and show a real remediation path (deep-link to the relevant Settings pane). Never fail silently.

---

## 11. Milestones

### M0 — Cursor substrate
- [ ] Rust addon: hide/show/park/warp, raw delta capture, both platforms
- [ ] Virtual space math, layout config UI, DPI handling
- [ ] Ownership state machine, edge crossing, button/modifier carry
- [ ] Delta summing from both devices
- [ ] Shared acceleration curve, tunable
- [ ] Keyboard follows cursor
- [ ] Watchdog + Unlinked mode + hotkey (§8)

**Acceptance:** move the pointer continuously between machines using either device; click and type on both; held button survives crossing; killing the daemon mid-crossing restores both cursors within 2s.

### M1 — Chrome handoff, no straddle
- [ ] Chrome detection, macOS AppleScript path, Windows relaunch offer
- [ ] Capture → descriptor; prepare → real offscreen window
- [ ] Commit on drop with snap-in, no intermediate straddle rendering
- [ ] Source closes only on `window.committed`

**Acceptance:** drag a 7-tab Chrome window (2 pinned, one playing video) across; it lands as a native window on the other OS with correct tab order, pinned state, size, position; round-trips with 2 added tabs.

### M2 — Straddle
- [ ] Native move-loop interception (§6)
- [ ] 60Hz dual positioning from shared `virtualCursor`
- [ ] Arm threshold, abort/reverse, 3s keep-alive
- [ ] Seam treatment
- [ ] All §5.5 races handled

**Acceptance:** window visibly spans both screens mid-drag with aligned frame edges; reversing mid-straddle leaves no residue; every race in §5.5 behaves as specified.

### M3 — Hardening
- [ ] Multi-monitor, display hotplug, sleep/wake
- [ ] History for all tabs (bounded concurrency)
- [ ] Edge resistance, ownership-toggle hotkey
- [ ] Structured per-handoff timing logs

---

## 12. Notes for the implementing agent

**Build order is not negotiable.** M0 is a standalone product and the substrate everything else stands on. Do not begin window work until cursor crossing is solid.

**Validate the riskiest unknowns before building around them.** In rough order of risk:
1. Does synthesizing button-up reliably terminate the Windows move loop without the app noticing? (§6)
2. Can a Chrome window be positioned far enough offscreen on each OS to be fully hidden past the shared edge? Verify actual clamping behavior per platform.
3. Is the AppleScript path sufficient for macOS capture *and* restore, avoiding the relaunch entirely on that side?
4. Does any Windows path avoid the relaunch? (§4.2)

Write a throwaway probe for each. Report findings before committing to the surrounding design.

**Where this spec is uncertain, it says so.** Acceleration constants, the macOS move-loop question, maximized-window handling, and the Windows no-relaunch path are all open. Use judgment, prefer the simpler option, and document what you chose and why.

**Where this spec is not uncertain:** the source window never closes before `window.committed`; the cursor never stalls waiting on the network; failure recovery never depends on the peer. Treat any violation of these three as a bug regardless of how well the happy path works.

Report at each milestone boundary and after the probes in §12, not only at the end.
