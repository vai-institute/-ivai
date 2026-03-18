/**
 * renderer.js — Main Window Client Logic
 * =========================================
 * Role in VAI architecture:
 *   Runs in the Electron renderer process for the main CVA workstation window.
 *   Handles DOM interaction, UI state, and IPC communication via
 *   window.electronAPI (preload.js → main.js).
 *
 *   Step 1:  IPC bridge smoke test
 *   Step 2:  Corpus loading
 *   Step 3:  Session state + resume dialog
 *   Step 4:  Layout preset switching + drag handle resize (current)
 *   Step 5:  Case display and navigation
 *   Step 6:  Streaming API calls
 *   Step 7:  Role selection
 *   Step 8:  Right rail controls
 *   Step 9:  Write Pair
 *   Step 10: Skip / Flag
 *   Step 11: Write Additional Pair
 *   Step 12: Keyboard shortcuts
 *   Step 14: Session summary modal
 *
 * @module renderer
 */

'use strict';

// ─── Module-level state ───────────────────────────────────────────────────────

/** Full sorted corpus array. Populated by loadCorpus(). @type {object[]} */
let corpus = [];

/** Mirrors session/progress.json. Updated and persisted after every action.
 *  @type {object|null} */
let sessionProgress = null;

/** Index into corpus[] of the currently displayed case. @type {number} */
let currentIndex = 0;

// ─── DOM references ───────────────────────────────────────────────────────────
// Resolved once on DOMContentLoaded; used throughout the module.

/** @type {HTMLElement} */ let sidebar;
/** @type {HTMLElement} */ let rightRail;
/** @type {HTMLElement} */ let panelStandard;
/** @type {HTMLElement} */ let panelVai;

// ─── Step 1: IPC bridge smoke test ───────────────────────────────────────────
// Runs immediately (before DOMContentLoaded) because the target element
// is inline in the HTML. Removed in a future step when the topbar replaces
// the scaffold notice.

(function checkBridge() {
  // The scaffold notice elements are gone in Step 4 — guard with getElementById
  var el = document.getElementById('electron-version');
  if (!el) return;
  try {
    el.textContent = 'IPC bridge OK — Electron ' + window.electronAPI.getElectronVersion();
  } catch (err) {
    el.textContent = 'IPC bridge ERROR: ' + err.message;
  }
})();

// ─── Step 2: Corpus loading ───────────────────────────────────────────────────

/**
 * Scans data/corpus/ via the main process, stores cases in `corpus`.
 * @returns {Promise<void>}
 */
async function loadCorpus() {
  try {
    var result = await window.electronAPI.loadCorpus();
    corpus = result.cases;
    if (result.errors.length > 0) {
      result.errors.forEach(function(e) { console.warn('[corpus]', e); });
    }
    console.log('[renderer] Loaded ' + corpus.length.toLocaleString() +
                ' cases from ' + result.fileCount + ' JSONL files.');
    populateVerticalFilter();
  } catch (err) {
    console.error('[renderer] Corpus load failed:', err.message);
  }
}

/**
 * Populates the vertical filter dropdown from unique verticals in corpus.
 * Called after corpus is loaded in Step 2; filter logic wired in Step 5.
 * @returns {void}
 */
function populateVerticalFilter() {
  var select = document.getElementById('filter-vertical');
  if (!select || corpus.length === 0) return;

  // Collect unique verticals in corpus order, then sort alphabetically
  var seen = {};
  var verticals = [];
  corpus.forEach(function(c) {
    if (!seen[c.vertical]) {
      seen[c.vertical] = true;
      verticals.push(c.vertical);
    }
  });
  verticals.sort();

  verticals.forEach(function(v) {
    var opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  });
}

// ─── Step 3: Session state ────────────────────────────────────────────────────

/**
 * Reads progress.json; on first launch creates a fresh file.
 * Shows the resume dialog if a prior case exists.
 * After resolution, sessionProgress is populated.
 * @returns {Promise<void>}
 */
async function initSession() {
  try {
    var result = await window.electronAPI.readSession();

    if (result.isFirstLaunch || !result.progress) {
      var resetResult = await window.electronAPI.resetSession();
      sessionProgress = resetResult.progress;
      console.log('[session] First launch — fresh progress created.');
      return;
    }

    sessionProgress = result.progress;

    if (result.progress.last_case_number !== null) {
      await showResumeDialog(result.progress);
    }

    console.log('[session] Resuming from case #' + result.progress.last_case_number +
                '. ' + result.progress.pairs_written + ' pairs written.');

  } catch (err) {
    console.error('[session] initSession failed:', err.message);
  }
}

