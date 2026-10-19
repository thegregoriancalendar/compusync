'use strict';

const { normalizePlacement, ensureNonOverlapping } = require('./virtualspace.cjs');

const MAX_URL_LENGTH = 8192;
const MAX_TABS = 200;
// A worst-case valid descriptor can carry 200 8KiB tab URLs plus bounded
// bounded per-tab history. The authenticated transport must route this reliable
// control message over a channel with a matching cap.
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_COORDINATE = 65536;
const BUTTONS = new Set(['left', 'right', 'middle', 'x1', 'x2']);
const WINNERS = new Set(['source', 'destination']);
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const text = (value, maximum) => typeof value === 'string' && value.length <= maximum;

const MESSAGE_POLICIES = Object.freeze({
  'cursor.delta': { reliable: false, ordered: false, priority: 'realtime' },
  'cursor.position': { reliable: false, ordered: false, priority: 'realtime' },
  'scroll.delta': { reliable: false, ordered: false, priority: 'realtime' },
  'window.position': { reliable: false, ordered: false, priority: 'realtime' },
  'cursor.handoff': { reliable: true, ordered: true, priority: 'control' },
  'cursor.mode': { reliable: true, ordered: true, priority: 'control' },
  'cursor.layout': { reliable: true, ordered: true, priority: 'control' },
  'cursor.feel': { reliable: true, ordered: true, priority: 'control' },
  'cursor.button': { reliable: true, ordered: true, priority: 'control' },
  'key.event': { reliable: true, ordered: true, priority: 'control' },
  'window.offer': { reliable: true, ordered: true, priority: 'control' },
  'window.ready': { reliable: true, ordered: true, priority: 'control' },
  'window.commit': { reliable: true, ordered: true, priority: 'control' },
  'window.committed': { reliable: true, ordered: true, priority: 'control' },
  'window.abort': { reliable: true, ordered: true, priority: 'control' },
  'layout.update': { reliable: true, ordered: true, priority: 'control' },
  heartbeat: { reliable: true, ordered: true, priority: 'control' },
});

function validUrl(value) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value, 'utf8') > MAX_URL_LENGTH) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function sanitizeHistory(value) {
  if (value === undefined) return undefined;
  if (!value || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > 200
    || !integer(value.currentIndex, 0, value.entries.length - 1)
    || !value.entries.every(validUrl)) return null;
  return { currentIndex: value.currentIndex, entries: [...value.entries] };
}

function sanitizeWindowDescriptor(value) {
  if (!value || value.schemaVersion !== 1 || !ID.test(value.id || '')
    || value.adapterId !== 'chrome' || !ID.test(value.origin || '')
    || !finite(value.capturedAt) || !['normal', 'maximized'].includes(value.state)) return null;
  const geometry = value.geometryVU;
  if (!geometry || !finite(geometry.x) || !finite(geometry.y)
    || !finite(geometry.w) || !finite(geometry.h)
    || geometry.w <= 0 || geometry.h <= 0) return null;
  const clampedGeometry = {
    x: Math.min(MAX_COORDINATE, Math.max(-MAX_COORDINATE, geometry.x)),
    y: Math.min(MAX_COORDINATE, Math.max(-MAX_COORDINATE, geometry.y)),
    w: Math.min(MAX_COORDINATE, Math.max(1, geometry.w)),
    h: Math.min(MAX_COORDINATE, Math.max(1, geometry.h)),
  };
  const payload = value.payload;
  if (!payload || !Array.isArray(payload.tabs) || !payload.tabs.length || payload.tabs.length > MAX_TABS
    || !integer(payload.activeIdx, 0, payload.tabs.length - 1)) return null;
  const indices = new Set();
  const tabs = [];
  for (let tabPosition = 0; tabPosition < payload.tabs.length; tabPosition += 1) {
    const candidate = payload.tabs[tabPosition];
    const history = sanitizeHistory(candidate?.history);
    if (!candidate || !validUrl(candidate.url) || !text(candidate.title, 1024)
      || typeof candidate.pinned !== 'boolean'
      || !integer(candidate.index, 0, payload.tabs.length - 1) || indices.has(candidate.index)
      || history === null) return null;
    indices.add(candidate.index);
    const tab = {
      url: candidate.url,
      title: candidate.title,
      pinned: candidate.pinned,
      index: candidate.index,
    };
    if (history) tab.history = history;
    tabs.push(tab);
  }
  if (indices.size !== payload.tabs.length) return null;
  return {
    schemaVersion: 1,
    id: value.id,
    adapterId: 'chrome',
    origin: value.origin,
    capturedAt: value.capturedAt,
    geometryVU: clampedGeometry,
    state: value.state,
    payload: { activeIdx: payload.activeIdx, tabs },
  };
}

