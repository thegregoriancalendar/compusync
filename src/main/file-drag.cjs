'use strict';

// Turns an OS file drag that crosses the screen seam into a file transfer.
//
// Source (the computer where the drag began, while it owns the cursor):
//   left down      sample the native drag generation; on Windows show the
//                  invisible drop strip along the seam.
//   edge crossing  if a new drag carrying files exists, cancel it locally
//                  (Escape) so the source app moves nothing, mark the handoff
//                  as managed, and offer the files to the peer.
// Receiver (the computer the pointer crossed into with the button held):
//   handoff        arm: only an offer arriving now belongs to this drag.
//   offer          hold it; suppress injecting the carried left button.
//   left up        resolve the folder under the pointer (Downloads if not
//                  certain) and accept the offer into it.

const path = require('node:path');
const { toLocal } = require('./virtualspace.cjs');

const LEFT = 1;
const ESCAPE_HID = 0x29;
// A local release on the receiver can beat the offer, which travels from the
// other computer after the handoff.
const OFFER_WAIT_MS = 2000;
// Windows learns about an OLE drag only once it hovers the drop strip; hold
// the pointer at the seam this long to give it the chance.
const EDGE_DWELL_MS = 150;
const STRIP_PX = 3;
const EPSILON = 1e-6;

// The part of `own` that touches `peer`, `thickness` VU deep, or null.
function seamRect(own, peer, thickness) {
  const right = own.origin.x + own.size.w;
  const bottom = own.origin.y + own.size.h;
  const peerRight = peer.origin.x + peer.size.w;
  const peerBottom = peer.origin.y + peer.size.h;
  const span = (start, end, peerStart, peerEnd) => [Math.max(start, peerStart), Math.min(end, peerEnd)];
  let rect = null;
  if (peer.origin.x >= right - EPSILON || peerRight <= own.origin.x + EPSILON) {
    const [top, end] = span(own.origin.y, bottom, peer.origin.y, peerBottom);
    if (end > top) rect = { x: peer.origin.x >= right - EPSILON ? right - thickness : own.origin.x, y: top, w: thickness, h: end - top };
  } else if (peer.origin.y >= bottom - EPSILON || peerBottom <= own.origin.y + EPSILON) {
    const [left, end] = span(own.origin.x, right, peer.origin.x, peerRight);
    if (end > left) rect = { x: left, y: peer.origin.y >= bottom - EPSILON ? bottom - thickness : own.origin.y, w: end - left, h: thickness };
  }
  return rect;
}

function describe(offer) {
  const first = offer.names[0] || 'files';
  return offer.count === 1 ? `“${first}”` : `“${first}” and ${offer.count - 1} more`;
}

class FileDrag {
  constructor(options = {}) {
    if (!options.transfer?.offer || !options.native) throw new TypeError('FileDrag requires a transfer engine and native adapter.');
    this.transfer = options.transfer;
    this.native = options.native;
    this.platform = options.platform || process.platform;
    this.enabled = options.enabled !== false;
    this.resolveDropFolder = typeof options.resolveDropFolder === 'function' ? options.resolveDropFolder : async () => null;
    this.fallbackFolder = typeof options.fallbackFolder === 'function' ? options.fallbackFolder : () => null;
    this.onHint = typeof options.onHint === 'function' ? options.onHint : () => {};
    this.logger = options.logger || null;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.cursor = null;
    this.press = null;
    this.armed = null;
    this.stripVisible = false;
    this.onButton = (event) => this.#button(event);
    this.onOwnership = (event) => this.#ownership(event);
    this.onOffer = (offer) => this.#offer(offer);
    this.transfer.on('offer', this.onOffer);
  }

  setEnabled(enabled) {
    this.enabled = enabled !== false;
    if (!this.enabled) {
      this.press = null;
      this.#hideStrip();
      this.#disarm('disabled');
    }
  }

