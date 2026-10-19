'use strict';

const { normalizePhysicalDisplays } = require('../main/virtualspace.cjs');

const EDGES = ['left', 'right', 'top', 'bottom'];
const TOP_BAR_HEIGHT = 36;
const MIN_LOGICAL_WIDTH = 360;
const MIN_LOGICAL_HEIGHT = 240;
const MAX_LOGICAL_WIDTH = 2560;
const MAX_LOGICAL_HEIGHT = 1600;
const MAX_VIRTUAL_COORDINATE = 65536;
const MAX_DISPLAYS_PER_MEMBER = 8;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const integer = (value) => Number.isSafeInteger(value);
const copyRect = (rect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });

function validRect(rect, maximumDimension = 16384) {
  return rect && integer(rect.x) && integer(rect.y)
    && integer(rect.width) && integer(rect.height)
    && Math.abs(rect.x) <= MAX_VIRTUAL_COORDINATE
    && Math.abs(rect.y) <= MAX_VIRTUAL_COORDINATE
    && rect.width >= 1 && rect.height >= 1
    && rect.width <= maximumDimension && rect.height <= maximumDimension;
}

function contains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

function normalizeDesktop(desktop) {
  if (desktop == null) return null;
  if (!finite(desktop.widthVU) || !finite(desktop.heightVU)
    || desktop.widthVU < 1 || desktop.heightVU < 1
    || desktop.widthVU > MAX_VIRTUAL_COORDINATE || desktop.heightVU > MAX_VIRTUAL_COORDINATE
    || !finite(desktop.scale) || desktop.scale < .25 || desktop.scale > 8) return false;
  const physicalDisplays = normalizePhysicalDisplays(desktop.physicalDisplays);
  return { widthVU: desktop.widthVU, heightVU: desktop.heightVU, scale: desktop.scale,
    ...(physicalDisplays ? { physicalDisplays } : {}) };
}

// Layout reports use Electron DIP coordinates. More than one display may be
// reported so the wire format can grow without another schema change, while
// activeDisplayId selects the single display participating in this topology.
function normalizeLayout(layout) {
  if (!layout || typeof layout !== 'object' || !integer(layout.revision) || layout.revision < 0
    || !EDGES.includes(layout.edge) || typeof layout.activeDisplayId !== 'string'
    || !layout.activeDisplayId.length || layout.activeDisplayId.length > 80
    || !Array.isArray(layout.displays) || !layout.displays.length
    || layout.displays.length > MAX_DISPLAYS_PER_MEMBER) return null;

  const desktop = normalizeDesktop(layout.desktop);
  if (desktop === false) return null;
  const ids = new Set();
  const displays = [];
  for (const display of layout.displays) {
    if (!display || typeof display !== 'object' || typeof display.id !== 'string'
      || !display.id.length || display.id.length > 80 || ids.has(display.id)
      || !validRect(display.bounds) || !validRect(display.workArea)
      || !contains(display.bounds, display.workArea)
      || !finite(display.scaleFactor) || display.scaleFactor < .5 || display.scaleFactor > 8
      || (display.primary !== undefined && typeof display.primary !== 'boolean')) return null;
    ids.add(display.id);
    displays.push({
      id: display.id,
      bounds: copyRect(display.bounds),
      workArea: copyRect(display.workArea),
      scaleFactor: display.scaleFactor,
      primary: Boolean(display.primary),
    });
  }
  if (!ids.has(layout.activeDisplayId)) return null;
  return {
    revision: layout.revision,
    edge: layout.edge,
    ...(layout.platform === 'darwin' || layout.platform === 'win32' ? { platform: layout.platform } : {}),
    activeDisplayId: layout.activeDisplayId,
    displays,
    ...(desktop ? { desktop } : {}),
  };
}

function activeDisplay(layout) {
  return layout?.displays.find((display) => display.id === layout.activeDisplayId) || null;
}

function memberIds(members) {
  return members.map((member) => typeof member === 'string' ? member : member?.id).filter(Boolean);
}

// The first member is authoritative for arrangement. Its active work area is
// the virtual origin; the other member is attached flush to its configured
// edge and centered on the perpendicular axis.
function buildTopology(layouts, members) {
  const ids = memberIds(members);
  const anchorId = ids[0] || null;
  const anchorLayout = anchorId ? layouts[anchorId] : null;
  const anchorDisplay = activeDisplay(anchorLayout);
  const topology = {
    anchor: anchorId,
    edge: anchorLayout?.edge || 'right',
    align: .5,
    displays: [],
  };
  if (!anchorDisplay) return topology;

  const add = (memberId, display, virtualWorkArea) => topology.displays.push({
    memberId,
    displayId: display.id,
    localBounds: copyRect(display.bounds),
    localWorkArea: copyRect(display.workArea),
    virtualWorkArea,
    scaleFactor: display.scaleFactor,
  });
  const anchorArea = { x: 0, y: 0, width: anchorDisplay.workArea.width, height: anchorDisplay.workArea.height };
  add(anchorId, anchorDisplay, anchorArea);

  for (const id of ids.slice(1)) {
    const display = activeDisplay(layouts[id]);
    if (!display) continue;
    const width = display.workArea.width;
    const height = display.workArea.height;
    let x = Math.round((anchorArea.width - width) * topology.align);
    let y = Math.round((anchorArea.height - height) * topology.align);
    if (topology.edge === 'right') x = anchorArea.x + anchorArea.width;
    else if (topology.edge === 'left') x = anchorArea.x - width;
    else if (topology.edge === 'bottom') y = anchorArea.y + anchorArea.height;
    else y = anchorArea.y - height;
    add(id, display, { x, y, width, height });
  }
  return topology;
}

