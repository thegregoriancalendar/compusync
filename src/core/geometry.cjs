'use strict';

const { clamp } = require('./state.cjs');

// Use the cursor reaching the physical display edge, since Windows can clamp
// title bars before the entire window is dragged outside the display.
function edgeCrossing(bounds, pointer, display, edge) {
  const { x, y, width, height } = display;
  const margin = 8;
  const vertical = pointer.y >= y && pointer.y <= y + height;
  const horizontal = pointer.x >= x && pointer.x <= x + width;
  const crossed = {
    left: vertical && pointer.x <= x + margin && bounds.x <= x,
    right: vertical && pointer.x >= x + width - margin && bounds.x + bounds.width >= x + width,
    top: horizontal && pointer.y <= y + margin && bounds.y <= y,
    bottom: horizontal && pointer.y >= y + height - margin && bounds.y + bounds.height >= y + height,
  }[edge];
  if (!crossed) return null;
  return { edge, ratio: clamp(edge === 'left' || edge === 'right' ? (pointer.y - y) / height : (pointer.x - x) / width, 0, 1) };
}

function arrivalBounds(size, area, handoff) {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  const inset = 16;
  let x = area.x + (area.width - width) / 2;
  let y = area.y + (area.height - height) / 2;
  if (handoff.edge === 'right' || handoff.edge === 'left') {
    x = handoff.edge === 'right' ? area.x + inset : area.x + area.width - width - inset;
    y = area.y + handoff.ratio * area.height - height / 2;
  } else {
    y = handoff.edge === 'bottom' ? area.y + inset : area.y + area.height - height - inset;
    x = area.x + handoff.ratio * area.width - width / 2;
  }
  return { x: Math.round(clamp(x, area.x, area.x + area.width - width)), y: Math.round(clamp(y, area.y, area.y + area.height - height)), width, height };
}

module.exports = { edgeCrossing, arrivalBounds };
