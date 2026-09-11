'use strict';

(() => {
  const api = window.compusync.desktop;
  const world = document.getElementById('desktop-world');
  const desktopRoot = document.getElementById('desktop');
  const grid = document.getElementById('file-grid');
  const empty = document.getElementById('empty-workspace');
  const breadcrumbs = document.getElementById('breadcrumbs');
  const hostBadge = document.getElementById('host-badge');
  const importButton = document.getElementById('import-files');
  const folderButton = document.getElementById('new-folder');
  const renameButton = document.getElementById('rename-entry');
  const deleteButton = document.getElementById('delete-entry');
  const transferStatus = document.getElementById('transfer-status');
  const nameDialog = document.getElementById('name-dialog');
  const nameDialogLabel = document.getElementById('name-dialog-label');
  const nameInput = document.getElementById('entry-name');
  const cancelName = document.getElementById('cancel-name');
  const programWindow = document.getElementById('program-window');
  const programTitle = document.getElementById('program-title');
  const programHost = document.getElementById('program-host');
  const programFrame = document.getElementById('program-frame');
  const programWaiting = document.getElementById('program-waiting');
  const closeProgramButton = document.getElementById('close-program');

  let currentPath = '';
  let entries = [];
  let selectedPath = null;
  let serviceState = { programs: [] };
  let activeProgram = null;
  let frameSize = { width: 800, height: 500 };
  const latestFrames = new Map();
  let dialogAction = null;
  let statusTimer;
  let refreshSerial = 0;

  async function unwrap(promise) {
    const result = await promise;
    if (result && result.ok === false) throw new Error(result.error || 'The host rejected this request.');
    return result?.value ?? result;
  }

  function showStatus(message, error = false, persistent = false) {
    clearTimeout(statusTimer);
    transferStatus.hidden = false;
    transferStatus.textContent = message;
    transferStatus.style.color = error ? '#a13f49' : '#42516a';
    if (!persistent) statusTimer = setTimeout(() => { transferStatus.hidden = true; }, 3500);
  }

  function formatSize(size) {
    if (!Number.isFinite(size)) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  function entryIcon(entry) {
    if (entry.type === 'directory') return '▰';
    if (/\.(txt|md|json|js|cjs|mjs|css|html|xml|csv|log)$/i.test(entry.name)) return '▤';
    return '◇';
  }

  function select(path) {
    selectedPath = path;
    for (const element of grid.querySelectorAll('.file-entry')) {
      element.classList.toggle('selected', element.dataset.path === path);
      element.setAttribute('aria-selected', String(element.dataset.path === path));
    }
    renameButton.disabled = !path;
    deleteButton.disabled = !path;
  }

  function renderBreadcrumbs() {
    breadcrumbs.replaceChildren();
    const parts = currentPath ? currentPath.split('/') : [];
    const paths = ['', ...parts.map((_part, index) => parts.slice(0, index + 1).join('/'))];
    const labels = ['Workspace', ...parts];
    labels.forEach((label, index) => {
      if (index) {
        const separator = document.createElement('span');
        separator.textContent = '›';
        breadcrumbs.append(separator);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => { currentPath = paths[index]; refresh(); });
      breadcrumbs.append(button);
    });
  }

  function renderEntries() {
    grid.replaceChildren();
    empty.hidden = entries.length > 0;
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `file-entry ${entry.type === 'directory' ? 'folder' : 'file'}`;
      button.dataset.path = entry.path;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', 'false');
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = entryIcon(entry);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = entry.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = entry.type === 'directory' ? 'Folder' : formatSize(entry.size);
      button.append(icon, name, meta);
      button.addEventListener('click', () => select(entry.path));
      button.addEventListener('dblclick', async () => {
        if (entry.type === 'directory') {
          currentPath = entry.path;
          await refresh();
        } else {
          try { await unwrap(api.launchTextEditor(entry.path)); }
          catch (error) { showStatus(error.message, true); }
        }
      });
      grid.append(button);
    }
    select(entries.some((entry) => entry.path === selectedPath) ? selectedPath : null);
    renderBreadcrumbs();
  }

  async function refresh() {
    const serial = ++refreshSerial;
    try {
      const listing = await unwrap(api.list(currentPath));
      if (serial !== refreshSerial) return;
      if (!Array.isArray(listing) && listing?.path !== undefined) currentPath = listing.path || '';
      entries = Array.isArray(listing) ? listing : Array.isArray(listing?.entries) ? listing.entries : [];
      const hostName = serviceState.host?.name || listing?.hostName;
      if (hostName) hostBadge.textContent = `${hostName} workspace`;
      renderEntries();
    } catch (error) {
      if (serial === refreshSerial) showStatus(error.message, true);
    }
  }

  function showProgramFrame(frame) {
    frameSize = { width: frame.width || 800, height: frame.height || 500 };
    programFrame.src = `data:${frame.mimeType || 'image/jpeg'};base64,${frame.data}`;
    programWaiting.hidden = true;
  }

  function renderPrograms() {
    const programs = Array.isArray(serviceState.programs) ? serviceState.programs : [];
    const previousProgramId = activeProgram?.id || null;
    const runningIds = new Set(programs.map((program) => program.id));
    for (const programId of latestFrames.keys()) {
      if (!runningIds.has(programId)) latestFrames.delete(programId);
    }
    activeProgram = programs[0] || null;
    programWindow.hidden = !activeProgram;
    if (!activeProgram) {
      programFrame.removeAttribute('src');
      programWaiting.hidden = false;
      return;
    }
    programTitle.textContent = activeProgram.title || 'Text Editor';
    programHost.textContent = serviceState.host?.name ? `Running on ${serviceState.host.name}` : 'Running on host';
    if (activeProgram.id !== previousProgramId) {
      frameSize = { width: activeProgram.width || 800, height: activeProgram.height || 500 };
      programFrame.removeAttribute('src');
      const cached = latestFrames.get(activeProgram.id);
      if (cached) showProgramFrame(cached);
      else programWaiting.hidden = false;
    } else {
      programWaiting.hidden = programFrame.hasAttribute('src');
    }
  }

  function openNameDialog(label, value, action) {
    dialogAction = action;
    nameDialogLabel.textContent = label;
    nameInput.value = value || '';
    nameDialog.hidden = false;
    nameInput.focus();
    nameInput.select();
  }

  function closeNameDialog() {
    nameDialog.hidden = true;
    dialogAction = null;
  }

  importButton.addEventListener('click', async () => {
    try {
      const result = await unwrap(api.importPicker(currentPath));
      if (result?.cancelled) return;
      const count = Array.isArray(result) ? result.length : result?.count || 0;
      showStatus(`Imported ${count} item${count === 1 ? '' : 's'}.`);
      await refresh();
    } catch (error) { showStatus(error.message, true); }
  });

  folderButton.addEventListener('click', () => openNameDialog('New folder name', '', async (name) => {
    await unwrap(api.mkdir(currentPath, name));
    await refresh();
  }));

  renameButton.addEventListener('click', () => {
    const entry = entries.find((candidate) => candidate.path === selectedPath);
    if (!entry) return;
    openNameDialog('Rename item', entry.name, async (name) => {
      await unwrap(api.rename(entry.path, name));
      selectedPath = null;
      await refresh();
    });
  });

  deleteButton.addEventListener('click', async () => {
    const entry = entries.find((candidate) => candidate.path === selectedPath);
    if (!entry || !window.confirm(`Delete “${entry.name}” from the shared workspace?`)) return;
    try {
      await unwrap(api.delete(entry.path));
      selectedPath = null;
      await refresh();
    } catch (error) { showStatus(error.message, true); }
  });

  nameDialog.addEventListener('submit', async (event) => {
    event.preventDefault();
    const action = dialogAction;
    const name = nameInput.value.trim();
    if (!action || !name) return;
    try { await action(name); closeNameDialog(); }
    catch (error) { showStatus(error.message, true); }
  });
  cancelName.addEventListener('click', closeNameDialog);

  for (const type of ['dragenter', 'dragover']) desktopRoot.addEventListener(type, (event) => {
    event.preventDefault();
    event.stopPropagation();
    world.classList.add('drag-over');
  });
  for (const type of ['dragleave', 'drop']) desktopRoot.addEventListener(type, (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (type === 'dragleave' && event.relatedTarget && world.contains(event.relatedTarget)) return;
    world.classList.remove('drag-over');
  });
  desktopRoot.addEventListener('drop', async (event) => {
    const files = [...event.dataTransfer.files];
    if (!files.length) return;
    try {
      const result = await unwrap(api.importDroppedFiles(files, currentPath));
      const count = Array.isArray(result) ? result.length : result?.count || files.length;
      showStatus(`Imported ${count} item${count === 1 ? '' : 's'}.`);
      await refresh();
    } catch (error) { showStatus(error.message, true); }
  });

  function programPoint(event) {
    const bounds = programFrame.getBoundingClientRect();
    return {
      x: Math.round((event.clientX - bounds.left) / Math.max(1, bounds.width) * frameSize.width),
      y: Math.round((event.clientY - bounds.top) / Math.max(1, bounds.height) * frameSize.height),
    };
  }

  function modifiers(event) {
    return [event.shiftKey && 'shift', event.ctrlKey && 'control', event.altKey && 'alt', event.metaKey && 'meta'].filter(Boolean);
  }

  function sendProgram(input) {
    if (activeProgram) api.programInput(activeProgram.id, input).catch(() => {});
  }

  programFrame.addEventListener('mousemove', (event) => sendProgram({ type: 'mouseMove', ...programPoint(event), modifiers: modifiers(event) }));
  programFrame.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    programFrame.focus();
    sendProgram({ type: 'mouseDown', ...programPoint(event), button: ['left', 'middle', 'right'][event.button] || 'left', clickCount: event.detail || 1, modifiers: modifiers(event) });
  });
  programFrame.addEventListener('mouseup', (event) => {
    event.preventDefault();
    event.stopPropagation();
    sendProgram({ type: 'mouseUp', ...programPoint(event), button: ['left', 'middle', 'right'][event.button] || 'left', clickCount: event.detail || 1, modifiers: modifiers(event) });
  });
  programFrame.addEventListener('wheel', (event) => {
    event.preventDefault();
    sendProgram({ type: 'mouseWheel', ...programPoint(event), deltaX: Math.round(event.deltaX), deltaY: Math.round(event.deltaY), modifiers: modifiers(event) });
  }, { passive: false });
  programFrame.addEventListener('keydown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const mods = modifiers(event);
    sendProgram({ type: 'keyDown', keyCode: event.key, modifiers: mods, isAutoRepeat: event.repeat });
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      sendProgram({ type: 'char', keyCode: event.key, modifiers: mods });
    }
  });
  programFrame.addEventListener('keyup', (event) => {
    event.preventDefault();
    event.stopPropagation();
    sendProgram({ type: 'keyUp', keyCode: event.key, modifiers: modifiers(event) });
  });
  programFrame.addEventListener('contextmenu', (event) => event.preventDefault());

  closeProgramButton.addEventListener('click', async () => {
    if (!activeProgram) return;
    try { await unwrap(api.closeProgram(activeProgram.id)); }
    catch (error) { showStatus(error.message, true); }
  });

  world.addEventListener('mousedown', (event) => event.stopPropagation());
  world.addEventListener('mousemove', (event) => event.stopPropagation());
  world.addEventListener('mouseup', (event) => event.stopPropagation());
  world.addEventListener('pointerover', (event) => {
    if (event.target.closest('[data-desktop-interactive]')) window.compusyncSurface?.pauseContent();
  });
  world.addEventListener('pointerout', (event) => {
    if (event.relatedTarget?.closest?.('[data-desktop-interactive]')) return;
    window.compusyncSurface?.resumeContent();
  });

  api.onState((next) => {
    const previousWorkspace = serviceState.workspaceSerial;
    serviceState = next || { programs: [] };
    renderPrograms();
    if (serviceState.workspaceSerial !== previousWorkspace) refresh();
  });
  api.onFrame((frame) => {
    if (!frame?.programId || !frame.data) return;
    const previous = latestFrames.get(frame.programId);
    if (!previous || frame.serial >= previous.serial) latestFrames.set(frame.programId, frame);
    if (activeProgram?.id === frame.programId) showProgramFrame(latestFrames.get(frame.programId));
  });
  api.onTransfer((progress) => {
    if (!progress) return;
    if (progress.error) showStatus(progress.error, true);
    else if (progress.done) showStatus(progress.message || 'Import complete.');
    else showStatus(progress.message || 'Transferring…', false, true);
  });

  window.sharedDesktop = {
    updateGeometry(geometry) {
      world.style.left = `${-geometry.contentOffsetX}px`;
      world.style.top = `${-geometry.contentOffsetY}px`;
      world.style.width = `${geometry.contentWidth}px`;
      world.style.height = `${geometry.contentHeight}px`;
    },
  };

  api.bootstrap().then((next) => {
    serviceState = next || { programs: [] };
    renderPrograms();
    refresh();
  }).catch((error) => showStatus(error.message, true));
})();
