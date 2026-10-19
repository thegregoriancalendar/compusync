'use strict';

const MAX_DIMENSION_VU = 65536;
const MAX_SCALE = 8;
const MIN_SCALE = .25;
const POSITION_EPSILON = 1e-6;
const CROSSING_EDGES = Object.freeze(['left', 'right', 'top', 'bottom']);
const MAC_POSITIONS = Object.freeze(['left', 'right', 'top']);
const MIN_SHARED_EDGE_RATIO = .2;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function normalizePhysicalDisplays(value) {
  if (!Array.isArray(value) || !value.length || value.length > 8) return null;
  const displays = [];
  for (const display of value) {
    if (typeof display?.id !== 'string' || !display.id.length || display.id.length > 100
      || ![display.origin?.x, display.origin?.y, display.size?.w, display.size?.h].every(finite)
      || Math.abs(display.origin.x) > MAX_DIMENSION_VU || Math.abs(display.origin.y) > MAX_DIMENSION_VU
      || display.size.w <= 0 || display.size.h <= 0 || display.size.w > MAX_DIMENSION_VU || display.size.h > MAX_DIMENSION_VU) return null;
    const mm = display.physicalSizeMm;
    if (mm !== undefined && (![mm?.w, mm?.h].every(finite)
      || mm.w < 10 || mm.h < 10 || mm.w > 20000 || mm.h > 20000)) return null;
    displays.push({ id: display.id, origin: { x: display.origin.x, y: display.origin.y }, size: { w: display.size.w, h: display.size.h },
      ...(mm ? { physicalSizeMm: { w: mm.w, h: mm.h } } : {}) });
  }
  return displays;
}

function normalizePlacement(value) {
  if (!value || typeof value !== 'object' || typeof value.machineId !== 'string'
    || !value.machineId.length || value.machineId.length > 80
    || !finite(value.origin?.x) || !finite(value.origin?.y)
    || Math.abs(value.origin.x) > MAX_DIMENSION_VU || Math.abs(value.origin.y) > MAX_DIMENSION_VU
    || !finite(value.size?.w) || !finite(value.size?.h)
    || value.size.w <= 0 || value.size.h <= 0
    || value.size.w > MAX_DIMENSION_VU || value.size.h > MAX_DIMENSION_VU
    || !finite(value.scale) || value.scale < MIN_SCALE || value.scale > MAX_SCALE) return null;
  const physicalDisplays = normalizePhysicalDisplays(value.physicalDisplays);
  return {
    machineId: value.machineId,
    ...(value.platform === 'darwin' || value.platform === 'win32' ? { platform: value.platform } : {}),
    origin: { x: value.origin.x, y: value.origin.y },
    size: { w: value.size.w, h: value.size.h },
    scale: value.scale,
    ...(physicalDisplays ? { physicalDisplays } : {}),
  };
}

function rectFor(placement) {
  return {
    x: placement.origin.x,
    y: placement.origin.y,
    w: placement.size.w,
    h: placement.size.h,
  };
}

function toLocal(pointVU, placement) {
  return {
    x: (pointVU.x - placement.origin.x) * placement.scale,
    y: (pointVU.y - placement.origin.y) * placement.scale,
  };
}

function toVirtual(pointPx, placement) {
  return {
    x: pointPx.x / placement.scale + placement.origin.x,
    y: pointPx.y / placement.scale + placement.origin.y,
  };
}

function containsPoint(placement, point, inclusive = false) {
  const right = placement.origin.x + placement.size.w;
  const bottom = placement.origin.y + placement.size.h;
  return point.x >= placement.origin.x && point.y >= placement.origin.y
    && (inclusive ? point.x <= right && point.y <= bottom : point.x < right && point.y < bottom);
}

function clampToPlacement(point, placement) {
  return {
    x: clamp(point.x, placement.origin.x, placement.origin.x + placement.size.w - POSITION_EPSILON),
    y: clamp(point.y, placement.origin.y, placement.origin.y + placement.size.h - POSITION_EPSILON),
  };
}

function ownerAt(point, placements) {
  return placements.find((placement) => containsPoint(placement, point))?.machineId || null;
}

function overlap(first, second) {
  const a = rectFor(first), b = rectFor(second);
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { w, h } : null;
}

function ensureNonOverlapping(values, logger = null) {
  const placements = values.map((value) => normalizePlacement(value));
  if (placements.some((value) => !value)) throw new TypeError('Invalid screen placement.');
  for (let index = 1; index < placements.length; index += 1) {
    let moved = false;
    for (let previous = 0; previous < index; previous += 1) {
      if (!overlap(placements[previous], placements[index])) continue;
      placements[index].origin.x = placements[previous].origin.x + placements[previous].size.w;
      moved = true;
      previous = -1;
    }
    if (moved) logger?.warn?.(`Screen placement ${placements[index].machineId} overlapped another screen and was moved right.`);
  }
  return placements;
}

// Places `second` on the configured side of `first`. The offset is measured
// from centered alignment, in VU.
function layoutPair(firstValue, secondValue, options = {}) {
  const first = normalizePlacement(firstValue), second = normalizePlacement(secondValue);
  if (!first || !second) throw new TypeError('Invalid screen placement.');
  const side = options.secondSide || options.screenSide || 'right';
  const offset = finite(options.verticalOffsetVU) ? options.verticalOffsetVU : 0;
  if (!CROSSING_EDGES.includes(side)) throw new TypeError('The shared edge must be left, right, or bottom.');
  if (side === 'right' || side === 'left') {
    second.origin.y = first.origin.y + (first.size.h - second.size.h) / 2 + offset;
    second.origin.x = side === 'right'
      ? first.origin.x + first.size.w
      : first.origin.x - second.size.w;
  } else if (side === 'bottom') {
    second.origin.x = first.origin.x + (first.size.w - second.size.w) / 2 + offset;
    second.origin.y = first.origin.y + first.size.h;
  } else {
    second.origin.x = first.origin.x + (first.size.w - second.size.w) / 2 + offset;
    second.origin.y = first.origin.y - second.size.h;
  }
  return ensureNonOverlapping([first, second], options.logger);
}

