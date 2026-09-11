'use strict';

const api = window.compusync;
const surface = document.getElementById('surface');
const cursor = document.getElementById('cursor');
const ripple = document.getElementById('ripple');
let state;
let inside = false;
let paused = false;
let dx = 0, dy = 0;
let previous = null;
let lastClick;
let frame;

function render(next) {
  state = next;
  window.sharedField.update(next);
  cursor.hidden = !state.cursor.active.length;
  const x = state.cursor.x * Math.max(1, surface.clientWidth - 24);
  const y = state.cursor.y * Math.max(1, surface.clientHeight - 30);
  cursor.style.transform = `translate(${x}px, ${y}px)`;
  cursor.classList.toggle('pressed', Object.values(state.cursor.buttons).some((buttons) => buttons & 1));
  if (state.click && state.click.serial !== lastClick) {
    if (lastClick !== undefined) {
      ripple.style.left = `${state.click.x * (surface.clientWidth - 24)}px`;
      ripple.style.top = `${state.click.y * (surface.clientHeight - 30)}px`;
      ripple.classList.remove('pulse');
      void ripple.offsetWidth;
      ripple.classList.add('pulse');
    }
    lastClick = state.click.serial;
  } else if (!state.click) lastClick = 0;
}

function flush() {
  frame = null;
  if (dx || dy) api.input({ type: 'move', dx: dx / Math.max(1, surface.clientWidth - 24), dy: dy / Math.max(1, surface.clientHeight - 30) });
  dx = dy = 0;
}

function enter(event) {
  if (paused) return;
  inside = true;
  previous = { x: event.clientX, y: event.clientY };
  api.input({ type: 'enter', x: event.clientX / Math.max(1, surface.clientWidth - 24), y: event.clientY / Math.max(1, surface.clientHeight - 30) });
}

function leave() {
  flush();
  inside = false;
  previous = null;
  api.input({ type: 'leave' });
}

function release() {
  if (document.pointerLockElement) document.exitPointerLock();
  leave();
}

surface.addEventListener('mouseenter', (event) => { paused = false; enter(event); });
surface.addEventListener('mouseleave', () => { if (!document.pointerLockElement) leave(); });
surface.addEventListener('mousemove', (event) => {
  if (paused) return;
  if (!inside) enter(event);
  if (document.pointerLockElement) { dx += event.movementX; dy += event.movementY; }
  else if (previous) { dx += event.clientX - previous.x; dy += event.clientY - previous.y; }
  previous = { x: event.clientX, y: event.clientY };
  if (!frame) frame = requestAnimationFrame(flush);
});
surface.addEventListener('mousedown', (event) => {
  paused = false;
  if (!inside) enter(event);
  flush();
  api.input({ type: 'button', buttons: event.buttons });
  if (event.button === 0 && !document.pointerLockElement) {
    // Hover takes over visually; a click grants the OS gesture needed to lock
    // relative movement, so a trackpad cannot run out of room at a window edge.
    try { surface.requestPointerLock()?.catch(() => {}); } catch { /* Hover still works. */ }
  }
});
document.addEventListener('mouseup', (event) => { if (inside) api.input({ type: 'button', buttons: event.buttons }); });
surface.addEventListener('contextmenu', (event) => event.preventDefault());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { paused = true; release(); surface.style.cursor = 'default'; }
});
surface.addEventListener('mouseenter', () => { surface.style.cursor = 'none'; });
surface.addEventListener('mousedown', () => { surface.style.cursor = 'none'; });
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement) { paused = true; leave(); surface.style.cursor = 'default'; }
});
window.addEventListener('blur', release);
window.addEventListener('resize', () => { if (state) render(state); });
api.onState(render);
api.onRelease(release);
api.onConnection((status) => { if (!['hosting', 'connected'].includes(status.phase)) release(); });
api.bootstrap().then((details) => { if (details.state) render({ ...details.state, clockOffsetMs: details.clockOffsetMs }); });
