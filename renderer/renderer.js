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

/** Active vertical filter value. Empty string = no filter. @type {string} */
let activeVertical = '';

/** Active inversion type filter value. Empty string = no filter. @type {string} */
let activeInversionType = '';

/**
 * CURRENT_USER_ID
 * @description Hard-coded CVA user ID for session API calls.
 *   Temporary until the Step 16 launch modal provides the user
 *   selection UI. Replace with the selected user ID in Step 16.
 * @type {string}
 */
const CURRENT_USER_ID = 'peter_d';

/** Loaded API keys from config. Populated by initApiKeys(). @type {Object} */
let apiKeys = { together_ai: '', openai: '', anthropic: '' };

/**
 * Tracks streaming state for each panel slot.
 * Key: slotId (e.g. 'std-0', 'vai-0')
 * Value: { streaming: boolean, fullText: string }
 * @type {Map<string, Object>}
 */
const slotState = new Map();

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
    if (!result.success) {
      console.error('[corpus] Load failed:', result.error);
      return;
    }
    corpus = result.cases;
    console.log('[renderer] Loaded ' + corpus.length.toLocaleString() +
                ' cases from Railway API.');
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
    var result = await window.electronAPI.readSession(CURRENT_USER_ID);

    if (!result.success || !result.session) {
      // No session on server yet — reset to defaults
      var resetResult = await window.electronAPI.resetSession(CURRENT_USER_ID);
      sessionProgress = resetResult.session;
      console.log('[session] First launch — fresh session created.');
      return;
    }

    sessionProgress = result.session;

    if (result.session.last_case_number && result.session.pairs_written > 0) {
      await showResumeDialog(result.session);
    }

    console.log('[session] Resuming from case #' + result.session.last_case_number +
                '. ' + result.session.pairs_written + ' pairs written.');

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
      window.electronAPI.resetSession(CURRENT_USER_ID).then(function(r) {
        sessionProgress = r.session;
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
    sessionProgress.last_updated = new Date().toISOString();
    var result = await window.electronAPI.writeSession(CURRENT_USER_ID, sessionProgress);
    if (!result.success) console.error('[session] Save failed:', result.error);
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

// ─── Step 5: Case display and navigation ──────────────────────────────────────

/**
 * Returns the CSS class suffix for a badge based on field and value.
 * Maps corpus field values to the color scheme defined in spec Section 7.4.
 *
 * @param {string} field  - Corpus field name ('inversion_type', 'subtlety', etc.)
 * @param {string} value  - Field value from corpus case
 * @returns {string} CSS class to apply to the badge element
 */
function getBadgeClass(field, value) {
  var map = {
    inversion_type: {
      'Type I':   'badge-blue',
      'Type II':  'badge-amber',
      'Type III': 'badge-red',
      'Type IV':  'badge-red'
    },
    subtlety: {
      'Subtle':   'badge-green',
      'Moderate': 'badge-amber',
      'Overt':    'badge-red'
    },
    inversion_severity: {
      'Low':      'badge-green',
      'Moderate': 'badge-amber',
      'Severe':   'badge-red'
    },
    appropriate_intensity: {
      'Silent':   'badge-gray',
      'Light':    'badge-green',
      'Balanced': 'badge-blue',
      'Direct':   'badge-red'
    },
    boundary_condition: {
      true:  'badge-red',
      false: 'badge-gray'
    },
    identity_language: {
      true:   'badge-purple',
      false:  'badge-gray'
    }
  };
  var fieldMap = map[field];
  if (!fieldMap) return '';
  // Boolean fields — convert to string key lookup
  var key = (typeof value === 'boolean') ? value : value;
  return fieldMap[key] || '';
}

/**
 * Sets text content and badge color class on a metadata value element.
 * Removes any previously applied badge-* class before applying the new one.
 *
 * @param {string} elementId  - DOM element ID (e.g. 'meta-inversion-type')
 * @param {string} text       - Display text
 * @param {string} [field]    - Corpus field name for color lookup (optional)
 * @param {*}      [value]    - Raw value for color lookup (optional)
 * @returns {void}
 */
function setMetaBadge(elementId, text, field, value) {
  var el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = text;
  // Remove any existing badge color class
  el.className = el.className.replace(/\bbadge-\w+\b/g, '').trim();
  if (field && value !== undefined) {
    var cls = getBadgeClass(field, value);
    if (cls) el.classList.add(cls);
  }
}

/**
 * Updates the topbar progress bar fill width, label, and stat pills
 * to reflect the current sessionProgress state.
 * Called after every navigation, write, skip, or flag action.
 *
 * @returns {void}
 */
function updateProgress() {
  if (!sessionProgress) return;

  var completed = (sessionProgress.completed_cases || []).length;
  var pct       = (completed / 3200) * 100;

  var fill  = document.getElementById('progress-bar-fill');
  var label = document.getElementById('progress-label');
  if (fill)  fill.style.width = pct + '%';
  if (label) label.textContent = completed.toLocaleString() + ' / 3,200 cases';

  var pairs   = document.getElementById('stat-pairs');
  var skipped = document.getElementById('stat-skipped');
  var flagged = document.getElementById('stat-flagged');

  var p = sessionProgress.pairs_written || 0;
  var s = sessionProgress.skipped       || 0;
  var f = sessionProgress.flagged       || 0;

  if (pairs)   pairs.textContent   = p + (p === 1 ? ' pair'    : ' pairs');
  if (skipped) skipped.textContent = s + (s === 1 ? ' skipped' : ' skipped');
  if (flagged) flagged.textContent = f + (f === 1 ? ' flagged' : ' flagged');
}

/**
 * Loads a corpus case by case_number and populates all UI regions:
 *   - Sidebar metadata rows and entity cards
 *   - Prompt bar (case identifier label + prompt text)
 *   - Prompt bar inline badges (inversion type, subtlety, intensity)
 *   - Updates currentIndex and sessionProgress.last_case_number
 *   - Updates Prev button enabled state
 *
 * @param {number} caseNumber - The case_number to display
 * @returns {void}
 */
function loadCase(caseNumber) {
  // Cancel any in-flight streams from the previous case before loading new one
  window.electronAPI.cancelStream();

  // Find the case in the corpus array
  var c = corpus.find(function(item) { return item.case_number === caseNumber; });
  if (!c) {
    console.warn('[loadCase] Case #' + caseNumber + ' not found in corpus.');
    return;
  }

  // Update module-level index
  currentIndex = corpus.indexOf(c);

  // ── Sidebar metadata ──────────────────────────────────────────────────────
  setMetaBadge('meta-case-number', String(c.case_number));
  setMetaBadge('meta-vertical',    c.vertical);
  setMetaBadge('meta-inversion-type', c.inversion_type, 'inversion_type', c.inversion_type);
  setMetaBadge('meta-subtlety',    c.subtlety,    'subtlety',    c.subtlety);
  setMetaBadge('meta-severity',    c.inversion_severity, 'inversion_severity', c.inversion_severity);
  setMetaBadge('meta-intensity',   c.appropriate_intensity, 'appropriate_intensity', c.appropriate_intensity);
  setMetaBadge('meta-boundary',    c.boundary_condition ? 'Yes' : 'No',
               'boundary_condition', c.boundary_condition);
  setMetaBadge('meta-identity',    c.identity_language  ? 'Yes' : 'No',
               'identity_language',  c.identity_language);

  // ── Entity cards ──────────────────────────────────────────────────────────
  var entityPerson   = document.getElementById('entity-person');
  var entitySystemic = document.getElementById('entity-systemic');
  var entityNeed     = document.getElementById('entity-need');
  if (entityPerson)   entityPerson.textContent   = c.primary_entity_i          || '—';
  if (entitySystemic) entitySystemic.textContent = c.primary_systemic_element_s || '—';
  if (entityNeed)     entityNeed.textContent     = c.user_underlying_need       || '—';

  // ── Prompt bar ────────────────────────────────────────────────────────────
  var caseIdEl = document.getElementById('prompt-case-id');
  if (caseIdEl) {
    caseIdEl.textContent = 'Case #' + c.case_number + ' — ' + c.vertical;
  }

  var promptTextEl = document.getElementById('prompt-text-box') ||
                     document.getElementById('prompt-text') ||
                     document.getElementById('prompt-bar-text');
  if (promptTextEl) promptTextEl.textContent = c.prompt || '';

  // Prompt bar inline badges
  var badgeType      = document.getElementById('prompt-badge-type');
  var badgeSubtlety  = document.getElementById('prompt-badge-subtlety');
  var badgeIntensity = document.getElementById('prompt-badge-intensity');
  if (badgeType) {
    badgeType.textContent = c.inversion_type;
    badgeType.className   = badgeType.className.replace(/\bbadge-\w+\b/g, '').trim();
    badgeType.classList.add(getBadgeClass('inversion_type', c.inversion_type));
  }
  if (badgeSubtlety) {
    badgeSubtlety.textContent = c.subtlety;
    badgeSubtlety.className   = badgeSubtlety.className.replace(/\bbadge-\w+\b/g, '').trim();
    badgeSubtlety.classList.add(getBadgeClass('subtlety', c.subtlety));
  }
  if (badgeIntensity) {
    badgeIntensity.textContent = c.appropriate_intensity;
    badgeIntensity.className   = badgeIntensity.className.replace(/\bbadge-\w+\b/g, '').trim();
    badgeIntensity.classList.add(getBadgeClass('appropriate_intensity', c.appropriate_intensity));
  }

  // ── Session state ─────────────────────────────────────────────────────────
  if (sessionProgress) {
    sessionProgress.last_case_number = c.case_number;
    saveSession();
  }

  // ── Navigation button state ───────────────────────────────────────────────
  updateNavButtons();
  updateProgress();

  // Step 6: Auto-generate both panels when a new case loads (spec Section 7.6)
  // Set intensity selector default from case data before firing VAI call
  var intensitySelect = document.getElementById('vai-intensity-select');
  if (intensitySelect && c.appropriate_intensity) {
    intensitySelect.value = c.appropriate_intensity;
  }
  generateStandard('std-0');
  generateVai('vai-0');
}

/**
 * Returns the corpus subset matching the active vertical and inversion type
 * filters. If no filters are active, returns the full corpus array.
 *
 * @returns {object[]} Filtered array of case objects
 */
function getFilteredCorpus() {
  return corpus.filter(function(c) {
    var vertOk = !activeVertical      || c.vertical       === activeVertical;
    var typeOk = !activeInversionType || c.inversion_type === activeInversionType;
    return vertOk && typeOk;
  });
}

/**
 * Updates enabled/disabled state of Prev and Next buttons.
 * Prev disabled when current case is first in the filtered set.
 * Next always enabled — queue endpoint handles end-of-corpus.
 *
 * @returns {void}
 */
function updateNavButtons() {
  var btnPrev = document.getElementById('btn-prev');
  var btnNext = document.getElementById('btn-next');
  if (!btnPrev || !btnNext) return;

  var filtered = getFilteredCorpus();
  var currentCase = corpus[currentIndex];
  var pos = filtered.findIndex(function(c) {
    return c.case_number === (currentCase || {}).case_number;
  });

  btnPrev.disabled = (pos <= 0);
  btnNext.disabled = false;
}

/**
 * Wires Prev, Next, and Jump # navigation buttons.
 * Prev: walks backward in filtered corpus (no API call).
 * Next: calls queue:next API for next unworked case.
 * Jump: opens inline modal for direct case number entry.
 *
 * @returns {void}
 */
function initNavigation() {
  var btnPrev = document.getElementById('btn-prev');
  var btnNext = document.getElementById('btn-next');
  var btnJump = document.getElementById('btn-jump');

  if (btnPrev) {
    btnPrev.addEventListener('click', function() {
      var filtered    = getFilteredCorpus();
      var currentCase = corpus[currentIndex];
      var pos = filtered.findIndex(function(c) {
        return c.case_number === (currentCase || {}).case_number;
      });
      if (pos > 0) loadCase(filtered[pos - 1].case_number);
    });
  }

  if (btnNext) {
    btnNext.addEventListener('click', async function() {
      btnNext.disabled    = true;
      btnNext.textContent = 'Loading…';
      try {
        var result = await window.electronAPI.queueNext(
          CURRENT_USER_ID,
          activeVertical      || 'all',
          activeInversionType || 'all'
        );
        if (result.success && result.case_number) {
          loadCase(result.case_number);
        } else {
          console.warn('[nav] queue:next returned no case:', result.error);
        }
      } catch (err) {
        console.error('[nav] Next failed:', err.message);
      } finally {
        btnNext.textContent = 'Next ▶';
        updateNavButtons();
      }
    });
  }

  if (btnJump) {
    btnJump.addEventListener('click', function() { showJumpModal(); });
  }
}

/**
 * Shows the Jump to Case # inline modal.
 * Validates the entered number against the loaded corpus.
 * Navigates on Enter or Go; dismisses on Escape or Cancel.
 *
 * @returns {void}
 */
function showJumpModal() {
  var existing = document.getElementById('jump-modal');
  if (existing) existing.remove();

  var modal = document.createElement('div');
  modal.id = 'jump-modal';
  modal.className = 'dialog-overlay visible';
  modal.innerHTML = [
    '<div class="dialog-card" style="width:280px;">',
    '  <h2 style="margin-bottom:10px;">Jump to Case #</h2>',
    '  <input type="number" id="jump-input" min="1" max="3200"',
    '         placeholder="Enter case number…"',
    '         style="width:100%;box-sizing:border-box;padding:6px 8px;',
    '                font-size:13px;border:1px solid var(--border);',
    '                border-radius:4px;background:var(--bg-secondary);" />',
    '  <div id="jump-error" style="color:var(--error,#c00);font-size:11px;',
    '       min-height:16px;margin-top:4px;"></div>',
    '  <div class="dialog-btn-row" style="margin-top:12px;">',
    '    <button class="btn-dialog-secondary" id="btn-jump-cancel">Cancel</button>',
    '    <button class="btn-dialog-primary"   id="btn-jump-go">Go</button>',
    '  </div>',
    '</div>'
  ].join('');
  document.body.appendChild(modal);

  var input     = document.getElementById('jump-input');
  var errorEl   = document.getElementById('jump-error');
  var btnGo     = document.getElementById('btn-jump-go');
  var btnCancel = document.getElementById('btn-jump-cancel');

  setTimeout(function() { input && input.focus(); }, 50);

  function tryJump() {
    var num   = parseInt(input.value, 10);
    var found = corpus.find(function(c) { return c.case_number === num; });
    if (!found) {
      errorEl.textContent = 'Case #' + num + ' not found.';
      return;
    }
    modal.remove();
    loadCase(num);
  }

  btnGo.addEventListener('click', tryJump);
  btnCancel.addEventListener('click', function() { modal.remove(); });
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter')  tryJump();
    if (e.key === 'Escape') modal.remove();
  });
}