/**
 * Shows the resume/start-fresh dialog. Resolves when the CVA makes a choice.
 * @param {object} progress - Existing progress object
 * @returns {Promise<void>}
 */
function showResumeDialog(progress) {
  return new Promise(function(resolve) {
    var dialog    = document.getElementById('resume-dialog');
    var msgEl     = document.getElementById('resume-message');
    var resumeBtn = document.getElementById('btn-resume');
    var freshBtn  = document.getElementById('btn-start-fresh');

    var pairsLabel = progress.pairs_written === 1 ? 'pair' : 'pairs';
    msgEl.textContent = 'Previous session found: Case #' + progress.last_case_number +
                        ', ' + progress.pairs_written + ' ' + pairsLabel + ' written.';

    // Show dialog using CSS class (cleaner than inline style)
    dialog.classList.add('visible');

    var onResume, onFresh;

    onResume = function() {
      resumeBtn.removeEventListener('click', onResume);
      freshBtn.removeEventListener('click', onFresh);
      dialog.classList.remove('visible');
      console.log('[session] CVA chose Resume.');
      resolve();
    };

    onFresh = function() {
      resumeBtn.removeEventListener('click', onResume);
      freshBtn.removeEventListener('click', onFresh);
      dialog.classList.remove('visible');
      window.electronAPI.resetSession().then(function(r) {
        sessionProgress = r.progress;
        currentIndex    = 0;
        console.log('[session] CVA chose Start Fresh.');
        resolve();
      });
    };

    resumeBtn.addEventListener('click', onResume);
    freshBtn.addEventListener('click', onFresh);
  });
}

/**
 * Persists sessionProgress to disk. Non-fatal on failure.
 * @returns {Promise<void>}
 */
async function saveSession() {
  if (!sessionProgress) return;
  try {
    var result = await window.electronAPI.writeSession(sessionProgress);
    if (!result.ok) console.error('[session] Save failed:', result.error);
  } catch (err) {
    console.error('[session] saveSession threw:', err.message);
  }
}

// ─── Settings modal — API keys ────────────────────────────────────────────────

/**
 * Current font size step index into FONT_SIZES array.
 * Persisted in sessionProgress.fontSize (added opportunistically — not in spec,
 * but harmless extra field on the progress object).
 * @type {number}
 */
var fontSizeIndex = 2; // default: index 2 = 13px

/**
 * Available font size steps for response panel text (px).
 * Covers accessibility range from 11px (compact) to 18px (large print).
 * @type {number[]}
 */
var FONT_SIZES = [11, 12, 13, 14, 15, 16, 18];

/**
 * Applies the font size at the given index to panel bodies and textareas.
 * Updates the CSS variable --response-font-size used by .panel-body.
 *
 * @param {number} index - Index into FONT_SIZES
 * @returns {void}
 */
function applyFontSize(index) {
  fontSizeIndex = Math.max(0, Math.min(FONT_SIZES.length - 1, index));
  var size = FONT_SIZES[fontSizeIndex];
  // Apply via CSS custom property so all panel bodies update at once
  document.documentElement.style.setProperty('--response-font-size', size + 'px');
  // Update button disabled states at min/max
  var decBtn = document.getElementById('btn-font-decrease');
  var incBtn = document.getElementById('btn-font-increase');
  if (decBtn) decBtn.disabled = (fontSizeIndex === 0);
  if (incBtn) incBtn.disabled = (fontSizeIndex === FONT_SIZES.length - 1);
}

/**
 * Wires the A− / A+ font size buttons in the topbar.
 * @returns {void}
 */
function initFontSizeControls() {
  var decBtn = document.getElementById('btn-font-decrease');
  var incBtn = document.getElementById('btn-font-increase');
  if (decBtn) decBtn.addEventListener('click', function() { applyFontSize(fontSizeIndex - 1); });
  if (incBtn) incBtn.addEventListener('click', function() { applyFontSize(fontSizeIndex + 1); });
  // Apply saved size or default
  var saved = (sessionProgress && sessionProgress.fontSize != null)
              ? sessionProgress.fontSize : fontSizeIndex;
  applyFontSize(saved);
}

