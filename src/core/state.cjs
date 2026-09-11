'use strict';

const {
  EDGES,
  TOP_BAR_HEIGHT,
  clamp,
  normalizeLayout,
  buildTopology,
  viewportsForActor,
  actorHasViewport,
  actorHasInterior,
  actorHasTopBarPoint,
  placeOnDisplay,
  ensureReachable,
  normalizeLogicalRect,
} = require('./geometry.cjs');

const DRAG_LEASE_MS = 2000;
const MAX_DRAG_DELTA = 512;
const TOKEN = /^[A-Za-z0-9_-]{8,80}$/;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const idsOf = (members) => members.map((member) => typeof member === 'string' ? member : member?.id).filter(Boolean);

function initialState(id, now = Date.now(), reportedLayout = null) {
  const layout = normalizeLayout(reportedLayout);
  const layouts = layout ? { [id]: layout } : {};
  const topology = buildTopology(layouts, [id]);
  const baseRect = normalizeLogicalRect({ x: 0, y: 0, width: 900, height: 600 });
  return {
    version: 2,
    revision: 0,
    open: true,
    window: { rect: layout ? placeOnDisplay(baseRect, topology, id) : baseRect },
    layouts,
    topology,
    drag: null,
    cursor: { x: 0.5, y: 0.5, active: [], buttons: {}, trail: [] },
    scene: { epoch: now },
    click: null,
  };
}

function withoutInput(cursor, actor) {
  cursor.active = cursor.active.filter((id) => id !== actor);
  delete cursor.buttons[actor];
}

function clearInput(cursor) {
  cursor.active = [];
  cursor.buttons = {};
}

function trimInputForVisibility(state) {
  state.cursor.active = state.cursor.active.filter((actor) =>
    state.open && !state.drag && actorHasInterior(state.window.rect, state.topology, actor));
  for (const actor of Object.keys(state.cursor.buttons)) {
    if (!state.cursor.active.includes(actor)) delete state.cursor.buttons[actor];
  }
}