/**
 * Wires the vertical and inversion type filter dropdowns.
 * Updates active filter state and refreshes nav button state
 * without navigating away from the current case.
 *
 * @returns {void}
 */
function initFilters() {
  var vertSelect = document.getElementById('filter-vertical');
  var typeSelect = document.getElementById('filter-inversion');

  if (vertSelect) {
    vertSelect.addEventListener('change', function() {
      activeVertical = vertSelect.value;
      updateNavButtons();
    });
  }

  if (typeSelect) {
    typeSelect.addEventListener('change', function() {
      activeInversionType = typeSelect.value;
      updateNavButtons();
    });
  }
}

// ─── Step 6: Response generation ──────────────────────────────────────────────

/**
 * Loads API keys from config via IPC. Stores in module-level apiKeys.
 * Called once at startup before any generation attempt.
 * @returns {Promise<void>}
 */
async function initApiKeys() {
  try {
    apiKeys = await window.electronAPI.readApiKeys();
  } catch (err) {
    console.error('[apiKeys] Failed to load:', err.message);
  }
}

/**
 * Returns the appropriate API key for a given model ID.
 * Infers provider from model ID prefix.
 *
 * @param {string} modelId - Model ID string
 * @returns {string} API key, or empty string if not configured
 */
function getApiKeyForModel(modelId) {
  if (modelId.startsWith('claude-'))  return apiKeys.anthropic  || '';
  if (modelId.startsWith('gpt-'))     return apiKeys.openai      || '';
  return apiKeys.together_ai || ''; // Together AI (Llama, Mixtral, etc.)
}