/**
 * Opens the settings modal and pre-fills the key fields with stored values.
 * Keys are shown masked (password type) by default.
 * @returns {Promise<void>}
 */
async function openSettingsModal() {
  var modal = document.getElementById('settings-modal');
  var gearBtn = document.getElementById('btn-settings');
  if (!modal) return;

  // Pre-fill with stored keys
  try {
    var keys = await window.electronAPI.readApiKeys();
    document.getElementById('key-together').value  = keys.together_ai;
    document.getElementById('key-openai').value    = keys.openai;
    document.getElementById('key-anthropic').value = keys.anthropic;
  } catch (err) {
    console.warn('[settings] Could not read API keys:', err.message);
  }

  // Clear previous save status
  var statusEl = document.getElementById('settings-save-status');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }

  modal.classList.add('visible');
  if (gearBtn) gearBtn.classList.add('active');
}

/**
 * Closes the settings modal without saving.
 * @returns {void}
 */
function closeSettingsModal() {
  var modal   = document.getElementById('settings-modal');
  var gearBtn = document.getElementById('btn-settings');
  if (modal)   modal.classList.remove('visible');
  if (gearBtn) gearBtn.classList.remove('active');
}

/**
 * Reads key values from the settings form and saves them via the main process.
 * Shows inline success/error feedback.
 * @returns {Promise<void>}
 */
async function saveApiKeys() {
  var statusEl = document.getElementById('settings-save-status');
  var saveBtn  = document.getElementById('btn-settings-save');

  var keys = {
    together_ai: document.getElementById('key-together').value.trim(),
    openai:      document.getElementById('key-openai').value.trim(),
    anthropic:   document.getElementById('key-anthropic').value.trim()
  };

  if (saveBtn) saveBtn.disabled = true;

  try {
    var result = await window.electronAPI.writeApiKeys(keys);
    if (result.ok) {
      statusEl.textContent = '✓ Keys saved to config/api_keys.json';
      statusEl.className = 'success';
      // Auto-close after brief confirmation
      setTimeout(closeSettingsModal, 1200);
    } else {
      statusEl.textContent = '✗ Save failed: ' + result.error;
      statusEl.className = 'error';
    }
  } catch (err) {
    statusEl.textContent = '✗ Save failed: ' + err.message;
    statusEl.className = 'error';
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/**
 * Wires the gear button, close/cancel/save actions, show/hide toggles,
 * and Escape key handler for the settings modal.
 * @returns {void}
 */
function initSettingsModal() {
  // Open
  var gearBtn = document.getElementById('btn-settings');
  if (gearBtn) gearBtn.addEventListener('click', openSettingsModal);

  // Close / cancel
  var closeBtn  = document.getElementById('btn-settings-close');
  var cancelBtn = document.getElementById('btn-settings-cancel');
  if (closeBtn)  closeBtn.addEventListener('click',  closeSettingsModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeSettingsModal);

  // Save
  var saveBtn = document.getElementById('btn-settings-save');
  if (saveBtn) saveBtn.addEventListener('click', saveApiKeys);

  // Escape key closes the modal
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      var modal = document.getElementById('settings-modal');
      if (modal && modal.classList.contains('visible')) closeSettingsModal();
    }
  });

  // Show/Hide toggle buttons — toggle password ↔ text on each key field
  document.querySelectorAll('.btn-toggle-visibility').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var targetId = btn.getAttribute('data-target');
      var input    = document.getElementById(targetId);
      if (!input) return;
      var isHidden = input.type === 'password';
      input.type   = isHidden ? 'text' : 'password';
      btn.textContent = isHidden ? 'Hide' : 'Show';
    });
  });

  // Click backdrop to close
  var modal = document.getElementById('settings-modal');
  if (modal) {
    modal.addEventListener('click', function(e) {
      if (e.target === modal) closeSettingsModal();
    });
  }
}

/**
 * Layout preset definitions (spec Section 7.2).
 *
 * sidebarWidth / railWidth are pixel values applied as explicit widths.
 * Setting min-width and max-width to the same value prevents the flex
 * algorithm from overriding our explicit sizing.
 *
 * @type {Object.<string, {sidebarWidth:number, railWidth:number}>}
 */
var LAYOUT_PRESETS = {
  'compact': { sidebarWidth: 32,  railWidth: 200 },
  'wide':    { sidebarWidth: 190, railWidth: 220 },
  'dual':    { sidebarWidth: 190, railWidth: 32  }
};