// Only the host reduces actions. Geometry determines local visibility; there
// is no independently mutable list of views and no transfer/handoff event.
function reduce(state, actor, action, members, now = Date.now()) {
  const memberIds = idsOf(members);
  if (!memberIds.includes(actor) || !action || typeof action !== 'object') return state;
  const rect = state.window.rect;
  const canPoint = state.open && !state.drag && actorHasInterior(rect, state.topology, actor);

  switch (action.type) {
    case 'open': {
      if (state.open) return state;
      const next = structuredClone(state);
      next.open = true;
      next.drag = null;
      clearInput(next.cursor);
      next.window.rect = placeOnDisplay(rect, next.topology, actor);
      next.revision++;
      return next;
    }
    case 'close': {
      if (!state.open && !state.drag && !state.cursor.active.length && !Object.keys(state.cursor.buttons).length) return state;
      const next = structuredClone(state);
      next.open = false;
      next.drag = null;
      clearInput(next.cursor);
      next.revision++;
      return next;
    }
    case 'place-here': {
      if (!state.topology.displays.some((display) => display.memberId === actor)) return state;
      const placed = placeOnDisplay(rect, state.topology, actor);
      if (state.open && !state.drag && sameRect(placed, rect)) return state;
      const next = structuredClone(state);
      next.open = true;
      next.drag = null;
      clearInput(next.cursor);
      next.window.rect = placed;
      next.revision++;
      return next;
    }
    case 'layout': {
      const layout = normalizeLayout(action.layout);
      if (!layout || layout.revision <= (state.layouts[actor]?.revision ?? -1)) return state;
      const next = structuredClone(state);
      if (next.drag) {
        next.window.rect = next.drag.startRect;
        next.drag = null;
      }
      next.layouts[actor] = layout;
      // Do not retain stale displays from a peer that is no longer a member.
      for (const id of Object.keys(next.layouts)) if (!memberIds.includes(id)) delete next.layouts[id];
      next.topology = buildTopology(next.layouts, memberIds);
      if (next.open) next.window.rect = ensureReachable(next.window.rect, next.topology, actor);
      trimInputForVisibility(next);
      next.revision++;
      return next;
    }
    case 'enter': {
      if (!canPoint || !finite(action.x) || !finite(action.y)) return state;
      const next = structuredClone(state);
      if (!next.cursor.active.length) {
        next.cursor.x = clamp(action.x, 0, 1);
        next.cursor.y = clamp(action.y, 0, 1);
      }
      if (next.cursor.active.includes(actor)) return state;
      next.cursor.active.push(actor);
      next.revision++;
      return next;
    }
    case 'leave': {
      if (!state.cursor.active.includes(actor) && state.cursor.buttons[actor] === undefined) return state;
      const next = structuredClone(state);
      withoutInput(next.cursor, actor);
      next.revision++;
      return next;
    }
    case 'move': {
      if (!canPoint || !state.cursor.active.includes(actor) || !finite(action.dx) || !finite(action.dy)
        || Math.abs(action.dx) > 2 || Math.abs(action.dy) > 2) return state;
      const next = structuredClone(state);
      const cursor = next.cursor;
      cursor.x = clamp(cursor.x + action.dx, 0, 1);
      cursor.y = clamp(cursor.y + action.dy, 0, 1);
      if (!cursor.trail.length || now - cursor.trail.at(-1).t >= 24) {
        cursor.trail = cursor.trail.filter((point) => now - point.t < 1400).slice(-47);
        cursor.trail.push({ x: cursor.x, y: cursor.y, t: now, serial: state.revision + 1 });
      }
      next.revision++;
      return next;
    }
    case 'button': {
      if (!canPoint || !state.cursor.active.includes(actor) || !Number.isInteger(action.buttons)
        || action.buttons < 0 || action.buttons > 31) return state;
      const next = structuredClone(state);
      next.cursor.buttons[actor] = action.buttons;
      if (action.buttons & 1) next.click = { serial: state.revision + 1, x: next.cursor.x, y: next.cursor.y };
      next.revision++;
      return next;
    }
    case 'resize': {
      if (!state.open || state.drag || !actorHasViewport(rect, state.topology, actor)
        || !finite(action.width) || !finite(action.height)) return state;
      const resized = normalizeLogicalRect({ ...rect, width: action.width, height: action.height });
      const reachable = ensureReachable(resized, state.topology, actor);
      if (sameRect(reachable, rect)) return state;
      const next = structuredClone(state);
      next.window.rect = reachable;
      next.revision++;
      return next;
    }
    case 'drag-start': {
      if (!state.open || state.drag || typeof action.id !== 'string' || !TOKEN.test(action.id)
        || !actorHasTopBarPoint(rect, state.topology, actor, action.offsetX, action.offsetY)) return state;
      const next = structuredClone(state);
      clearInput(next.cursor);
      next.drag = {
        id: action.id,
        owner: actor,
        offsetX: action.offsetX,
        offsetY: action.offsetY,
        startRect: structuredClone(rect),
        lastSeq: 0,
        leaseUntil: now + DRAG_LEASE_MS,
      };
      next.revision++;
      return next;
    }
    case 'drag-move': {
      if (!state.drag || state.drag.owner !== actor || action.id !== state.drag.id
        || !Number.isSafeInteger(action.seq) || action.seq !== state.drag.lastSeq + 1
        || !Number.isInteger(action.dx) || !Number.isInteger(action.dy)
        || Math.abs(action.dx) > MAX_DRAG_DELTA || Math.abs(action.dy) > MAX_DRAG_DELTA) return state;
      const next = structuredClone(state);
      next.window.rect = normalizeLogicalRect({
        ...rect,
        x: rect.x + action.dx,
        y: rect.y + action.dy,
      });
      next.drag.lastSeq = action.seq;
      next.drag.leaseUntil = now + DRAG_LEASE_MS;
      next.revision++;
      return next;
    }
    case 'drag-end': {
      if (!state.drag || state.drag.owner !== actor || action.id !== state.drag.id) return state;
      const next = structuredClone(state);
      next.drag = null;
      next.window.rect = ensureReachable(next.window.rect, next.topology, actor);
      next.revision++;
      return next;
    }
    case 'drag-cancel': {
      if (!state.drag || state.drag.owner !== actor || action.id !== state.drag.id) return state;
      const next = structuredClone(state);
      next.window.rect = ensureReachable(next.drag.startRect, next.topology, actor);
      next.drag = null;
      next.revision++;
      return next;
    }
    default:
      return state;
  }
}

function disconnect(state, id, remaining) {
  const remainingIds = idsOf(remaining);
  const next = structuredClone(state);
  withoutInput(next.cursor, id);
  // A topology change invalidates the drag coordinate stream even if the
  // disappearing member did not own it. Restore the transaction start first.
  if (next.drag) {
    next.window.rect = next.drag.startRect;
    next.drag = null;
    clearInput(next.cursor);
  }
  for (const memberId of Object.keys(next.layouts)) if (!remainingIds.includes(memberId)) delete next.layouts[memberId];
  next.topology = buildTopology(next.layouts, remainingIds);
  if (next.open) next.window.rect = ensureReachable(next.window.rect, next.topology, remainingIds[0]);
  trimInputForVisibility(next);
  next.revision++;
  return next;
}

module.exports = {
  initialState,
  reduce,
  disconnect,
  clamp,
  EDGES,
  TOP_BAR_HEIGHT,
  DRAG_LEASE_MS,
  MAX_DRAG_DELTA,
  viewportsForActor,
};