/**
 * Clears a panel body and resets its slot state in preparation
 * for a new generation. Shows the placeholder text while empty.
 *
 * @param {string} bodyElementId - DOM ID of the panel body element
 * @param {string} slotId        - Slot state key
 * @returns {void}
 */
function clearPanelSlot(bodyElementId, slotId) {
  var body = document.getElementById(bodyElementId);
  if (body) {
    body.innerHTML = '<div class="response-placeholder">Generating…</div>';
  }
  slotState.set(slotId, { streaming: true, fullText: '' });
}

/**
 * Appends a streamed token chunk to the correct panel body.
 * On first chunk, replaces the placeholder div with a text container.
 * Subsequent chunks append directly to the text container.
 *
 * @param {string} bodyElementId - DOM ID of the panel body element
 * @param {string} chunk         - Token text to append
 * @returns {void}
 */
function appendChunk(bodyElementId, chunk) {
  var body = document.getElementById(bodyElementId);
  if (!body) return;

  // Replace placeholder on first real chunk
  var placeholder = body.querySelector('.response-placeholder');
  if (placeholder) {
    body.innerHTML = '<div class="response-text"></div>';
  }

  var textEl = body.querySelector('.response-text');
  if (textEl) {
    // Append text — preserve whitespace and newlines
    textEl.textContent += chunk;
    // Auto-scroll to bottom as tokens arrive
    body.scrollTop = body.scrollHeight;
  }
}