/**
 * Applies a named layout preset to the sidebar and right rail.
 * Updates the active button state and persists the choice to sessionProgress.
 *
 * @param {string} presetName - 'compact' | 'wide' | 'dual'
 * @returns {void}
 */
function applyLayoutPreset(presetName) {
  var preset = LAYOUT_PRESETS[presetName];
  if (!preset) return;

  var sidebarCollapsed = preset.sidebarWidth <= 32;
  var railCollapsed    = preset.railWidth    <= 32;

  // Apply sidebar width
  sidebar.style.width    = preset.sidebarWidth + 'px';
  sidebar.style.minWidth = preset.sidebarWidth + 'px';
  sidebar.style.maxWidth = preset.sidebarWidth + 'px';
  sidebar.classList.toggle('collapsed', sidebarCollapsed);

  // Apply rail width
  rightRail.style.width    = preset.railWidth + 'px';
  rightRail.style.minWidth = preset.railWidth + 'px';
  rightRail.style.maxWidth = preset.railWidth + 'px';
  rightRail.classList.toggle('collapsed', railCollapsed);

  // Update active button state
  ['compact', 'wide', 'dual'].forEach(function(name) {
    var btn = document.getElementById('preset-' + name);
    if (btn) btn.classList.toggle('active', name === presetName);
  });

  // Persist layout choice to session (best-effort — don't await)
  if (sessionProgress) {
    sessionProgress.layout = presetName;
    saveSession();
  }
}

/**
 * Wires the three layout preset buttons to applyLayoutPreset().
 * @returns {void}
 */
function initLayoutPresets() {
  ['compact', 'wide', 'dual'].forEach(function(name) {
    var btn = document.getElementById('preset-' + name);
    if (btn) {
      btn.addEventListener('click', function() { applyLayoutPreset(name); });
    }
  });

  // Expand sidebar when collapse-icon button is clicked
  var expandBtn = document.getElementById('sidebar-expand-btn');
  if (expandBtn) {
    expandBtn.addEventListener('click', function() {
      applyLayoutPreset(sessionProgress && sessionProgress.layout !== 'compact'
                        ? (sessionProgress.layout || 'wide') : 'wide');
    });
  }

  // Apply saved layout from session, defaulting to Wide
  var saved = (sessionProgress && sessionProgress.layout) || 'wide';
  applyLayoutPreset(saved);
}

// ─── Step 4: Drag handle resize logic ────────────────────────────────────────

/**
 * Attaches drag-to-resize behaviour to a drag handle element.
 *
 * On mousedown: records start X and the current widths of the two adjacent
 * elements. On mousemove: adjusts widths by the delta. On mouseup: cleans up.
 *
 * Min-width enforcement prevents panels from collapsing below usable size.
 *
 * @param {HTMLElement} handle      - The .drag-handle element
 * @param {HTMLElement} leftEl      - Element whose right edge the handle is on
 * @param {HTMLElement} rightEl     - Element to the right of the handle
 * @param {number}      leftMin     - Minimum width for leftEl in px
 * @param {number}      rightMin    - Minimum width for rightEl in px
 * @param {boolean}     [rightFixed=false] - If true, resize leftEl only (rightEl
 *                                           is flex:1 and fills remaining space)
 * @returns {void}
 */
