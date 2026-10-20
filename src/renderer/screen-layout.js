'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CompuSyncScreenLayout = api;
})(typeof window === 'object' ? window : null, () => {
  const { deviceSlots, layoutPosition } = typeof module === 'object' && module.exports
    ? require('../shared/devices.js') : window.CompuSyncDevices;
  const POSITIONS = Object.freeze(['left', 'right', 'top']);
  const MIN_OVERLAP = 24;
  const MAX_GROUP_WIDTH = 152;
  const MAX_GROUP_HEIGHT = 104;
  const MIN_ZOOM = .5;
  const MAX_ZOOM = 3;
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

  function size(value, fallback) {
    return {
      w: Number.isFinite(value?.w) && value.w > 0 ? value.w : fallback.w,
      h: Number.isFinite(value?.h) && value.h > 0 ? value.h : fallback.h,
    };
  }

  function monitorGeometry(layout, fallbackAspect = 1.6) {
    const aspect = Number.isFinite(fallbackAspect) && fallbackAspect > 0 ? fallbackAspect : 1.6;
    const displays = Array.isArray(layout?.displays) ? layout.displays.filter((display) => {
      const bounds = display?.bounds;
      return typeof display.id === 'string' && bounds
        && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
        && bounds.width > 0 && bounds.height > 0;
    }) : [];
    if (!displays.length) return {
      w: 1600,
      h: 1600 / aspect,
      monitors: [{ id: 'unknown', x: 0, y: 0, w: 1600, h: 1600 / aspect, primary: true, index: 0 }],
    };
    const left = Math.min(...displays.map(({ bounds }) => bounds.x));
    const top = Math.min(...displays.map(({ bounds }) => bounds.y));
    const right = Math.max(...displays.map(({ bounds }) => bounds.x + bounds.width));
    const bottom = Math.max(...displays.map(({ bounds }) => bounds.y + bounds.height));
    const width = right - left, height = bottom - top;
    return {
      w: width,
      h: height,
      monitors: displays.map((display, index) => ({
        id: display.id,
        x: display.bounds.x - left,
        y: display.bounds.y - top,
        w: display.bounds.width,
        h: display.bounds.height,
        primary: Boolean(display.primary),
        index,
      })),
    };
  }

  function scaleMonitorGroup(group, scale) {
    return {
      w: group.w * scale,
      h: group.h * scale,
      monitors: group.monitors.map((monitor) => ({
        ...monitor,
        x: monitor.x * scale,
        y: monitor.y * scale,
        w: monitor.w * scale,
        h: monitor.h * scale,
      })),
    };
  }

  function positive(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function monitorGroup(layout, fallbackAspect = 1.6, limits = {}) {
    const group = monitorGeometry(layout, fallbackAspect);
    const maxWidth = positive(limits.maxWidth, MAX_GROUP_WIDTH);
    const maxHeight = positive(limits.maxHeight, MAX_GROUP_HEIGHT);
    return scaleMonitorGroup(group, Math.min(maxWidth / group.w, maxHeight / group.h));
  }

  function monitorGroups(layouts = {}, fallbacks = {}, limits = {}) {
    const groups = {
      mac: monitorGeometry(layouts.mac, fallbacks.mac || 1.55),
      windows: monitorGeometry(layouts.windows, fallbacks.windows || 1.7),
    };
    const maxWidth = positive(limits.maxWidth, MAX_GROUP_WIDTH);
    const maxHeight = positive(limits.maxHeight, MAX_GROUP_HEIGHT);
    // One scale across both computers makes equal display resolutions equal
    // on screen; a computer with more monitors therefore has a larger group.
    const scale = Math.min(
      maxWidth / Math.max(groups.mac.w, groups.windows.w),
      maxHeight / Math.max(groups.mac.h, groups.windows.h),
    );
    return {
      mac: scaleMonitorGroup(groups.mac, scale),
      windows: scaleMonitorGroup(groups.windows, scale),
    };
  }

  function normalizeView(value = {}) {
    return {
      zoom: clamp(Number.isFinite(value.zoom) ? value.zoom : 1, MIN_ZOOM, MAX_ZOOM),
      panX: Number.isFinite(value.panX) ? value.panX : 0,
      panY: Number.isFinite(value.panY) ? value.panY : 0,
    };
  }

  function diagramToViewport(point, width, height, view) {
    const next = normalizeView(view);
    const centerX = width / 2, centerY = height / 2;
    return {
      x: centerX + next.panX + (point.x - centerX) * next.zoom,
      y: centerY + next.panY + (point.y - centerY) * next.zoom,
    };
  }

  function viewportToDiagram(point, width, height, view) {
    const next = normalizeView(view);
    const centerX = width / 2, centerY = height / 2;
    return {
      x: centerX + (point.x - centerX - next.panX) / next.zoom,
      y: centerY + (point.y - centerY - next.panY) / next.zoom,
    };
  }

  function viewportRect(rect, width, height, view) {
    const next = normalizeView(view);
    return {
      ...diagramToViewport(rect, width, height, next),
      w: rect.w * next.zoom,
      h: rect.h * next.zoom,
    };
  }

  function zoomViewAt(view, zoom, anchor, width, height) {
    const current = normalizeView(view);
    const nextZoom = clamp(Number.isFinite(zoom) ? zoom : current.zoom, MIN_ZOOM, MAX_ZOOM);
    const centerX = width / 2, centerY = height / 2;
    const point = anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
      ? anchor : { x: centerX, y: centerY };
    const ratio = nextZoom / current.zoom;
    return {
      zoom: nextZoom,
      panX: point.x - centerX - (point.x - centerX - current.panX) * ratio,
      panY: point.y - centerY - (point.y - centerY - current.panY) * ratio,
    };
  }

  function relativeRects(macPosition, displayOffset, sizes = {}) {
    const macSize = size(sizes.mac, { w: 126, h: 78 });
    const winSize = size(sizes.windows, { w: 132, h: 78 });
    const position = POSITIONS.includes(macPosition) ? macPosition : 'left';
    const offset = clamp(Number(displayOffset) || 0, -1, 1);
    const windows = { x: 0, y: 0, ...winSize };
    const mac = { x: 0, y: 0, ...macSize };
    if (position === 'left' || position === 'right') {
      const maximum = Math.max(0, (mac.h + windows.h) / 2 - MIN_OVERLAP);
      mac.x = position === 'left' ? -mac.w : windows.w;
      mac.y = (windows.h - mac.h) / 2 + offset * maximum;
    } else {
      const maximum = Math.max(0, (mac.w + windows.w) / 2 - MIN_OVERLAP);
      mac.x = (windows.w - mac.w) / 2 + offset * maximum;
      mac.y = -mac.h;
    }
    return { mac, windows };
  }

  function stereoAssignment(layouts = {}, settings = {}, members = []) {
    const slots = deviceSlots(members, layouts);
    const mac = layouts[slots.mac?.id];
    const windows = layouts[slots.windows?.id];
    if (![mac, windows].every((layout) => layout?.displays?.some((display) => display.primary))) {
      return { ready: false, reason: 'Connect both laptops and wait for their main displays in Screen layout.' };
    }
    // Use the same geometry and scale as the screen editor, including each
    // primary display's position inside a computer with multiple monitors.
    const groups = monitorGroups({ mac, windows });
    const rects = relativeRects(layoutPosition(settings.macPosition, slots), settings.displayOffset, groups);
    const center = (name) => {
      const monitor = groups[name].monitors.find((display) => display.primary);
      return monitor ? rects[name].x + monitor.x + monitor.w / 2 : NaN;
    };
    const delta = center('mac') - center('windows');
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.000001) {
      return { ready: false, reason: 'The main displays are horizontally aligned. Move one left or right in Screen layout to split stereo.' };
    }
    return { ready: true, channels: { [slots.mac.id]: delta < 0 ? 'left' : 'right', [slots.windows.id]: delta < 0 ? 'right' : 'left' } };
  }

  function arrangeDiagram(width, height, macPosition, displayOffset, sizes) {
    const rects = relativeRects(macPosition, displayOffset, sizes);
    const left = Math.min(rects.mac.x, rects.windows.x);
    const top = Math.min(rects.mac.y, rects.windows.y);
    const right = Math.max(rects.mac.x + rects.mac.w, rects.windows.x + rects.windows.w);
    const bottom = Math.max(rects.mac.y + rects.mac.h, rects.windows.y + rects.windows.h);
    const dx = (width - (right - left)) / 2 - left;
    const dy = (height - (bottom - top)) / 2 - top;
    return {
      mac: { ...rects.mac, x: rects.mac.x + dx, y: rects.mac.y + dy },
      windows: { ...rects.windows, x: rects.windows.x + dx, y: rects.windows.y + dy },
    };
  }

  function snapDragged(dragged, proposedCenter, rects, allowVertical = true) {
    if (!['mac', 'windows'].includes(dragged) || !proposedCenter || !rects?.mac || !rects?.windows) return null;
    const moving = rects[dragged];
    const fixed = rects[dragged === 'mac' ? 'windows' : 'mac'];
    const fixedCenter = { x: fixed.x + fixed.w / 2, y: fixed.y + fixed.h / 2 };
    const candidates = [];
    const add = (macPosition, center) => {
      if (macPosition === 'top' && !allowVertical) return;
      const distance = (center.x - proposedCenter.x) ** 2 + (center.y - proposedCenter.y) ** 2;
      const macCenter = dragged === 'mac' ? center : fixedCenter;
      const winCenter = dragged === 'windows' ? center : fixedCenter;
      const horizontal = macPosition === 'left' || macPosition === 'right';
      const maximum = horizontal
        ? Math.max(0, (rects.mac.h + rects.windows.h) / 2 - MIN_OVERLAP)
        : Math.max(0, (rects.mac.w + rects.windows.w) / 2 - MIN_OVERLAP);
      const delta = horizontal ? macCenter.y - winCenter.y : macCenter.x - winCenter.x;
      candidates.push({ macPosition, displayOffset: maximum ? clamp(delta / maximum, -1, 1) : 0, distance });
    };
    const verticalCenter = clamp(proposedCenter.y, fixedCenter.y - (moving.h + fixed.h) / 2 + MIN_OVERLAP,
      fixedCenter.y + (moving.h + fixed.h) / 2 - MIN_OVERLAP);
    const horizontalCenter = clamp(proposedCenter.x, fixedCenter.x - (moving.w + fixed.w) / 2 + MIN_OVERLAP,
      fixedCenter.x + (moving.w + fixed.w) / 2 - MIN_OVERLAP);
    if (dragged === 'mac') {
      add('left', { x: fixed.x - moving.w / 2, y: verticalCenter });
      add('right', { x: fixed.x + fixed.w + moving.w / 2, y: verticalCenter });
      add('top', { x: horizontalCenter, y: fixed.y - moving.h / 2 });
    } else {
      add('left', { x: fixed.x + fixed.w + moving.w / 2, y: verticalCenter });
      add('right', { x: fixed.x - moving.w / 2, y: verticalCenter });
      add('top', { x: horizontalCenter, y: fixed.y + fixed.h + moving.h / 2 });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const { distance, ...result } = candidates[0];
    return result;
  }

  function arrangementText(macPosition, first = 'Mac', second = 'Windows') {
    return macPosition === 'right' ? `${first} is right of ${second}. Cross at ${first} left ↔ ${second} right.`
      : macPosition === 'top' ? `${first} is above ${second}. Cross at ${first} bottom ↔ ${second} top.`
        : `${first} is left of ${second}. Cross at ${first} right ↔ ${second} left.`;
  }

  return {
    POSITIONS,
    MIN_OVERLAP,
    MAX_GROUP_WIDTH,
    MAX_GROUP_HEIGHT,
    MIN_ZOOM,
    MAX_ZOOM,
    monitorGroup,
    monitorGroups,
    stereoAssignment,
    normalizeView,
    diagramToViewport,
    viewportToDiagram,
    viewportRect,
    zoomViewAt,
    arrangeDiagram,
    snapDragged,
    arrangementText,
  };
});