function sanitizePeerMessage(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.hasOwn(MESSAGE_POLICIES, value.type)) return null;
  let result = null;
  switch (value.type) {
    case 'cursor.delta':
      if (finite(value.dx) && finite(value.dy) && finite(value.t)
        && Math.abs(value.dx) <= MAX_COORDINATE && Math.abs(value.dy) <= MAX_COORDINATE) {
        result = { type: value.type, dx: value.dx, dy: value.dy, t: value.t };
      }
      break;
    case 'cursor.position':
      if (finite(value.x) && finite(value.y) && finite(value.t)
        && Math.abs(value.x) <= MAX_COORDINATE && Math.abs(value.y) <= MAX_COORDINATE) {
        result = { type: value.type, x: value.x, y: value.y, t: value.t };
      }
      break;
    case 'scroll.delta':
      if (finite(value.dy) && value.dy !== 0 && Math.abs(value.dy) <= 1000) {
        result = { type: value.type, dy: value.dy };
      }
      break;
    case 'cursor.handoff':
      if (finite(value.x) && finite(value.y)
        && Math.abs(value.x) <= MAX_COORDINATE && Math.abs(value.y) <= MAX_COORDINATE
        && integer(value.buttons, 0, 31) && integer(value.modifiers, 0, 65535)
        && (value.managedDrag === undefined || typeof value.managedDrag === 'boolean')) {
        result = { type: value.type, x: value.x, y: value.y, buttons: value.buttons, modifiers: value.modifiers };
        if (value.managedDrag === true) result.managedDrag = true;
      }
      break;
    case 'cursor.mode':
      if (typeof value.linked === 'boolean') result = { type: value.type, linked: value.linked };
      break;
    case 'cursor.layout':
      if (['left', 'right', 'top'].includes(value.macPosition)
        && finite(value.displayOffset) && Math.abs(value.displayOffset) <= 1) {
        result = { type: value.type, macPosition: value.macPosition, displayOffset: value.displayOffset };
      }
      break;
    case 'cursor.feel': {
      const acceleration = value.acceleration;
      if (acceleration && finite(acceleration.base) && acceleration.base >= 0.05 && acceleration.base <= 8
        && finite(acceleration.threshold) && acceleration.threshold >= 0 && acceleration.threshold <= 20
        && finite(acceleration.slope) && acceleration.slope >= 0 && acceleration.slope <= 1) {
        result = { type: value.type, acceleration: {
          base: acceleration.base,
          threshold: acceleration.threshold,
          slope: acceleration.slope,
        } };
      }
      break;
    }
    case 'cursor.button':
      if (BUTTONS.has(value.button) && typeof value.down === 'boolean') {
        result = { type: value.type, button: value.button, down: value.down };
      }
      break;
    case 'key.event':
      if (integer(value.code, 0, 65535) && typeof value.down === 'boolean'
        && integer(value.modifiers, 0, 65535)) {
        result = { type: value.type, code: value.code, down: value.down, modifiers: value.modifiers };
      }
      break;
    case 'window.offer': {
      const descriptor = sanitizeWindowDescriptor(value.descriptor);
      if (descriptor) result = { type: value.type, descriptor };
      break;
    }
    case 'window.ready':
    case 'window.committed':
      if (ID.test(value.id || '')) result = { type: value.type, id: value.id };
      break;
    case 'window.position': {
      const sequence = value.sequence === undefined ? 0 : value.sequence;
      if (ID.test(value.id || '') && finite(value.originVU?.x) && finite(value.originVU?.y)
        && Math.abs(value.originVU.x) <= MAX_COORDINATE && Math.abs(value.originVU.y) <= MAX_COORDINATE
        && integer(sequence, 0, Number.MAX_SAFE_INTEGER)) {
        result = { type: value.type, id: value.id, sequence,
          originVU: { x: value.originVU.x, y: value.originVU.y } };
      }
      break;
    }
    case 'window.commit':
      if (ID.test(value.id || '') && WINNERS.has(value.winner)) {
        result = { type: value.type, id: value.id, winner: value.winner };
      }
      break;
    case 'window.abort':
      if (ID.test(value.id || '') && text(value.reason, 500)) {
        result = { type: value.type, id: value.id, reason: value.reason };
      }
      break;
    case 'layout.update': {
      if (!Array.isArray(value.placements) || !value.placements.length || value.placements.length > 8) break;
      const placements = value.placements.map(normalizePlacement);
      if (placements.some((placement) => !placement)
        || new Set(placements.map((placement) => placement.machineId)).size !== placements.length) break;
      result = { type: value.type, placements: ensureNonOverlapping(placements, options.logger) };
      break;
    }
    case 'heartbeat':
      if (finite(value.t)) result = { type: value.type, t: value.t };
      break;
    default:
      break;
  }
  if (!result) return null;
  try {
    return Buffer.byteLength(JSON.stringify(result)) <= MAX_MESSAGE_BYTES ? result : null;
  } catch {
    return null;
  }
}

function policyForMessage(type) {
  return MESSAGE_POLICIES[type] || null;
}

module.exports = {
  MAX_URL_LENGTH,
  MAX_TABS,
  MAX_MESSAGE_BYTES,
  MESSAGE_POLICIES,
  validUrl,
  sanitizeWindowDescriptor,
  sanitizePeerMessage,
  policyForMessage,
};
