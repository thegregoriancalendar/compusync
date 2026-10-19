'use strict';

// Shared by the extension, desktop validators, and the fixed Apple Events
// program. Peer data is always JSON; it never supplies executable JavaScript.
(function () {
  function sanitizePageState(value, expectedUrl) {
    if (!value || value.version !== 1 || value.url !== expectedUrl) return null;
    try { if (!['http:', 'https:'].includes(new URL(value.url).protocol)) return null; } catch { return null; }
    const coordinate = (part) => Number.isFinite(part) && Math.abs(part) <= 10_000_000;
    const path = (part) => typeof part === 'string' && part.length > 0 && part.length <= 1024
      && /^(?:[a-z][a-z0-9-]*:nth-child\([1-9][0-9]*\))(?:>[a-z][a-z0-9-]*:nth-child\([1-9][0-9]*\))*$/.test(part);
    if (!coordinate(value.scroll?.x) || !coordinate(value.scroll?.y)
      || !Number.isFinite(value.viewport?.w) || !Number.isFinite(value.viewport?.h)
      || value.viewport.w <= 0 || value.viewport.h <= 0 || value.viewport.w > 65536 || value.viewport.h > 65536
      || !Array.isArray(value.fields) || value.fields.length > 100
      || !Array.isArray(value.scrollers) || value.scrollers.length > 40
      || !Array.isArray(value.details) || value.details.length > 40) return null;
    const kinds = new Set(['text', 'search', 'url', 'tel', 'email', 'number', 'textarea', 'select-one', 'select-multiple', 'checkbox', 'radio']);
    let characters = 0;
    const fields = [];
    for (const field of value.fields) {
      if (!path(field?.path) || !kinds.has(field.kind)) return null;
      const clean = { path: field.path, kind: field.kind };
      if (field.kind === 'checkbox' || field.kind === 'radio') {
        if (typeof field.checked !== 'boolean') return null;
        clean.checked = field.checked;
      } else {
        const values = field.kind === 'select-multiple' ? field.values : [field.value];
        if (!Array.isArray(values) || values.length > 100 || values.some((item) => typeof item !== 'string' || item.length > 4096)) return null;
        characters += values.reduce((sum, item) => sum + item.length, 0);
        if (characters > 32768) return null;
        if (field.kind === 'select-multiple') clean.values = [...values];
        else clean.value = field.value;
      }
      fields.push(clean);
    }
    const scrollers = [];
    for (const item of value.scrollers) {
      if (!path(item?.path) || !coordinate(item.x) || !coordinate(item.y)) return null;
      scrollers.push({ path: item.path, x: item.x, y: item.y });
    }
    const details = [];
    for (const item of value.details) {
      if (!path(item?.path) || typeof item.open !== 'boolean') return null;
      details.push({ path: item.path, open: item.open });
    }
    const result = { version: 1, url: expectedUrl, viewport: { w: value.viewport.w, h: value.viewport.h },
      scroll: { x: value.scroll.x, y: value.scroll.y }, fields, scrollers, details };
    return JSON.stringify(result).length <= 128 * 1024 ? result : null;
  }

  // This function must remain self-contained: only its source is evaluated in
  // a page. No cookies, storage, HTML, passwords, files, or page scripts move.
  function pageState(operation, input) {
    const kinds = new Set(['text', 'search', 'url', 'tel', 'email', 'number', 'textarea', 'select-one', 'select-multiple', 'checkbox', 'radio']);
    const sensitive = /password|passwd|secret|token|credit|cardnumber|card-number|cc-|cvc|cvv|one-time-code/i;
    const kindOf = (element) => element.localName === 'textarea' ? 'textarea'
      : (element.localName === 'select' ? (element.multiple ? 'select-multiple' : 'select-one') : element.type);
    const allowed = (element) => ['input', 'textarea', 'select'].includes(element.localName)
      && kinds.has(kindOf(element)) && !element.disabled
      && !sensitive.test([element.name, element.id, element.autocomplete].join(' '));
    const pathFor = (element) => {
      const parts = [];
      for (let node = element; node?.nodeType === 1; node = node.parentElement) {
        let index = 1;
        for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) index += 1;
        parts.unshift(`${node.localName}:nth-child(${index})`);
        if (parts.length > 30) return null;
      }
      const path = parts.join('>');
      return path.length <= 1024 ? path : null;
    };
    if (operation === 'capture') {
      let characters = 0;
      const fields = [];
      for (const element of Array.from(document.querySelectorAll('input,textarea,select')).slice(0, 1000)) {
        if (!allowed(element) || fields.length >= 100) continue;
        const path = pathFor(element), kind = kindOf(element);
        if (!path) continue;
        const field = { path, kind };
        if (kind === 'checkbox' || kind === 'radio') field.checked = element.checked;
        else {
          const values = kind === 'select-multiple' ? Array.from(element.selectedOptions, (item) => item.value) : [element.value];
          const count = values.reduce((sum, item) => sum + item.length, 0);
          if (values.length > 100 || values.some((item) => item.length > 4096) || characters + count > 32768) continue;
          characters += count;
          if (kind === 'select-multiple') field.values = values;
          else field.value = element.value;
        }
        fields.push(field);
      }
      const scrollers = [], details = [];
      for (const element of Array.from(document.querySelectorAll('*')).slice(0, 5000)) {
        const hasScroll = element !== document.scrollingElement && (element.scrollLeft || element.scrollTop
          || element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth);
        if ((!hasScroll || scrollers.length >= 40) && (element.localName !== 'details' || details.length >= 40)) continue;
        const path = pathFor(element);
        if (!path) continue;
        if (hasScroll && scrollers.length < 40) scrollers.push({ path, x: element.scrollLeft, y: element.scrollTop });
        if (element.localName === 'details' && details.length < 40) details.push({ path, open: element.open });
      }
      return { version: 1, url: location.href, viewport: { w: innerWidth, h: innerHeight },
        scroll: { x: scrollX, y: scrollY }, fields, scrollers, details };
    }
    if (operation !== 'restore' || input?.url !== location.href) return { applied: false, reason: 'url-mismatch' };
    if (document.readyState === 'loading') return { applied: false, reason: 'loading' };
    for (const field of input.fields) {
      const element = document.querySelector(field.path);
      if (!element || !allowed(element) || kindOf(element) !== field.kind) continue;
      if (field.kind === 'checkbox' || field.kind === 'radio') element.checked = field.checked;
      else if (field.kind === 'select-multiple') {
        for (const option of element.options) option.selected = field.values.includes(option.value);
      } else element.value = field.value;
      // Do not replay input/change/submit handlers: restoring a draft must not
      // repeat a purchase, submit a form, or trigger duplicate network writes.
    }
    for (const item of input.details) {
      const element = document.querySelector(item.path);
      if (element?.localName === 'details') element.open = item.open;
    }
    for (const item of input.scrollers) {
      const element = document.querySelector(item.path);
      if (element) { element.scrollLeft = item.x; element.scrollTop = item.y; }
    }
    window.scrollTo({ left: input.scroll.x, top: input.scroll.y, behavior: 'instant' });
    return { applied: true, scroll: { x: scrollX, y: scrollY } };
  }

  const api = { sanitizePageState, pageState };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.CompuSyncPageState = api;
})();