/**
 * Fires a Standard panel generation call.
 * Reads the current model and variant from the panel dropdowns.
 * Uses the current corpus case's vertical and prompt text.
 * Clears the panel body and streams tokens in as they arrive.
 *
 * @param {string} [slotId='std-0'] - Panel slot identifier
 * @returns {Promise<void>}
 */
async function generateStandard(slotId) {
  slotId = slotId || 'std-0';

  var currentCase = corpus[currentIndex];
  if (!currentCase) {
    console.warn('[gen] No current case — cannot generate.');
    return;
  }

  var modelSelect   = document.getElementById('std-model-select');
  var variantSelect = document.getElementById('std-variant-select');
  var model         = modelSelect   ? modelSelect.value   : 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8';
  var variantId     = variantSelect ? variantSelect.value : 'A';
  var apiKey        = getApiKeyForModel(model);

  if (!apiKey) {
    var body = document.getElementById('std-panel-body');
    if (body) {
      body.innerHTML = '<div class="response-error">⚠ No API key configured. Open ⚙ settings to add your Together AI key.</div>';
    }
    return;
  }

  clearPanelSlot('std-panel-body', slotId);

  try {
    await window.electronAPI.generateStandard({
      prompt:    currentCase.prompt,
      vertical:  currentCase.vertical,
      variantId: variantId,
      model:     model,
      slotId:    slotId,
      apiKey:    apiKey
    });
  } catch (err) {
    console.error('[gen] generateStandard failed:', err.message);
  }
}

