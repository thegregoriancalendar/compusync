'use strict';

const hint = document.getElementById('hint');

window.compusync.onHandoffOverlay?.((state) => {
  const mode = ['seam', 'hint'].includes(state?.mode) ? state.mode : 'hidden';
  document.body.dataset.mode = mode;
  document.body.dataset.edge = ['left', 'right', 'bottom'].includes(state?.edge) ? state.edge : '';
  hint.textContent = mode === 'hint' && typeof state.message === 'string' ? state.message : '';
});
