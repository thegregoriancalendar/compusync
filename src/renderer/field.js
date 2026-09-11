'use strict';

// Every renderer draws the same full scene and translates it by its viewport
// offset. The local canvas is only as large as the native fragment, so crossing
// a seam neither reflows the grid nor allocates a full Retina-sized canvas.
(() => {
  const canvas = document.getElementById('field');
  const ctx = canvas.getContext('2d', { alpha: false });
  let width = 0;
  let height = 0;
  let scale = 1;
  let state;
  let viewport;
  let clockOffset = 0;
  let previousFrame = performance.now();
  let intensity = 0;
  let animation;
  const TAU = Math.PI * 2;
  const hash = (seed) => {
    let value = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
    value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
  };

  function resize() {
    const nextWidth = Math.max(0, Math.round(canvas.clientWidth));
    const nextHeight = Math.max(0, Math.round(canvas.clientHeight));
    const nextScale = Math.min(window.devicePixelRatio || 1, 2);
    if (nextWidth === width && nextHeight === height && nextScale === scale) return;
    width = nextWidth;
    height = nextHeight;
    scale = nextScale;
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function particle(x, y, radius, alpha, warm = false) {
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = warm ? '#dca26a' : '#419fae';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function draw(time) {
    animation = null;
    resize();
    const dt = Math.min((time - previousFrame) / 1000, .05);
    previousFrame = time;
    const now = Date.now() + clockOffset;
    const elapsed = (now - (state?.scene?.epoch || now)) / 1000;
    const active = Boolean(state?.cursor?.active?.length);
    intensity += ((active ? 1 : 0) - intensity) * (1 - Math.exp(-dt * 8));
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = '#fbfcfe';
    ctx.fillRect(0, 0, width, height);
    if (!state || !viewport?.viewport || width <= 0 || height <= 0) {
      if (!document.hidden) animation = requestAnimationFrame(draw);
      return;
    }

    const fullWidth = viewport.contentWidth;
    const fullHeight = viewport.contentHeight;
    const offsetX = viewport.contentOffsetX;
    const offsetY = viewport.contentOffsetY;
    const cx = (state.cursor?.x ?? .5) * Math.max(1, fullWidth - 24) + 3;
    const cy = (state.cursor?.y ?? .5) * Math.max(1, fullHeight - 30) + 2;
    const radius = Math.min(175, Math.min(fullWidth, fullHeight) * .36);
    const pressed = Object.values(state.cursor?.buttons || {}).some((button) => button & 1);
    const strength = intensity * (pressed ? .95 : .65);

    // Drawing uses full-content coordinates. Native canvas clipping produces
    // complementary pixels while this translation selects the local crop.
    ctx.save();
    ctx.translate(-offsetX, -offsetY);
    const warp = (x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      const influence = Math.exp(-(dx * dx + dy * dy) / (radius * radius * .72)) * strength;
      const twist = .18 + Math.sin(elapsed * .65) * .035;
      return [x + (dx - dy * twist) * influence, y + (dy + dx * twist) * influence];
    };

    const grid = new Path2D();
    const spacing = 32;
    const padding = radius + spacing;
    const anchoredStart = (minimum, step) => -spacing + Math.floor((minimum + spacing) / step) * step;
    const xStart = Math.max(-spacing, anchoredStart(offsetX - padding, spacing));
    const xEnd = Math.min(fullWidth + spacing, offsetX + width + padding);
    const yStart = Math.max(-spacing, anchoredStart(offsetY - padding, spacing));
    const yEnd = Math.min(fullHeight + spacing, offsetY + height + padding);
    const sampleXStart = Math.max(-spacing, anchoredStart(offsetX - padding, 7));
    const sampleYStart = Math.max(-spacing, anchoredStart(offsetY - padding, 7));
    for (let x = xStart; x <= xEnd; x += spacing) {
      let first = true;
      for (let y = sampleYStart; y <= yEnd; y += 7) {
        const point = warp(x, y);
        if (first) grid.moveTo(...point); else grid.lineTo(...point);
        first = false;
      }
    }
    for (let y = yStart; y <= yEnd; y += spacing) {
      let first = true;
      for (let x = sampleXStart; x <= xEnd; x += 7) {
        const point = warp(x, y);
        if (first) grid.moveTo(...point); else grid.lineTo(...point);
        first = false;
      }
    }
    ctx.lineWidth = .7;
    ctx.strokeStyle = '#dce3ec';
    ctx.stroke(grid);

    if (intensity > .005) {
      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.4);
      halo.addColorStop(0, `rgba(110, 200, 206, ${.1 * intensity})`);
      halo.addColorStop(1, 'rgba(110, 200, 206, 0)');
      ctx.fillStyle = halo;
      ctx.fillRect(cx - radius * 1.4, cy - radius * 1.4, radius * 2.8, radius * 2.8);
      const gridGlow = ctx.createRadialGradient(cx, cy, 8, cx, cy, radius * 1.5);
      gridGlow.addColorStop(0, `rgba(77, 160, 175, ${.58 * intensity})`);
      gridGlow.addColorStop(1, 'rgba(77, 160, 175, 0)');
      ctx.strokeStyle = gridGlow;
      ctx.stroke(grid);
    }

    // Particle seeds use the full logical dimensions. Changing a local crop
    // only clips this world and cannot reseed or redistribute its particles.
    for (let i = 0; i < 65; i++) {
      const phase = hash(i + 20) * TAU;
      const x = hash(i * 4 + 1) * fullWidth + Math.sin(elapsed * .22 + phase) * 9;
      const y = hash(i * 4 + 2) * fullHeight + Math.cos(elapsed * .18 + phase) * 9;
      const [px, py] = warp(x, y);
      particle(px, py, .7 + hash(i * 4 + 3) * .8, .12 + hash(i + 400) * .19, i % 6 === 0);
    }

    if (intensity > .005) for (let i = 0; i < 38; i++) {
      const orbit = (18 + hash(i + 90) * 76) * (pressed ? 1.2 : 1);
      const angle = hash(i + 130) * TAU + elapsed * (.3 + hash(i + 200) * .5);
      const shimmer = .35 + .25 * Math.sin(elapsed * 1.6 + i);
      particle(cx + Math.cos(angle) * orbit, cy + Math.sin(angle) * orbit * .84, .8 + hash(i + 300) * 1.3, intensity * shimmer, i % 7 === 0);
    }

    for (const point of state.cursor?.trail || []) {
      const age = (now - point.t) / 1000;
      if (age < 0 || age > 1.4) continue;
      for (let i = 0; i < 5; i++) {
        const seed = point.serial * 19 + i * 7;
        const angle = hash(seed) * TAU + age * .65;
        const distance = hash(seed + 1) * 12 + age * (12 + hash(seed + 2) * 32);
        const x = point.x * Math.max(1, fullWidth - 24) + 3 + Math.cos(angle) * distance;
        const y = point.y * Math.max(1, fullHeight - 30) + 2 + Math.sin(angle) * distance - age * 12;
        const fade = (1 - age / 1.4) ** 2;
        particle(x, y, .7 + hash(seed + 3) * 1.5, fade * .75, i === 0);
      }
    }
    ctx.restore();
    if (!document.hidden) animation = requestAnimationFrame(draw);
  }

  window.sharedField = {
    update(next, nextViewport) {
      state = next;
      viewport = nextViewport;
      clockOffset = next.clockOffsetMs || 0;
      resize();
    },
  };
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && animation) {
      cancelAnimationFrame(animation);
      animation = null;
    } else if (!document.hidden && !animation) {
      previousFrame = performance.now();
      animation = requestAnimationFrame(draw);
    }
  });
  resize();
  animation = requestAnimationFrame(draw);
})();
