'use strict';

const api = window.compusync;
const TOP_BAR_HEIGHT = 36;
const CURSOR_WIDTH = 24;
const CURSOR_HEIGHT = 30;
const surface = document.getElementById('surface');
const topBar = document.getElementById('top-bar');
const dragHandle = document.getElementById('drag-handle');
const desktop = document.getElementById('desktop');
const cursor = document.getElementById('cursor');
const ripple = document.getElementById('ripple');
const settingsButton = document.getElementById('open-settings');
const closeButton = document.getElementById('close-window');

let state;
let geometry;
let memberId;
let inside = false;
let contentPaused = false;
let contentDx = 0;
let contentDy = 0;
let contentPrevious = null;
let contentFrame;
let lastClick;
let drag;
let dragDx = 0;
let dragDy = 0;
let dragFrame;
let dragAckTimer;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function windowGeometry(next) {
  const rect = next?.window?.rect;
  const legacy = !rect && next?.size;
  const fullWidth = Math.max(1, Math.round(finite(rect?.width) ? rect.width : legacy?.width || surface.clientWidth || 900));
  const fullHeight = Math.max(TOP_BAR_HEIGHT + 1, Math.round(finite(rect?.height) ? rect.height : legacy?.height || surface.clientHeight || 600));
  let raw = next?.viewport;
  // Keep old development profiles usable while the version-2 main process is
  // being rolled out. Version 2 deliberately treats a null viewport as hidden.
  if (!raw && !rect && legacy) raw = { x: 0, y: 0, width: fullWidth, height: fullHeight };
  if (!raw || ![raw.x, raw.y, raw.width, raw.height].every(finite)) {
    return { fullWidth, fullHeight, contentWidth: fullWidth, contentHeight: fullHeight - TOP_BAR_HEIGHT, viewport: null };
  }
  const x = clamp(Math.round(raw.x), 0, fullWidth);
  const y = clamp(Math.round(raw.y), 0, fullHeight);
  const width = clamp(Math.round(raw.width), 0, fullWidth - x);
  const height = clamp(Math.round(raw.height), 0, fullHeight - y);
  const contentStart = Math.max(y, TOP_BAR_HEIGHT);
  const contentEnd = Math.min(y + height, fullHeight);
  return {
    fullWidth,
    fullHeight,
    contentWidth: fullWidth,
    contentHeight: fullHeight - TOP_BAR_HEIGHT,
    viewport: { x, y, width, height },
    desktopTop: contentStart - y,
    desktopWidth: width,
    desktopHeight: Math.max(0, contentEnd - contentStart),
    contentOffsetX: x,
    contentOffsetY: contentStart - TOP_BAR_HEIGHT,
  };
}

function applyGeometry(next) {
  geometry = windowGeometry(next);
  const view = geometry.viewport;
  // Keep the bar rendered even when the crop is empty. Main uses a transparent
  // capture window during an owned drag; display:none can make pointer lock end.
  topBar.style.left = `${view ? -view.x : 0}px`;
  topBar.style.top = `${view ? -view.y : 0}px`;
  topBar.style.width = `${geometry.fullWidth}px`;
  const barVisible = Boolean(view && view.y < TOP_BAR_HEIGHT && view.y + view.height > 0);
  topBar.setAttribute('aria-hidden', String(!barVisible));
  settingsButton.tabIndex = barVisible ? 0 : -1;
  closeButton.tabIndex = barVisible ? 0 : -1;
  desktop.style.left = '0px';
  desktop.style.top = `${view ? geometry.desktopTop : 0}px`;
  desktop.style.width = `${view ? geometry.desktopWidth : 0}px`;
  desktop.style.height = `${view ? geometry.desktopHeight : 0}px`;
  desktop.setAttribute('aria-hidden', String(!view || geometry.desktopHeight <= 0));
  window.sharedDesktop?.updateGeometry(geometry);
}