  attach(cursor) {
    if (this.cursor === cursor) return;
    this.detach();
    this.cursor = cursor;
    cursor.on('button', this.onButton);
    cursor.on('ownership', this.onOwnership);
    cursor.setHandoffHooks({
      holdCrossing: () => this.#holdCrossing(),
      beforeHandoff: (details) => this.#beforeHandoff(details),
    });
  }

  detach() {
    const cursor = this.cursor;
    if (!cursor) return;
    this.#disarm('detached');
    this.press = null;
    this.#hideStrip();
    cursor.off('button', this.onButton);
    cursor.off('ownership', this.onOwnership);
    cursor.setHandoffHooks({});
    this.cursor = null;
  }

  dispose() {
    this.detach();
    this.transfer.off('offer', this.onOffer);
  }

  #log(event, details = {}) {
    try { this.logger?.info?.(event, details); } catch { /* Logging never interrupts input. */ }
  }

  #native(method, ...args) {
    if (typeof this.native?.[method] !== 'function') return undefined;
    try { return this.native[method](...args); } catch (error) {
      this.#log('file.drag.native-failed', { method, message: error?.message || String(error) });
      return undefined;
    }
  }

  // ---- source -------------------------------------------------------------

  #button({ button, down }) {
    if (button !== 'left') return;
    const cursor = this.cursor;
    if (down) {
      // Only a press that starts while this computer owns the pointer can
      // start a local OS drag.
      if (!this.enabled || !cursor?.linked || !cursor.isOwner()) return;
      const generation = this.#native('dragGeneration');
      this.press = Number.isFinite(generation) ? { generation, edgeSince: null, offered: false } : null;
      if (this.press) this.#showStrip();
      return;
    }
    this.press = null;
    this.#hideStrip();
    const armed = this.armed;
    if (armed && cursor?.isOwner() && !armed.released) {
      armed.released = { point: this.#pointerOnScreen(), at: this.now() };
      if (armed.offer) void this.#drop(armed);
      else {
        armed.timer = setTimeout(() => { if (this.armed === armed) this.#disarm('no-offer'); }, OFFER_WAIT_MS);
        armed.timer.unref?.();
      }
    }
  }

  #fresh() {
    if (!this.enabled || !this.press || this.press.offered) return false;
    const generation = this.#native('dragGeneration');
    return Number.isFinite(generation) && generation !== this.press.generation;
  }

  #holdCrossing() {
    if (this.platform !== 'win32' || !this.enabled || !this.press || this.press.offered) return false;
    if (this.#fresh()) return false;
    const now = this.now();
    this.press.edgeSince ??= now;
    return now - this.press.edgeSince < EDGE_DWELL_MS;
  }

  #beforeHandoff({ buttons }) {
    if (!(buttons & LEFT) || !this.#fresh()) return false;
    const paths = this.#native('dragFiles');
    if (!Array.isArray(paths) || !paths.length) return false;
    // A drag is deliberate and immediate; a background clipboard copy yields.
    if (this.transfer.activePurpose === 'clipboard') void this.transfer.cancel('superseded');
    if (this.transfer.busy) {
      this.onHint('Another file transfer is still running.');
      return false;
    }
    this.press.offered = true;
    // Cancel before this computer releases its injected button: the source
    // app must see Escape, not a drop at the seam.
    this.#native('synthesizeKey', ESCAPE_HID, true, 0);
    this.#native('synthesizeKey', ESCAPE_HID, false, 0);
    // Offer after the handoff message so the peer is already armed.
    queueMicrotask(() => {
      try {
        this.transfer.offer(paths);
        this.#log('file.drag.offered', { items: paths.length });
      } catch (error) {
        this.onHint(error?.code === 'BUSY' ? 'Another file transfer is still running.' : 'Could not send the dragged files.');
        this.#log('file.drag.offer-failed', { code: error?.code || null });
      }
    });
    return true;
  }

  #showStrip() {
    if (this.platform !== 'win32' || !this.cursor) return;
    const own = this.cursor.placementFor(this.cursor.machineId);
    const peer = this.cursor.placements.find((placement) => placement.machineId !== this.cursor.machineId);
    if (!own || !peer) return;
    const rect = seamRect(own, peer, STRIP_PX / own.scale);
    if (!rect) return;
    const topLeft = toLocal({ x: rect.x, y: rect.y }, own);
    const bottomRight = toLocal({ x: rect.x + rect.w, y: rect.y + rect.h }, own);
    this.#native('setDragCaptureRegion', {
      x: topLeft.x, y: topLeft.y,
      width: Math.max(1, bottomRight.x - topLeft.x), height: Math.max(1, bottomRight.y - topLeft.y),
    });
    this.stripVisible = true;
  }

  #hideStrip() {
    if (!this.stripVisible) return;
    this.stripVisible = false;
    this.#native('setDragCaptureRegion', null);
  }

  // ---- receiver -----------------------------------------------------------

  #ownership(event) {
    const cursor = this.cursor;
    if (!cursor) return;
    if (event.ownerMachineId === cursor.machineId) {
      if (event.reason === 'handoff' && (event.buttons & LEFT) && event.managedDrag && this.enabled) {
        this.#disarm('replaced');
        this.armed = { since: this.now(), offer: null, released: null, timer: null, dragging: false };
      }
      return;
    }
    // The pointer went back before the button was released: the drag was
    // already cancelled on the source, so this carry simply ends.
    if (this.armed && !this.armed.released) this.#disarm('returned');
  }

  #offer(offer) {
    if ((offer.purpose ?? 'drag') !== 'drag') return;
    const armed = this.armed;
    if (!this.enabled || !armed || armed.offer) {
      this.transfer.reject(offer.id, this.enabled ? 'unexpected' : 'disabled');
      this.#log('file.drag.offer-refused', { reason: this.enabled ? 'unexpected' : 'disabled' });
      return;
    }
    armed.offer = offer;
    if (armed.released) {
      clearTimeout(armed.timer);
      void this.#drop(armed);
      return;
    }
    // The carried left button stays out of this OS until the release.
    this.cursor?.setDragging(true, { role: 'destination' });
    armed.dragging = true;
  }

  #disarm(reason) {
    const armed = this.armed;
    if (!armed) return;
    this.armed = null;
    clearTimeout(armed.timer);
    if (armed.dragging) this.cursor?.setDragging(false);
    if (armed.offer) this.transfer.reject(armed.offer.id, reason);
  }

  #pointerOnScreen() {
    const cursor = this.cursor;
    const own = cursor?.placementFor(cursor.machineId);
    if (!own) return null;
    try {
      const local = toLocal(cursor.virtualCursor, own);
      return typeof this.native.toPlatformPoint === 'function' ? this.native.toPlatformPoint(local) : local;
    } catch { return null; }
  }

  async #drop(armed) {
    if (this.armed !== armed) return;
    this.armed = null;
    clearTimeout(armed.timer);
    if (armed.dragging) this.cursor?.setDragging(false);
    const { offer, released } = armed;
    let folder = null;
    try { folder = released.point ? await this.resolveDropFolder(released.point) : null; }
    catch (error) { this.#log('file.drag.folder-failed', { message: error?.message || String(error) }); }
    const target = folder || this.fallbackFolder();
    try {
      await this.transfer.accept(offer.id, target);
      this.onHint(`Receiving ${describe(offer)} into ${path.basename(target) || target}`);
      this.#log('file.drag.dropped', { items: offer.count, detected: Boolean(folder) });
    } catch (error) {
      this.transfer.reject(offer.id, 'unavailable');
      this.onHint('Could not receive the dragged files here.');
      this.#log('file.drag.accept-failed', { code: error?.code || null });
    }
  }
}

module.exports = { FileDrag, seamRect, ESCAPE_HID, OFFER_WAIT_MS, EDGE_DWELL_MS };
