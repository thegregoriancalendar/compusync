'use strict';

const finite = Number.isFinite;

function validRect(rect) {
  return rect && [rect.x, rect.y, rect.w, rect.h].every(finite) && rect.w > 0 && rect.h > 0;
}

function placementRect(placement) {
  const rect = { x: placement?.origin?.x, y: placement?.origin?.y, w: placement?.size?.w, h: placement?.size?.h };
  if (!validRect(rect)) throw new TypeError('A valid screen placement is required.');
  return rect;
}

function physicalDisplaysFromMetrics(metrics, coordinateSpace, desktopScale) {
  if (!Array.isArray(metrics) || !coordinateSpace || !finite(desktopScale) || desktopScale <= 0) return [];
  const unitScale = coordinateSpace.scale / desktopScale;
  return metrics.flatMap((display) => {
    const mm = { w: display.physicalWidthMm ?? display.physical_width_mm, h: display.physicalHeightMm ?? display.physical_height_mm };
    const bounds = display.bounds;
    if (![bounds?.x, bounds?.y, bounds?.width, bounds?.height, unitScale].every(finite)
      || unitScale <= 0 || bounds.width <= 0 || bounds.height <= 0) return [];
    const knownSize = [mm.w, mm.h].every(finite) && mm.w >= 10 && mm.h >= 10 && mm.w <= 20000 && mm.h <= 20000;
    return [{ id: String(display.id),
      origin: { x: (bounds.x - coordinateSpace.x) * unitScale, y: (bounds.y - coordinateSpace.y) * unitScale },
      size: { w: bounds.width * unitScale, h: bounds.height * unitScale }, ...(knownSize ? { physicalSizeMm: mm } : {}) }];
  }).slice(0, 8);
}

function displaysFor(placement) {
  return (placement.physicalDisplays || []).flatMap((display) => {
    const bounds = { x: placement.origin.x + display.origin?.x, y: placement.origin.y + display.origin?.y,
      w: display.size?.w, h: display.size?.h };
    const mm = display.physicalSizeMm;
    if (!validRect(bounds)) return [];
    return [{ ...bounds, id: display.id, physicalSizeMm: mm }];
  });
}

function intersectionArea(first, second) {
  return Math.max(0, Math.min(first.x + first.w, second.x + second.w) - Math.max(first.x, second.x))
    * Math.max(0, Math.min(first.y + first.h, second.y + second.h) - Math.max(first.y, second.y));
}

function center(rect) { return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }; }
function distanceSquared(first, second) { return (first.x - second.x) ** 2 + (first.y - second.y) ** 2; }

function sourceDisplayFor(placement, referenceRect) {
  const displays = displaysFor(placement);
  const reference = validRect(referenceRect) ? referenceRect : placementRect(placement);
  return displays.sort((first, second) => intersectionArea(second, reference) - intersectionArea(first, reference)
    || distanceSquared(center(first), center(reference)) - distanceSquared(center(second), center(reference)))[0] || null;
}

function seamDirection(source, target) {
  const s = placementRect(source), t = placementRect(target);
  if (t.x >= s.x + s.w - 1e-6) return 'right';
  if (t.x + t.w <= s.x + 1e-6) return 'left';
  if (t.y >= s.y + s.h - 1e-6) return 'bottom';
  if (t.y + t.h <= s.y + 1e-6) return 'top';
  throw new TypeError('Screen placements must have a shared crossing direction.');
}

function seamAnchors(source, target, referenceRect) {
  const s = placementRect(source), t = placementRect(target);
  const direction = seamDirection(source, target);
  const horizontal = direction === 'left' || direction === 'right';
  const sourceDisplay = sourceDisplayFor(source, referenceRect);
  const sourceCenter = center(sourceDisplay || s);
  const targetEdge = direction === 'right' ? t.x : direction === 'left' ? t.x + t.w
    : direction === 'bottom' ? t.y : t.y + t.h;
  const targetDisplay = displaysFor(target).sort((first, second) => {
    const edge = (display) => direction === 'right' ? display.x : direction === 'left' ? display.x + display.w
      : direction === 'bottom' ? display.y : display.y + display.h;
    const crossDistance = (display) => horizontal ? Math.abs(center(display).y - sourceCenter.y) : Math.abs(center(display).x - sourceCenter.x);
    return Math.abs(edge(first) - targetEdge) - Math.abs(edge(second) - targetEdge)
      || crossDistance(first) - crossDistance(second);
  })[0] || null;
  const sourceEdge = direction === 'right' ? s.x + s.w : direction === 'left' ? s.x
    : direction === 'bottom' ? s.y + s.h : s.y;
  const crossAnchor = horizontal
    ? (Math.max(s.y, t.y) + Math.min(s.y + s.h, t.y + t.h)) / 2
    : (Math.max(s.x, t.x) + Math.min(s.x + s.w, t.x + t.w)) / 2;
  return { direction, sourceDisplay, targetDisplay,
    source: horizontal ? { x: sourceEdge, y: crossAnchor } : { x: crossAnchor, y: sourceEdge },
    target: horizontal ? { x: targetEdge, y: crossAnchor } : { x: crossAnchor, y: targetEdge } };
}

function density(display) {
  // Use both axes to absorb EDID millimeter rounding while preserving the
  // window's aspect ratio. This is VU per physical mm, not OS UI scale.
  const mm = display?.physicalSizeMm;
  if (!finite(mm?.w) || !finite(mm?.h) || mm.w <= 0 || mm.h <= 0) return null;
  return Math.sqrt((display.w / mm.w) * (display.h / mm.h));
}

function scaleForAnchors(anchors) {
  const source = density(anchors.sourceDisplay), target = density(anchors.targetDisplay);
  return source && target ? target / source : 1;
}

function scaleForPlacements(source, target, referenceRect) {
  const anchors = seamAnchors(source, target, referenceRect);
  return scaleForAnchors(anchors);
}

function destinationGeometry(rect, source, target, referenceRect = rect) {
  if (!validRect(rect)) throw new TypeError('A valid window rectangle is required.');
  const anchors = seamAnchors(source, target, referenceRect);
  const scale = scaleForAnchors(anchors);
  return { x: anchors.target.x + (rect.x - anchors.source.x) * scale,
    y: anchors.target.y + (rect.y - anchors.source.y) * scale, w: rect.w * scale, h: rect.h * scale };
}

function inverseGeometry(rect, source, target, referenceRect) {
  if (!validRect(rect)) throw new TypeError('A valid window rectangle is required.');
  const anchors = seamAnchors(source, target, referenceRect);
  const scale = scaleForAnchors(anchors);
  return { x: anchors.source.x + (rect.x - anchors.target.x) / scale,
    y: anchors.source.y + (rect.y - anchors.target.y) / scale, w: rect.w / scale, h: rect.h / scale };
}

module.exports = { destinationGeometry, inverseGeometry, physicalDisplaysFromMetrics, scaleForPlacements, seamAnchors };