function render(next) {
  state = next;
  applyGeometry(next);
  window.sharedField.update(next, geometry);
  const view = geometry.viewport;
  const canRenderCursor = view && geometry.desktopHeight > 0 && state.cursor?.active?.length;
  cursor.hidden = !canRenderCursor;
  if (canRenderCursor) {
    const x = (state.cursor.x ?? .5) * Math.max(1, geometry.contentWidth - CURSOR_WIDTH) - geometry.contentOffsetX;
    const y = (state.cursor.y ?? .5) * Math.max(1, geometry.contentHeight - CURSOR_HEIGHT) - geometry.contentOffsetY;
    cursor.style.transform = `translate(${x}px, ${y}px)`;
  }
  cursor.classList.toggle('pressed', Object.values(state.cursor?.buttons || {}).some((buttons) => buttons & 1));
  if (state.click && state.click.serial !== lastClick) {
    if (lastClick !== undefined && view && geometry.desktopHeight > 0) {
      ripple.style.left = `${state.click.x * Math.max(1, geometry.contentWidth - CURSOR_WIDTH) - geometry.contentOffsetX}px`;
      ripple.style.top = `${state.click.y * Math.max(1, geometry.contentHeight - CURSOR_HEIGHT) - geometry.contentOffsetY}px`;
      ripple.classList.remove('pulse');
      void ripple.offsetWidth;
      ripple.classList.add('pulse');
    }
    lastClick = state.click.serial;
  } else if (!state.click) lastClick = 0;
  checkDragOwnership();
}

function flushContent() {
  if (contentFrame) cancelAnimationFrame(contentFrame);
  contentFrame = null;
  if (contentDx || contentDy) {
    api.input({
      type: 'move',
      dx: contentDx / Math.max(1, geometry?.contentWidth - CURSOR_WIDTH),
      dy: contentDy / Math.max(1, geometry?.contentHeight - CURSOR_HEIGHT),
    });
  }
  contentDx = 0;
  contentDy = 0;
}

function enterContent(event) {
  if (contentPaused || drag || !geometry?.viewport || geometry.desktopHeight <= 0) return;
  inside = true;
  contentPrevious = { x: event.clientX, y: event.clientY };
  const fullX = geometry.viewport.x + event.clientX;
  const fullY = geometry.viewport.y + event.clientY - TOP_BAR_HEIGHT;
  api.input({
    type: 'enter',
    x: clamp(fullX / Math.max(1, geometry.contentWidth - CURSOR_WIDTH), 0, 1),
    y: clamp(fullY / Math.max(1, geometry.contentHeight - CURSOR_HEIGHT), 0, 1),
  });
}

function leaveContent() {
  flushContent();
  contentPrevious = null;
  if (!inside) return;
  inside = false;
  api.input({ type: 'leave' });
}

function releaseContent() {
  if (document.pointerLockElement === desktop) document.exitPointerLock();
  leaveContent();
}

window.compusyncSurface = {
  pauseContent() {
    contentPaused = true;
    releaseContent();
    desktop.style.cursor = 'default';
  },
  resumeContent() {
    contentPaused = false;
    inside = false;
    contentPrevious = null;
    desktop.style.cursor = 'none';
  },
};

