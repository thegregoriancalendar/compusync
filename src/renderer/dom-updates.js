'use strict';

// Keep selected text nodes alive during background refreshes. If a live reading
// changes while selected, show its latest value once the selection moves away.
window.CompuSyncDOM = (() => {
  const pendingText = new Map();

  function isSelected(element) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return false;
    for (let i = 0; i < selection.rangeCount; i++) {
      if (selection.getRangeAt(i).intersectsNode(element)) return true;
    }
    return false;
  }

  function setText(element, value) {
    const text = String(value ?? '');
    if (element.textContent === text) {
      pendingText.delete(element);
    } else if (isSelected(element)) {
      pendingText.set(element, text);
    } else {
      pendingText.delete(element);
      element.textContent = text;
    }
  }

  document.addEventListener('selectionchange', () => {
    for (const [element, text] of pendingText) {
      if (!element.isConnected) pendingText.delete(element);
      else if (!isSelected(element)) setText(element, text);
    }
  });

  function reconcileChildren(parent, children) {
    const keep = new Set(children);
    for (const child of Array.from(parent.children)) {
      if (!keep.has(child)) child.remove();
    }
    for (const [index, child] of children.entries()) {
      // Moving an existing node also clears selections, so only move when needed.
      if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] || null);
    }
  }

  return { setText, reconcileChildren };
})();
