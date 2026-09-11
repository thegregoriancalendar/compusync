'use strict';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const EDGES = ['left', 'right', 'top', 'bottom'];

function initialState(id, now = Date.now()) {
  return {
    version: 1, revision: 0, open: true, views: [id],
    size: { width: 900, height: 600 },
    cursor: { x: 0.5, y: 0.5, active: [], buttons: {}, trail: [] },
    scene: { epoch: now },
    click: null, handoff: null,
  };
}

// Only the host reduces actions. Relative deltas let both trackpads contribute
// without one laptop repeatedly overwriting the other's absolute position.
function reduce(state, actor, action, members, now = Date.now()) {
  if (!members.includes(actor) || !action || typeof action !== 'object') return state;
  const next = structuredClone(state);
  const cursor = next.cursor;
  const canPoint = state.open && state.views.includes(actor);
  switch (action.type) {
    case 'open':
      next.open = true;
      next.views = [...members];
      break;
    case 'show':
      next.open = true;
      next.views = state.open ? [...new Set([...state.views, actor])] : [...members];
      break;
    case 'close':
      next.open = false;
      next.views = [];
      cursor.active = [];
      cursor.buttons = {};
      break;
    case 'enter':
      if (!canPoint) return state;
      if (!cursor.active.length && finite(action.x) && finite(action.y)) {
        cursor.x = clamp(action.x, 0, 1);
        cursor.y = clamp(action.y, 0, 1);
      }
      cursor.active = [...new Set([...cursor.active, actor])];
      break;
    case 'leave':
      cursor.active = cursor.active.filter((id) => id !== actor);
      delete cursor.buttons[actor];
      break;
    case 'move':
      if (!canPoint || !cursor.active.includes(actor) || !finite(action.dx) || !finite(action.dy)) return state;
      if (Math.abs(action.dx) > 2 || Math.abs(action.dy) > 2) return state;
      cursor.x = clamp(cursor.x + action.dx, 0, 1);
      cursor.y = clamp(cursor.y + action.dy, 0, 1);
      if (!cursor.trail.length || now - cursor.trail.at(-1).t >= 24) {
        cursor.trail = cursor.trail.filter((point) => now - point.t < 1400).slice(-47);
        cursor.trail.push({ x: cursor.x, y: cursor.y, t: now, serial: state.revision + 1 });
      }
      break;
    case 'button':
      if (!canPoint || !cursor.active.includes(actor) || !Number.isInteger(action.buttons) || action.buttons < 0 || action.buttons > 31) return state;
      cursor.buttons[actor] = action.buttons;
      if (action.buttons & 1) next.click = { serial: state.revision + 1, x: cursor.x, y: cursor.y };
      break;
    case 'resize':
      if (!canPoint || !finite(action.width) || !finite(action.height)) return state;
      next.size = { width: Math.round(clamp(action.width, 360, 2560)), height: Math.round(clamp(action.height, 240, 1600)) };
      break;
    case 'handoff': {
      const target = members.find((id) => id !== actor);
      if (!target || !canPoint || !EDGES.includes(action.edge) || !finite(action.ratio)) return state;
      next.views = [...new Set([...state.views.filter((id) => id !== actor), target])];
      cursor.active = cursor.active.filter((id) => id !== actor);
      delete cursor.buttons[actor];
      next.handoff = { serial: state.revision + 1, from: actor, to: target, edge: action.edge, ratio: clamp(action.ratio, 0, 1) };
      break;
    }
    default:
      return state;
  }
  next.revision++;
  return next;
}

function disconnect(state, id, remaining) {
  const next = structuredClone(state);
  next.cursor.active = next.cursor.active.filter((member) => member !== id);
  delete next.cursor.buttons[id];
  next.views = next.views.filter((member) => member !== id);
  // If the only visible laptop disappears, recover the window on the host.
  if (next.open && !next.views.length) next.views = [...remaining];
  next.revision++;
  return next;
}

module.exports = { initialState, reduce, disconnect, clamp, EDGES };