function newDragId() {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function sharedDragIdentity(value = state?.drag) {
  if (!value) return null;
  return {
    id: value.id ?? value.token ?? value.dragId,
    owner: value.owner ?? value.ownerId ?? value.actor,
  };
}

function flushDrag() {
  if (dragFrame) cancelAnimationFrame(dragFrame);
  dragFrame = null;
  if (!drag || (!dragDx && !dragDy)) return;
  // The reducer accepts bounded integer DIP deltas. Keep fractional device
  // movement as residue and split an unusually large event without breaking
  // the strictly monotonic sequence.
  let wholeX = Math.trunc(dragDx);
  let wholeY = Math.trunc(dragDy);
  dragDx -= wholeX;
  dragDy -= wholeY;
  while (drag && (wholeX || wholeY)) {
    const dx = clamp(wholeX, -512, 512);
    const dy = clamp(wholeY, -512, 512);
    api.input({ type: 'drag-move', id: drag.id, seq: ++drag.seq, dx, dy });
    wholeX -= dx;
    wholeY -= dy;
  }
}

function finishDrag(type, notify = true) {
  if (!drag) return;
  if (type === 'drag-end') flushDrag();
  else {
    if (dragFrame) cancelAnimationFrame(dragFrame);
    dragFrame = null;
    dragDx = 0;
    dragDy = 0;
  }
  const finished = drag;
  drag = null;
  clearTimeout(dragAckTimer);
  dragAckTimer = null;
  dragHandle.classList.remove('dragging');
  if (notify) api.input({ type, id: finished.id });
  if (document.pointerLockElement === dragHandle) document.exitPointerLock();
}

function checkDragOwnership() {
  if (!drag) return;
  const shared = sharedDragIdentity();
  if (shared && shared.id === drag.id && (!shared.owner || !memberId || shared.owner === memberId)) {
    drag.acknowledged = true;
    clearTimeout(dragAckTimer);
    dragAckTimer = null;
    return;
  }
  if (shared && (shared.id !== drag.id || (shared.owner && memberId && shared.owner !== memberId))) {
    finishDrag('drag-cancel', false);
  } else if (!shared && drag.acknowledged) {
    finishDrag('drag-cancel', false);
  }
}

function startDrag(event) {
  if (event.button !== 0 || drag || !geometry?.viewport) return;
  const shared = sharedDragIdentity();
  if (shared && (!memberId || shared.owner !== memberId)) return;
  event.preventDefault();
  contentPaused = true;
  releaseContent();
  const id = newDragId();
  drag = { id, seq: 0, acknowledged: false };
  dragHandle.classList.add('dragging');
  api.input({
    type: 'drag-start',
    id,
    offsetX: geometry.viewport.x + event.clientX,
    offsetY: geometry.viewport.y + event.clientY,
  });
  dragAckTimer = setTimeout(() => {
    if (drag?.id === id && !drag.acknowledged) finishDrag('drag-cancel');
  }, 1500);
  try {
    const request = dragHandle.requestPointerLock();
    request?.catch(() => { if (drag?.id === id) finishDrag('drag-cancel'); });
  } catch {
    finishDrag('drag-cancel');
  }
}

desktop.addEventListener('mouseenter', (event) => {
  if (drag) return;
  contentPaused = false;
  desktop.style.cursor = 'none';
  enterContent(event);
});
desktop.addEventListener('mouseleave', () => {
  if (!document.pointerLockElement) leaveContent();
});
desktop.addEventListener('mousemove', (event) => {
  if (drag || contentPaused) return;
  if (!inside) enterContent(event);
  if (document.pointerLockElement === desktop) {
    contentDx += event.movementX;
    contentDy += event.movementY;
  } else if (contentPrevious) {
    contentDx += event.clientX - contentPrevious.x;
    contentDy += event.clientY - contentPrevious.y;
  }
  contentPrevious = { x: event.clientX, y: event.clientY };
  if (!contentFrame) contentFrame = requestAnimationFrame(flushContent);
});
desktop.addEventListener('mousedown', (event) => {
  if (drag) return;
  contentPaused = false;
  if (!inside) enterContent(event);
  flushContent();
  api.input({ type: 'button', buttons: event.buttons });
  if (event.button === 0 && document.pointerLockElement !== desktop) {
    try { desktop.requestPointerLock()?.catch(() => {}); } catch { /* Hover input remains available. */ }
  }
});
desktop.addEventListener('contextmenu', (event) => event.preventDefault());
dragHandle.addEventListener('mousedown', startDrag);

document.addEventListener('mousemove', (event) => {
  if (!drag) return;
  if (finite(event.movementX)) dragDx += event.movementX;
  if (finite(event.movementY)) dragDy += event.movementY;
  if (!dragFrame && (dragDx || dragDy)) dragFrame = requestAnimationFrame(flushDrag);
});
document.addEventListener('mouseup', (event) => {
  if (drag && event.button === 0) {
    finishDrag('drag-end');
    return;
  }
  if (inside) api.input({ type: 'button', buttons: event.buttons });
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (drag) finishDrag('drag-cancel');
  else {
    contentPaused = true;
    releaseContent();
    desktop.style.cursor = 'default';
  }
});
document.addEventListener('pointerlockchange', () => {
  if (drag && document.pointerLockElement !== dragHandle) {
    finishDrag('drag-cancel');
    return;
  }
  if (!drag && document.pointerLockElement !== desktop && inside) {
    contentPaused = true;
    leaveContent();
    desktop.style.cursor = 'default';
  }
});
document.addEventListener('pointerlockerror', () => {
  if (drag) finishDrag('drag-cancel');
});
window.addEventListener('blur', () => {
  if (drag) finishDrag('drag-cancel');
  releaseContent();
});
window.addEventListener('resize', () => {
  if (state) render(state);
});

settingsButton.addEventListener('click', () => {
  if (drag) finishDrag('drag-cancel');
  api.command('settings');
});
closeButton.addEventListener('click', () => {
  if (drag) finishDrag('drag-cancel');
  api.command('close');
});

api.onState(render);
api.onRelease(() => {
  if (drag) finishDrag('drag-cancel');
  releaseContent();
});
api.onConnection((status) => {
  if (!['hosting', 'connected'].includes(status.phase)) {
    if (drag) finishDrag('drag-cancel');
    releaseContent();
  }
});
api.bootstrap().then((details) => {
  memberId = details.id;
  if (details.state) render({ ...details.state, clockOffsetMs: details.clockOffsetMs });
});
