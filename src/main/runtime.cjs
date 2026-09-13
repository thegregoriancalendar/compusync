'use strict';

const { EventEmitter } = require('node:events');
const { CursorController } = require('./cursor.cjs');
const { KeyboardRouter } = require('./keyboard.cjs');
const { RecoveryWatchdog } = require('./watchdog.cjs');
const { registerCursorHotkeys } = require('./hotkeys.cjs');
const { sanitizePeerMessage, policyForMessage } = require('./messages.cjs');
const { routePeerInput } = require('./input-runtime.cjs');
const { placementFromDisplays, layoutPair } = require('./virtualspace.cjs');

function placementForLayout(machineId, layout) {
  if (layout?.desktop) {
    const { widthVU, heightVU, scale } = layout.desktop;
    if ([widthVU, heightVU, scale].every((value) => typeof value === 'number' && Number.isFinite(value))
      && widthVU > 0 && heightVU > 0 && scale > 0) {
      return { machineId, origin: { x: 0, y: 0 }, size: { w: widthVU, h: heightVU }, scale };
    }
  }
  if (!layout?.displays?.length) return null;
  try { return placementFromDisplays(machineId, layout.displays); }
  catch { return null; }
}

function derivePairPlacements(layouts, hostId, peerId, settings) {
  const host = placementForLayout(hostId, layouts?.[hostId]);
  const peer = placementForLayout(peerId, layouts?.[peerId]);
  if (!host || !peer) return host ? [host] : peer ? [peer] : [];
  const peerSide = settings?.screenSide === 'bottom'
    ? 'bottom' : settings?.screenSide === 'right' ? 'left' : 'right';
  return layoutPair(host, peer, {
    secondSide: peerSide,
    verticalOffsetVU: Number(settings?.verticalOffsetVU) || 0,
  });
}

function centerOf(placement) {
  return {
    x: placement.origin.x + placement.size.w / 2,
    y: placement.origin.y + placement.size.h / 2,
  };
}

class SharedInputRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.session || !options.machineId || !options.hostId || !options.peerId) {
      throw new TypeError('session, machineId, hostId and peerId are required.');
    }
    this.session = options.session;
    this.machineId = options.machineId;
    this.hostId = options.hostId;
    this.peerId = options.peerId;
    this.isHost = this.machineId === this.hostId;
    // peerId always names the remote transport peer. On the join computer
    // that is the host, so it cannot also identify the second screen in the
    // host/join layout pair.
    this.joinId = this.isHost ? this.peerId : this.machineId;
    this.settings = options.settings || {};
    this.native = options.native || {};
    this.globalShortcut = options.globalShortcut;
    this.powerMonitor = options.powerMonitor;
    this.processLike = options.processLike || process;
    this.layouts = options.layouts || {};
    this.onNotice = typeof options.onNotice === 'function' ? options.onNotice : () => {};
    this.onModeChange = typeof options.onModeChange === 'function' ? options.onModeChange : () => {};
    this.onLayoutNeeded = typeof options.onLayoutNeeded === 'function' ? options.onLayoutNeeded : () => {};
    this.logger = options.logger || null;
    this.started = false;
    this.stopping = false;
    this.peerConnected = false;
    this.desiredLinked = this.settings.linked !== false;
    this.windowController = null;

    const placements = derivePairPlacements(this.layouts, this.hostId, this.joinId, this.settings);
    const ownerPlacement = placements.find((placement) => placement.machineId === this.hostId) || placements[0];
    this.cursor = new CursorController({
      machineId: this.machineId,
      native: this.native,
      placements,
      ownerMachineId: this.hostId,
      initialPosition: ownerPlacement ? centerOf(ownerPlacement) : { x: 0, y: 0 },
      acceleration: this.settings.acceleration,
      edgeResistanceVU: this.settings.edgeResistanceVU,
      linked: false,
      send: (message) => this.send(message),
      onFailure: (reason, error) => {
        if ((this.native.platformName === 'darwin' || process.platform === 'darwin')
          && /input monitoring|event tap|accessibility/i.test(String(error?.message || error))) {
          this.onNotice({
            id: 'input-monitoring-permission', kind: 'permission', title: 'Allow Input Monitoring',
            message: 'Compusync could not capture shared input. Allow Accessibility and Input Monitoring, then link the cursors again.',
            actionLabel: 'Open Input Monitoring Settings', action: 'open-input-monitoring', dismissible: false,
          });
        }
        this.watchdog?.trigger?.(reason, error);
      },
    });
    this.keyboard = new KeyboardRouter({
      cursor: this.cursor,
      native: this.native,
      send: (message) => this.send(message),
      notice: (message) => this.onNotice({
        id: 'elevated-window', kind: 'warning', title: 'Administrator window', message,
        dismissible: true,
      }),
    });
    this.watchdog = new RecoveryWatchdog({
      native: this.native,
      cursor: this.cursor,
      keyboard: this.keyboard,
      send: (message) => this.send(message),
      onUnlinked: (reason) => {
        // An orderly session replacement still performs the full native
        // recovery sequence, but it is not a link failure. Preserve the
        // user's desired mode so a saved pairing can relink after reconnect.
        if (this.stopping) return;
        this.desiredLinked = false;
        this.onModeChange(false, reason);
        this.emit('mode', { linked: false, reason });
      },
      onResume: () => this.onLayoutNeeded(),
    });

    this._peerMessage = (message, peerMachineId) => this.receive(message, peerMachineId);
    this._status = (status) => this.setPeerConnected(status?.phase === 'connected');
    this._state = (state) => this.updateLayouts(state?.layouts || {});
    this._key = (event) => this.keyboard.localKey(event?.code, event?.down, event?.modifiers || 0);
    this._displayChanged = () => this.onLayoutNeeded();
    this._nativeUnlink = () => this.watchdog.trigger('user-hotkey');
    this._nativeOwnership = () => this.cursor.toggleOwnership();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.cursor.start();
    this.watchdog.start();
    this.watchdog.bindProcess(this.processLike);
    this.watchdog.bindPowerMonitor(this.powerMonitor);
    this.session.on('peer-message', this._peerMessage);
    this.session.on('status', this._status);
    this.session.on('state', this._state);
    this.native.on?.('key', this._key);
    this.native.on?.('displayChanged', this._displayChanged);
    this.native.on?.('unlinkHotkey', this._nativeUnlink);
    this.native.on?.('toggleOwnershipHotkey', this._nativeOwnership);
    // The native hook owns these fail-safe hotkeys in production so unlink
    // still works if JS is wedged. Electron registers them only for fallback
    // development adapters; registering both would make RegisterHotKey fail.
    if (this.globalShortcut && !this.native.available) {
      const cursorProxy = {
        get linked() { return this.runtime.cursor.linked; },
        runtime: this,
        setLinked: (linked, reason) => this.setLinked(linked, reason),
        toggleOwnership: () => this.cursor.toggleOwnership(),
        get ownerMachineId() { return this.runtime.cursor.ownerMachineId; },
      };
      this.hotkeys = registerCursorHotkeys(this.globalShortcut, {
        cursor: cursorProxy,
        watchdog: this.watchdog,
        onModeChange: (linked) => this.onModeChange(linked, 'hotkey'),
      });
    }
    this.setPeerConnected(this.session.phase === 'connected');
  }

  send(message) {
    const clean = sanitizePeerMessage(message, { logger: this.logger });
    if (!clean) return false;
    const policy = policyForMessage(clean.type);
    return this.session.sendPeer(clean, { lossTolerant: policy?.reliable === false });
  }

  receive(message, peerMachineId) {
    const clean = sanitizePeerMessage(message, { logger: this.logger });
    if (!clean || peerMachineId !== this.peerId) return false;
    if (clean.type.startsWith('window.')) return this.windowController?.receive(clean) || false;
    const handled = routePeerInput({ cursor: this.cursor, keyboard: this.keyboard, watchdog: this.watchdog }, clean, peerMachineId);
    if (clean.type === 'layout.update' && handled) this.#applyDesiredLink();
    return handled;
  }

  setPeerConnected(connected) {
    this.peerConnected = Boolean(connected);
    this.watchdog.setPeerConnected(this.peerConnected);
    if (!this.peerConnected) return;
    if (this.isHost) this.broadcastLayout();
    this.#applyDesiredLink();
  }

  updateLayouts(layouts) {
    this.layouts = layouts || {};
    if (this.isHost && this.peerConnected) this.broadcastLayout();
  }

  broadcastLayout() {
    const placements = derivePairPlacements(this.layouts, this.hostId, this.joinId, this.settings);
    if (placements.length !== 2) return false;
    this.cursor.setPlacements(placements);
    return this.send({ type: 'layout.update', placements });
  }

  updateSettings(settings) {
    this.settings = settings;
    this.desiredLinked = settings.linked !== false;
    this.cursor.setConfig(settings);
    if (this.isHost && this.peerConnected) this.broadcastLayout();
    this.#applyDesiredLink();
  }

  setLinked(linked, reason = 'user') {
    this.desiredLinked = Boolean(linked);
    if (linked && (!this.peerConnected || !this.native.available || this.cursor.placements.length !== 2)) {
      if (!this.native.available) this.onNotice({
        id: 'native-unavailable', kind: 'warning', title: 'Native input support unavailable',
        message: 'Install the platform build of Compusync to link cursors.', dismissible: false,
      });
      return false;
    }
    if (linked) this.watchdog.arm();
    this.cursor.setLinked(Boolean(linked), reason);
    this.onModeChange(this.cursor.linked, reason);
    this.emit('mode', { linked: this.cursor.linked, reason });
    return this.cursor.linked === Boolean(linked);
  }

  setDragging(dragging) { this.cursor.setDragging(dragging); }

  setWindowController(controller) {
    this.windowController = controller || null;
    this.watchdog.drag = this.windowController;
  }

  stop(reason = 'stop') {
    if (!this.started) return;
    this.stopping = true;
    this.started = false;
    this.hotkeys?.dispose?.();
    this.session.off?.('peer-message', this._peerMessage);
    this.session.off?.('status', this._status);
    this.session.off?.('state', this._state);
    this.native.off?.('key', this._key);
    this.native.off?.('displayChanged', this._displayChanged);
    this.native.off?.('unlinkHotkey', this._nativeUnlink);
    this.native.off?.('toggleOwnershipHotkey', this._nativeOwnership);
    this.watchdog.stop({ reason });
    this.cursor.stop(reason);
  }

  #applyDesiredLink() {
    if (!this.desiredLinked || !this.peerConnected || this.cursor.placements.length !== 2 || !this.native.available) return;
    this.setLinked(true, 'connected');
  }
}

module.exports = { SharedInputRuntime, placementForLayout, derivePairPlacements };