/**
 * Fires a VAI panel generation call.
 * Reads current model and intensity from the panel dropdowns.
 * Appends the axiological context block in main.js from caseData.
 *
 * @param {string} [slotId='vai-0'] - Panel slot identifier
 * @returns {Promise<void>}
 */
async function generateVai(slotId) {
  slotId = slotId || 'vai-0';

  var currentCase = corpus[currentIndex];
  if (!currentCase) return;

  var modelSelect     = document.getElementById('vai-model-select');
  var intensitySelect = document.getElementById('vai-intensity-select');
  var model           = modelSelect     ? modelSelect.value     : 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8';
  var intensity       = intensitySelect ? intensitySelect.value : currentCase.appropriate_intensity || 'Balanced';
  var apiKey          = getApiKeyForModel(model);

  if (!apiKey) {
    var body = document.getElementById('vai-panel-body');
    if (body) {
      body.innerHTML = '<div class="response-error">⚠ No API key configured. Open ⚙ settings to add your Together AI key.</div>';
    }
    return;
  }

  clearPanelSlot('vai-panel-body', slotId);

  try {
    await window.electronAPI.generateVai({
      prompt:    currentCase.prompt,
      caseData:  currentCase,
      intensity: intensity,
      model:     model,
      slotId:    slotId,
      apiKey:    apiKey
    });
  } catch (err) {
    console.error('[gen] generateVai failed:', err.message);
  }
}