function layoutMacAndWindows(windowsValue, macValue, options = {}) {
  const windows = normalizePlacement(windowsValue), mac = normalizePlacement(macValue);
  if (!windows || !mac) throw new TypeError('Valid Mac and Windows placements are required.');
  const macPosition = MAC_POSITIONS.includes(options.macPosition) ? options.macPosition : 'left';
  const alignment = clamp(finite(options.displayOffset) ? options.displayOffset : 0, -1, 1);
  windows.origin = { x: 0, y: 0 };
  if (macPosition === 'left' || macPosition === 'right') {
    const minimumSeam = Math.min(windows.size.h, mac.size.h) * MIN_SHARED_EDGE_RATIO;
    const maximumOffset = Math.max(0, (windows.size.h + mac.size.h) / 2 - minimumSeam);
    mac.origin.y = (windows.size.h - mac.size.h) / 2 + alignment * maximumOffset;
    mac.origin.x = macPosition === 'left' ? -mac.size.w : windows.size.w;
  } else {
    const minimumSeam = Math.min(windows.size.w, mac.size.w) * MIN_SHARED_EDGE_RATIO;
    const maximumOffset = Math.max(0, (windows.size.w + mac.size.w) / 2 - minimumSeam);
    mac.origin.x = (windows.size.w - mac.size.w) / 2 + alignment * maximumOffset;
    mac.origin.y = -mac.size.h;
  }
  return ensureNonOverlapping([windows, mac], options.logger);
}

function boundingRect(displays) {
  if (!Array.isArray(displays) || !displays.length) return null;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const display of displays) {
    const bounds = display?.bounds;
    if (!bounds || !finite(bounds.x) || !finite(bounds.y)
      || !finite(bounds.width) || !finite(bounds.height)
      || bounds.width <= 0 || bounds.height <= 0) return null;
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// Electron reports display bounds in logical coordinates. Native callers can
// pass the same shape after converting their full-desktop pixel bounds to VU.
function placementFromDisplays(machineId, displays, options = {}) {
  const bounds = boundingRect(displays);
  if (!bounds) throw new TypeError('At least one valid display is required.');
  const preferred = displays.find((display) => display.primary) || displays[0];
  const scale = finite(options.scale) ? options.scale : preferred.scaleFactor;
  const placement = normalizePlacement({
    machineId,
    ...(options.platform ? { platform: options.platform } : {}),
    origin: options.origin || { x: 0, y: 0 },
    size: { w: bounds.width, h: bounds.height },
    scale,
  });
  if (!placement) throw new TypeError('Invalid desktop metrics.');
  return placement;
}

function crossingTarget(owner, candidate, placements) {
  const left = owner.origin.x;
  const right = left + owner.size.w;
  const top = owner.origin.y;
  const bottom = top + owner.size.h;
  let edge = null;
  if (candidate.x < left) edge = 'left';
  else if (candidate.x >= right) edge = 'right';
  else if (candidate.y < top && owner.platform === 'win32') edge = 'top';
  else if (candidate.y >= bottom) edge = 'bottom';
  // The Mac top edge remains clamped so the menu bar is never a seam.
  if (!edge) return null;
  const candidates = placements.filter((placement) => {
    if (placement.machineId === owner.machineId) return false;
    const sharesVerticalPoint = candidate.y >= placement.origin.y
      && candidate.y < placement.origin.y + placement.size.h;
    const sharesHorizontalPoint = candidate.x >= placement.origin.x
      && candidate.x < placement.origin.x + placement.size.w;
    if (edge === 'right') return placement.origin.x >= right - POSITION_EPSILON && sharesVerticalPoint;
    if (edge === 'left') return placement.origin.x + placement.size.w <= left + POSITION_EPSILON && sharesVerticalPoint;
    if (edge === 'top') return placement.origin.y + placement.size.h <= top + POSITION_EPSILON && sharesHorizontalPoint;
    return placement.origin.y >= bottom - POSITION_EPSILON && sharesHorizontalPoint;
  });
  if (!candidates.length) return null;
  const distance = (placement) => {
    if (edge === 'right') return Math.abs(placement.origin.x - right);
    if (edge === 'left') return Math.abs(left - placement.origin.x - placement.size.w);
    if (edge === 'top') return Math.abs(top - placement.origin.y - placement.size.h);
    return Math.abs(placement.origin.y - bottom);
  };
  candidates.sort((a, b) => distance(a) - distance(b));
  return { edge, placement: candidates[0] };
}

module.exports = {
  MAX_DIMENSION_VU,
  MIN_SCALE,
  MAX_SCALE,
  POSITION_EPSILON,
  CROSSING_EDGES,
  normalizePlacement,
  normalizePhysicalDisplays,
  rectFor,
  toLocal,
  toVirtual,
  containsPoint,
  clampToPlacement,
  ownerAt,
  overlap,
  ensureNonOverlapping,
  layoutPair,
  layoutMacAndWindows,
  boundingRect,
  placementFromDisplays,
  crossingTarget,
};
