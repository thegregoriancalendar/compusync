'use strict';

const MAX_DIMENSION_VU = 65536;
const MAX_SCALE = 8;
const MIN_SCALE = .25;
const POSITION_EPSILON = 1e-6;
const CROSSING_EDGES = Object.freeze(['left', 'right', 'bottom']);

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function normalizePlacement(value) {
  if (!value || typeof value !== 'object' || typeof value.machineId !== 'string'
    || !value.machineId.length || value.machineId.length > 80
    || !finite(value.origin?.x) || !finite(value.origin?.y)
    || Math.abs(value.origin.x) > MAX_DIMENSION_VU || Math.abs(value.origin.y) > MAX_DIMENSION_VU
    || !finite(value.size?.w) || !finite(value.size?.h)
    || value.size.w <= 0 || value.size.h <= 0
    || value.size.w > MAX_DIMENSION_VU || value.size.h > MAX_DIMENSION_VU
    || !finite(value.scale) || value.scale < MIN_SCALE || value.scale > MAX_SCALE) return null;
  return {
    machineId: value.machineId,
    origin: { x: value.origin.x, y: value.origin.y },
    size: { w: value.size.w, h: value.size.h },
    scale: value.scale,
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
// from centered alignment, in VU. Top is deliberately unsupported because the
// macOS menu-bar edge can never participate in cursor crossing.
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
  } else {
    second.origin.x = first.origin.x + (first.size.w - second.size.w) / 2 + offset;
    second.origin.y = first.origin.y + first.size.h;
  }
  return ensureNonOverlapping([first, second], options.logger);
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
  else if (candidate.y >= bottom) edge = 'bottom';
  // Top is always clamped, including on Windows, so both peers agree.
  if (!edge) return null;
  const candidates = placements.filter((placement) => {
    if (placement.machineId === owner.machineId) return false;
    if (edge === 'right') return placement.origin.x >= right - POSITION_EPSILON;
    if (edge === 'left') return placement.origin.x + placement.size.w <= left + POSITION_EPSILON;
    return placement.origin.y >= bottom - POSITION_EPSILON;
  });
  if (!candidates.length) return null;
  const distance = (placement) => {
    if (edge === 'right') return Math.abs(placement.origin.x - right);
    if (edge === 'left') return Math.abs(left - placement.origin.x - placement.size.w);
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
  rectFor,
  toLocal,
  toVirtual,
  containsPoint,
  clampToPlacement,
  ownerAt,
  overlap,
  ensureNonOverlapping,
  layoutPair,
  boundingRect,
  placementFromDisplays,
  crossingTarget,
};