function attachDragHandle(handle, leftEl, rightEl, leftMin, rightMin, rightFixed) {
  var dragging   = false;
  var startX     = 0;
  var startLeft  = 0;
  var startRight = 0;

  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    dragging   = true;
    startX     = e.clientX;
    startLeft  = leftEl.getBoundingClientRect().width;
    startRight = rightEl.getBoundingClientRect().width;
    handle.classList.add('dragging');
    // Apply a global cursor during drag so it doesn't flicker when leaving handle
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    var delta    = e.clientX - startX;
    var newLeft  = Math.max(leftMin,  startLeft  + delta);
    var newRight = Math.max(rightMin, startRight - delta);

    // Apply new left element width
    leftEl.style.width    = newLeft + 'px';
    leftEl.style.minWidth = newLeft + 'px';
    leftEl.style.maxWidth = newLeft + 'px';

    // Only constrain the right element if it has a fixed width
    // (panels use flex:1 so we only set the left panel's flex-basis)
    if (!rightFixed) {
      rightEl.style.width    = newRight + 'px';
      rightEl.style.minWidth = newRight + 'px';
      rightEl.style.maxWidth = newRight + 'px';
    }

    // Update collapsed class for sidebar/rail based on width
    if (leftEl.id === 'sidebar') {
      leftEl.classList.toggle('collapsed', newLeft <= 40);
    }
    if (rightEl.id === 'right-rail') {
      rightEl.classList.toggle('collapsed', newRight <= 40);
    }
  });

  document.addEventListener('mouseup', function() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

/**
 * Wires all three drag handles to their adjacent elements.
 * Called once on DOMContentLoaded after DOM refs are resolved.
 * @returns {void}
 */
function initDragHandles() {
  var dragSidebar = document.getElementById('drag-sidebar');
  var dragPanels  = document.getElementById('drag-panels');
  var dragRail    = document.getElementById('drag-rail');
  var center      = document.getElementById('center');

  // Sidebar ↔ center: sidebar has fixed width; center fills remaining space
  attachDragHandle(dragSidebar, sidebar, center, 32, 400, true);

  // Standard panel ↔ VAI panel: both flex:1, min 200px each
  attachDragHandle(dragPanels, panelStandard, panelVai, 200, 200, false);

  // Center ↔ right rail: rail has fixed width; center fills remaining space
  // Note: leftEl here is center (flex:1), rightEl is right-rail (fixed)
  // We invert the delta direction by passing rightEl as the sized element
  var dragRailHandle = document.getElementById('drag-rail');
  dragRailHandle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    var startX     = e.clientX;
    var startRight = rightRail.getBoundingClientRect().width;
    dragRailHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(ev) {
      var delta    = startX - ev.clientX; // inverted: dragging left widens rail
      var newWidth = Math.max(32, startRight + delta);
      rightRail.style.width    = newWidth + 'px';
      rightRail.style.minWidth = newWidth + 'px';
      rightRail.style.maxWidth = newWidth + 'px';
      rightRail.classList.toggle('collapsed', newWidth <= 40);
    }

    function onUp() {
      dragRailHandle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ─── Step 4: Response mode chip selection ─────────────────────────────────────

/**
 * Wires the three response mode chips (Standard VAI / Humanizing / Boundary)
 * to mutual-exclusive selection. Logic is wired now; defaults are set in Step 8.
 * @returns {void}
 */
function initModeChips() {
  var chips = document.querySelectorAll('.mode-chip');
  chips.forEach(function(chip) {
    chip.addEventListener('click', function() {
      chips.forEach(function(c) { c.classList.remove('active'); });
      chip.classList.add('active');
    });
  });
}

/**
 * Wires the confidence and dataset split chip rows to mutual-exclusive selection.
 * @returns {void}
 */
function initChipRows() {
  // Confidence chips — only one active at a time
  var confChips = document.querySelectorAll('[data-confidence]');
  confChips.forEach(function(chip) {
    chip.addEventListener('click', function() {
      confChips.forEach(function(c) { c.classList.remove('active'); });
      chip.classList.add('active');
      // TODO Step 9: update Write Pair enabled state
    });
  });

  // Split chips — only one active at a time (default: Train)
  var splitChips = document.querySelectorAll('[data-split]');
  splitChips.forEach(function(chip) {
    chip.addEventListener('click', function() {
      splitChips.forEach(function(c) { c.classList.remove('active'); });
      chip.classList.add('active');
    });
  });
}

// ─── Startup sequence ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
  // Resolve DOM references used throughout this module
  sidebar      = document.getElementById('sidebar');
  rightRail    = document.getElementById('right-rail');
  panelStandard = document.getElementById('panel-standard');
  panelVai     = document.getElementById('panel-vai');

  // Step 2: Load corpus
  loadCorpus().then(function() {
    // Step 3: Init session (reads progress.json, shows resume dialog if needed)
    return initSession();
  }).then(function() {
    // Step 4: Apply layout and wire interactions
    initLayoutPresets();
    initDragHandles();
    initModeChips();
    initChipRows();
    initFontSizeControls();
    initSettingsModal();

    // TODO Step 5: display first/resumed case
    // TODO Step 6: wire API generation
    // TODO Step 8: wire flag defaults from case data
    // TODO Step 9: wire Write Pair enabled state
    // TODO Step 12: register keyboard shortcuts
  });
});