/**
 * Registers the three IPC stream event listeners (chunk, done, error).
 * Called once at startup. Routes incoming events to the correct panel
 * body by matching slotId to the known body element IDs.
 *
 * slotId → bodyElementId mapping:
 *   'std-0' → 'std-panel-body'
 *   'vai-0' → 'vai-panel-body'
 *   (additional slots added in Step 11)
 *
 * @returns {void}
 */
function initStreamListeners() {
  /**
   * Maps a slotId to its panel body element ID.
   * @param {string} slotId
   * @returns {string}
   */
  function bodyIdForSlot(slotId) {
    if (slotId.startsWith('std')) return 'std-panel-body';
    if (slotId.startsWith('vai')) return 'vai-panel-body';
    return slotId; // fallback — caller passed bodyId directly
  }

  window.electronAPI.onLlmChunk(function(data) {
    var state = slotState.get(data.slotId);
    if (state) {
      state.fullText += data.content;
    }
    appendChunk(bodyIdForSlot(data.slotId), data.content);
  });

  window.electronAPI.onLlmDone(function(data) {
    var state = slotState.get(data.slotId);
    if (state) {
      state.streaming = false;
      state.fullText  = data.fullText;
    }
    console.log('[stream] ' + data.slotId + ' done in ' + data.elapsed + 's');

    // Render markdown after stream completes — snap plain text to formatted HTML
    if (data.fullText) {
      var bodyId = data.slotId.startsWith('std') ? 'std-panel-body' : 'vai-panel-body';
      var body   = document.getElementById(bodyId);
      if (body) {
        window.electronAPI.renderMarkdown(data.fullText).then(function(html) {
          // Wrap in response-text div to preserve panel body styles
          body.innerHTML = '<div class="response-text markdown-body">' +
                           html + '</div>';
        });
      }
    }

    // TODO Step 7: enable role pills once generation is complete
  });

  window.electronAPI.onLlmError(function(data) {
    var body = document.getElementById(bodyIdForSlot(data.slotId));
    if (body) {
      body.innerHTML = '<div class="response-error">⚠ ' +
                       (data.error || 'Generation failed.') + '</div>';
    }
    var state = slotState.get(data.slotId);
    if (state) state.streaming = false;
    console.error('[stream] Error on ' + data.slotId + ':', data.error);
  });
}

/**
 * Wires the Regen buttons for Standard and VAI panels.
 * Each button re-fires the generation for that panel's primary slot.
 * Also wires the intensity selector to default from the current case
 * appropriate_intensity field when a new case loads.
 *
 * @returns {void}
 */
function initRegenButtons() {
  var btnRegenStd = document.getElementById('btn-regen-std');
  var btnRegenVai = document.getElementById('btn-regen-vai');

  if (btnRegenStd) {
    btnRegenStd.addEventListener('click', function() {
      generateStandard('std-0');
    });
  }

  if (btnRegenVai) {
    btnRegenVai.addEventListener('click', function() {
      generateVai('vai-0');
    });
  }
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
  }).then(async function() {
    // Step 4: Apply layout and wire interactions
    initLayoutPresets();
    initDragHandles();
    initModeChips();
    initChipRows();
    initFontSizeControls();
    initSettingsModal();

    // Step 6: Init API keys and stream listeners
    await initApiKeys();
    initStreamListeners();
    initRegenButtons();

    // Step 5: Case display and navigation
    initNavigation();
    initFilters();
    var startCase = (sessionProgress && sessionProgress.last_case_number) || 1;
    loadCase(startCase);
    updateProgress();
    // TODO Step 8: wire flag defaults from case data
    // TODO Step 9: wire Write Pair enabled state
    // TODO Step 12: register keyboard shortcuts
  });
});
