'use strict';

// The host shares cursor history and a clock reference. Particle positions are
// computed from that history, so skipped network frames do not lose particles.
// No independent random simulation runs on either laptop.
(() => {
  const canvas = document.getElementById('field');
  const ctx = canvas.getContext('2d', { alpha: false });
  let width = 1, height = 1, scale = 1;
  let state;
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
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
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
    const dt = Math.min((time - previousFrame) / 1000, .05);
    previousFrame = time;
    const now = Date.now() + clockOffset;
    const elapsed = (now - (state?.scene.epoch || now)) / 1000;
    const active = Boolean(state?.cursor.active.length);
    intensity += ((active ? 1 : 0) - intensity) * (1 - Math.exp(-dt * 8));
    const cx = (state?.cursor.x ?? .5) * Math.max(1, width - 24) + 3;
    const cy = (state?.cursor.y ?? .5) * Math.max(1, height - 30) + 2;
    const radius = Math.min(175, Math.min(width, height) * .36);
    const pressed = state && Object.values(state.cursor.buttons).some((button) => button & 1);
    const strength = intensity * (pressed ? .95 : .65);
    ctx.fillStyle = '#fbfcfe';
    ctx.fillRect(0, 0, width, height);

    // A Gaussian displacement keeps every grid line continuous while the
    // cursor pushes the lattice outwards and adds a little rotational flow.
    const warp = (x, y) => {
      const dx = x - cx, dy = y - cy;
      const influence = Math.exp(-(dx * dx + dy * dy) / (radius * radius * .72)) * strength;
      const twist = .18 + Math.sin(elapsed * .65) * .035;
      return [x + (dx - dy * twist) * influence, y + (dy + dx * twist) * influence];
    };
    const grid = new Path2D();
    const spacing = 32;
    for (let x = -spacing; x <= width + spacing; x += spacing) {
      for (let y = -spacing; y <= height + spacing; y += 7) {
        const point = warp(x, y);
        if (y === -spacing) grid.moveTo(...point); else grid.lineTo(...point);
      }
    }
    for (let y = -spacing; y <= height + spacing; y += spacing) {
      for (let x = -spacing; x <= width + spacing; x += 7) {
        const point = warp(x, y);
        if (x === -spacing) grid.moveTo(...point); else grid.lineTo(...point);
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

    // Quiet ambient motes; a fixed seed and the shared clock keep their phase
    // consistent even after a window has been hidden or a peer reconnects.
    for (let i = 0; i < 65; i++) {
      const phase = hash(i + 20) * TAU;
      const x = hash(i * 4 + 1) * width + Math.sin(elapsed * .22 + phase) * 9;
      const y = hash(i * 4 + 2) * height + Math.cos(elapsed * .18 + phase) * 9;
      const [px, py] = warp(x, y);
      particle(px, py, .7 + hash(i * 4 + 3) * .8, .12 + hash(i + 400) * .19, i % 6 === 0);
    }

    // Small motes circle the moving field, then a ribbon of particles peels
    // away along its recent path. A press expands the field and its orbit.
    if (intensity > .005) for (let i = 0; i < 38; i++) {
      const orbit = (18 + hash(i + 90) * 76) * (pressed ? 1.2 : 1);
      const angle = hash(i + 130) * TAU + elapsed * (.3 + hash(i + 200) * .5);
      const shimmer = .35 + .25 * Math.sin(elapsed * 1.6 + i);
      particle(cx + Math.cos(angle) * orbit, cy + Math.sin(angle) * orbit * .84, .8 + hash(i + 300) * 1.3, intensity * shimmer, i % 7 === 0);
    }

    for (const point of state?.cursor.trail || []) {
      const age = (now - point.t) / 1000;
      if (age < 0 || age > 1.4) continue;
      for (let i = 0; i < 5; i++) {
        const seed = point.serial * 19 + i * 7;
        const angle = hash(seed) * TAU + age * .65;
        const distance = hash(seed + 1) * 12 + age * (12 + hash(seed + 2) * 32);
        const x = point.x * Math.max(1, width - 24) + 3 + Math.cos(angle) * distance;
        const y = point.y * Math.max(1, height - 30) + 2 + Math.sin(angle) * distance - age * 12;
        const fade = (1 - age / 1.4) ** 2;
        particle(x, y, .7 + hash(seed + 3) * 1.5, fade * .75, i === 0);
      }
    }
    if (!document.hidden) animation = requestAnimationFrame(draw);
  }

  window.sharedField = {
    update(next) { state = next; clockOffset = next.clockOffsetMs || 0; },
  };
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && animation) { cancelAnimationFrame(animation); animation = null; }
    else if (!document.hidden && !animation) { previousFrame = performance.now(); animation = requestAnimationFrame(draw); }
  });
  resize();
  animation = requestAnimationFrame(draw);
})();