function intersectRect(first, second) {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function viewportsForActor(rect, topology, actor) {
  const result = [];
  for (const display of topology.displays) {
    if (display.memberId !== actor) continue;
    const intersection = intersectRect(rect, display.virtualWorkArea);
    if (!intersection) continue;
    result.push({
      memberId: actor,
      displayId: display.displayId,
      scaleFactor: display.scaleFactor,
      virtualBounds: intersection,
      nativeBounds: {
        x: display.localWorkArea.x + intersection.x - display.virtualWorkArea.x,
        y: display.localWorkArea.y + intersection.y - display.virtualWorkArea.y,
        width: intersection.width,
        height: intersection.height,
      },
      viewport: {
        x: intersection.x - rect.x,
        y: intersection.y - rect.y,
        width: intersection.width,
        height: intersection.height,
      },
      fullSize: { width: rect.width, height: rect.height },
    });
  }
  return result;
}

function actorHasViewport(rect, topology, actor) {
  return viewportsForActor(rect, topology, actor).length > 0;
}

function actorHasInterior(rect, topology, actor) {
  return viewportsForActor(rect, topology, actor).some(({ viewport }) =>
    viewport.y + viewport.height > TOP_BAR_HEIGHT && viewport.y < rect.height);
}

function actorHasTopBarPoint(rect, topology, actor, offsetX, offsetY) {
  if (!finite(offsetX) || !finite(offsetY) || offsetX < 0 || offsetX >= rect.width
    || offsetY < 0 || offsetY >= Math.min(TOP_BAR_HEIGHT, rect.height)) return false;
  return viewportsForActor(rect, topology, actor).some(({ viewport }) =>
    offsetX >= viewport.x && offsetX < viewport.x + viewport.width
    && offsetY >= viewport.y && offsetY < viewport.y + viewport.height);
}

function displayFor(topology, actor) {
  return topology.displays.find((display) => display.memberId === actor) || topology.displays[0] || null;
}

function placeOnDisplay(rect, topology, actor) {
  const display = displayFor(topology, actor);
  if (!display) return copyRect(rect);
  const area = display.virtualWorkArea;
  // Oversized windows start at the usable area's leading edge so their whole
  // top bar is not centered above or to the left of the reachable display.
  const x = rect.width <= area.width ? area.x + Math.round((area.width - rect.width) / 2) : area.x;
  const y = rect.height <= area.height ? area.y + Math.round((area.height - rect.height) / 2) : area.y;
  return { x, y, width: rect.width, height: rect.height };
}

function hasReachableBar(rect, topology) {
  const bar = { x: rect.x, y: rect.y, width: rect.width, height: Math.min(TOP_BAR_HEIGHT, rect.height) };
  const requiredWidth = Math.min(64, rect.width);
  return topology.displays.some((display) => {
    const intersection = intersectRect(bar, display.virtualWorkArea);
    if (!intersection) return false;
    const requiredHeight = Math.min(bar.height, display.virtualWorkArea.height);
    return intersection.width >= requiredWidth && intersection.height >= requiredHeight;
  });
}

function ensureReachable(rect, topology, preferredActor) {
  return hasReachableBar(rect, topology) ? copyRect(rect) : placeOnDisplay(rect, topology, preferredActor);
}

function normalizeLogicalRect(rect) {
  return {
    x: Math.round(clamp(finite(rect?.x) ? rect.x : 0, -MAX_VIRTUAL_COORDINATE, MAX_VIRTUAL_COORDINATE)),
    y: Math.round(clamp(finite(rect?.y) ? rect.y : 0, -MAX_VIRTUAL_COORDINATE, MAX_VIRTUAL_COORDINATE)),
    width: Math.round(clamp(finite(rect?.width) ? rect.width : 900, MIN_LOGICAL_WIDTH, MAX_LOGICAL_WIDTH)),
    height: Math.round(clamp(finite(rect?.height) ? rect.height : 600, MIN_LOGICAL_HEIGHT, MAX_LOGICAL_HEIGHT)),
  };
}

module.exports = {
  EDGES,
  TOP_BAR_HEIGHT,
  MIN_LOGICAL_WIDTH,
  MIN_LOGICAL_HEIGHT,
  MAX_LOGICAL_WIDTH,
  MAX_LOGICAL_HEIGHT,
  MAX_VIRTUAL_COORDINATE,
  clamp,
  normalizeLayout,
  buildTopology,
  intersectRect,
  viewportsForActor,
  actorHasViewport,
  actorHasInterior,
  actorHasTopBarPoint,
  placeOnDisplay,
  ensureReachable,
  hasReachableBar,
  normalizeLogicalRect,
};
