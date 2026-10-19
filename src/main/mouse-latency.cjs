'use strict';

const { performance } = require('node:perf_hooks');

const WINDOW_MS = 10000;
const CLOCK_WINDOW_MS = 30000;
const MAX_LATENCY_MS = 5000;
const SAMPLE_INTERVAL_MS = 50;

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

// Measures from the first source JS input callback in a sampled delta batch
// through the destination's native cursor update. Device polling, native-to-JS
// delivery and display scanout are outside this measurement.
class MouseLatency {
  constructor(options = {}) {
    this.now = options.now || (() => performance.now());
    this.send = options.send || (() => false);
    this.onUpdate = options.onUpdate || (() => {});
    this.connected = false;
    this.linked = false;
    this.sequence = 0;
    this.probes = new Map();
    this.clocks = [];
    this.samples = [];
    this.pending = [];
    this.peerReport = null;
    this.lastProbeAt = -Infinity;
    this.lastReportAt = -Infinity;
    this.lastSampleAt = -Infinity;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.setConnected(false);
  }

  setConnected(connected) {
    if (this.connected === Boolean(connected)) return;
    this.connected = Boolean(connected);
    this.probes.clear();
    this.clocks = [];
    this.#clearReadings();
    this.lastProbeAt = -Infinity;
    this.lastReportAt = -Infinity;
    if (this.connected) this.tick();
    else this.onUpdate(this.state());
  }

  setLinked(linked) {
    if (this.linked === Boolean(linked)) return;
    this.linked = Boolean(linked);
    this.#clearReadings();
    this.lastReportAt = -Infinity;
  }

  captureInput() {
    if (!this.connected || !this.linked) return null;
    const now = this.now();
    if (now - this.lastSampleAt < SAMPLE_INTERVAL_MS) return null;
    this.lastSampleAt = now;
    return now;
  }

  queueInput(sampledAt) {
    if (this.connected && this.linked && Number.isFinite(sampledAt) && sampledAt >= 0) {
      this.pending.push(sampledAt);
      if (this.pending.length > 16) this.pending.shift();
    }
  }

  discardPending() { this.pending = []; }

  inputApplied() {
    const now = this.now();
    const clock = this.#clock(now);
    const pending = this.pending;
    this.pending = [];
    if (!clock || !this.connected || !this.linked) return;
    for (const sampledAt of pending) {
      // offset is peer clock minus local clock. This is a one-way estimate,
      // assuming symmetric transit for the lowest-RTT four-timestamp probe.
      const ms = now - sampledAt + clock.offset;
      if (ms < -clock.rtt / 2 || ms > MAX_LATENCY_MS) continue;
      this.samples.push({ at: now, ms: Math.max(0, ms), uncertaintyMs: clock.rtt / 2 });
    }
    this.samples = this.samples.filter((sample) => now - sample.at <= WINDOW_MS).slice(-200);
  }

  receive(message) {
    if (!this.connected) return false;
    const now = this.now();
    if (message.type === 'latency.probe') {
      return this.#send({ type: 'latency.reply', id: message.id, receivedAt: now, sentAt: this.now() });
    }
    if (message.type === 'latency.reply') {
      const started = this.probes.get(message.id);
      this.probes.delete(message.id);
      if (started === undefined || message.sentAt < message.receivedAt) return false;
      const rtt = now - started - (message.sentAt - message.receivedAt);
      if (!Number.isFinite(rtt) || rtt < 0 || rtt > MAX_LATENCY_MS) return false;
      const offset = ((message.receivedAt - started) + (message.sentAt - now)) / 2;
      this.clocks.push({ at: now, rtt, offset });
      this.clocks = this.clocks.filter((clock) => now - clock.at <= CLOCK_WINDOW_MS).slice(-32);
      return true;
    }
    if (message.type === 'latency.report') {
      this.peerReport = this.linked ? { at: now, ...message } : null;
      return true;
    }
    return false;
  }

  tick() {
    if (!this.connected) return;
    const now = this.now();
    if (this.connected) {
      for (const [id, started] of this.probes) {
        if (now - started > MAX_LATENCY_MS) this.probes.delete(id);
      }
      const interval = this.clocks.length < 5 ? 250 : 2000;
      if (now - this.lastProbeAt >= interval) {
        const id = ++this.sequence;
        this.probes.set(id, now);
        this.lastProbeAt = now;
        if (!this.#send({ type: 'latency.probe', id })) this.probes.delete(id);
      }
      if (now - this.lastReportAt < 1000) return;
      this.lastReportAt = now;
      this.#send({ type: 'latency.report', ...this.#incoming(now) });
    }
    this.onUpdate(this.state());
  }

  state() {
    const now = this.now();
    const clock = this.#clock(now);
    const incoming = this.#incoming(now);
    const outgoing = this.connected && this.linked && this.peerReport?.samples > 0
      && now - this.peerReport.at <= 3000 ? this.peerReport : null;
    return {
      connected: this.connected, linked: this.linked, calibrating: !clock,
      networkRttMs: clock?.rtt ?? null,
      incoming: incoming.samples ? incoming : null,
      outgoing: outgoing ? { medianMs: outgoing.medianMs, p95Ms: outgoing.p95Ms,
        uncertaintyMs: outgoing.uncertaintyMs, samples: outgoing.samples } : null,
    };
  }

  #incoming(now) {
    this.samples = this.samples.filter((sample) => now - sample.at <= WINDOW_MS);
    if (!this.connected || !this.linked || !this.#clock(now) || !this.samples.length) {
      return { medianMs: null, p95Ms: null, uncertaintyMs: null, samples: 0 };
    }
    const sorted = this.samples.map((sample) => sample.ms).sort((a, b) => a - b);
    return {
      medianMs: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95),
      uncertaintyMs: Math.max(...this.samples.map((sample) => sample.uncertaintyMs)), samples: sorted.length,
    };
  }

  #clock(now) {
    this.clocks = this.clocks.filter((clock) => now - clock.at <= CLOCK_WINDOW_MS);
    return this.clocks.reduce((best, clock) => !best || clock.rtt < best.rtt ? clock : best, null);
  }

  #clearReadings() {
    this.samples = [];
    this.pending = [];
    this.peerReport = null;
    this.lastSampleAt = -Infinity;
  }

  #send(message) {
    try { return this.send(message) !== false; }
    catch { return false; }
  }
}

module.exports = { MouseLatency, WINDOW_MS, CLOCK_WINDOW_MS, MAX_LATENCY_MS };
