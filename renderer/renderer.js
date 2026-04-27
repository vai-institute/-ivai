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
let CURRENT_USER_ID = '';  // Populated dynamically from JWT at DOMContentLoaded

/** Loaded API keys from config. Populated by initApiKeys(). @type {Object} */
let apiKeys = { together_ai: '', openai: '', anthropic: '', google: '' };
/** Whether initApiKeys() has completed at least once. */
let _apiKeysReady = false;

/**
 * Tracks streaming state for each panel slot.
 * Key: slotId (e.g. 'std-0', 'vai-0')
 * Value: { streaming: boolean, fullText: string }
 * @type {Map<string, Object>}
 */
const slotState = new Map();

/**
 * Tracks which slot holds the preferred response.
 * null = none selected. Value is slotId e.g. 'vai-0'.
 * @type {string|null}
 */
let preferredSlotId = null;

/**
 * Tracks which slot holds the non-preferred response.
 * null = none selected. Value is slotId e.g. 'std-0'.
 * @type {string|null}
 */
let nonPreferredSlotId = null;

/**
 * Whether the VAI panel body is currently in edit mode.
 * Set to true when CVA clicks Edit. Cleared on navigation or regen.
 * @type {boolean}
 */
let vaiEditMode = false;

/**
 * Whether the current VAI response was edited by the CVA.
 * Forces Cortex validation before Write Pair is enabled.
 * @type {boolean}
 */
let vaiWasEdited = false;

/**
 * Last Cortex validation result for the current VAI response.
 * null = not yet run. Reset on navigation, regen, or new edit.
 * @type {Object|null}
 */
let cortexResult = null;

/**
 * Quill editor instance for VAI panel WYSIWYG editing.
 * Initialized once on first Edit activation.
 * @type {Quill|null}
 */
let quillEditor = null;

/** Stores the original (unedited) prompt for the current case */
let originalPrompt = '';

/**
 * Case number fetched via queue:next that is currently in _in_flight on the
 * backend. Set when queue:next returns a case; cleared after a successful
 * write/skip/flag. If the CVA navigates away without acting, loadCase()
 * releases this case back to the queue.
 * @type {string|null}
 */
let currentQueuedCaseId = null;

/**
 * True when the backend queue returns no more unworked cases.
 * Keeps the Next button disabled with "Queue empty" label until filters
 * change or a manual case load resets it.
 * @type {boolean}
 */
let queueExhausted = false;

/**
 * Number of DPO pairs written for the current case in this session.
 * Reset to 0 on case navigation. Incremented by Write Pair / Write Additional.
 * Sent as pair_index in the payload.
 * @type {number}
 */
let currentCasePairCount = 0;

/**
 * turndown service instance for HTML → markdown conversion.
 * Initialized once at startup.
 * @type {TurndownService|null}
 */
let turndownService = null;

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

// ─── Auth helpers ────────────────────────────────────────────────────────────────────────────

/**
 * Called whenever an IPC result carries a 401 / expired-token error.
 * Shows a modal and asks main process to return to the login screen.
 */
function handleSessionExpired() {
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:99999;font-family:sans-serif';
  overlay.innerHTML = '<div style="background:#242424;border:1px solid #555;border-radius:8px;padding:28px 32px;text-align:center;color:#e0e0e0;max-width:340px;">'
    + '<div style="font-size:15px;font-weight:600;margin-bottom:8px;">Session Expired</div>'
    + '<div style="font-size:13px;color:#aaa;margin-bottom:20px;">Your session has expired. Please sign in again.</div>'
    + '<button id="btn-relogin" style="background:#1565c0;border:none;border-radius:6px;color:#fff;font-size:13px;font-weight:600;padding:9px 24px;cursor:pointer;">Sign In</button>'
    + '</div>';
  document.body.appendChild(overlay);
  document.getElementById('btn-relogin').addEventListener('click', function() {
    window.electronAPI.logout();
  });
}

/**
 * Inspect an IPC result for a 401 / auth error; call handleSessionExpired()
 * and return true if found. Usage: if (checkAuth(result)) return;
 * @param {Object} result
 * @returns {boolean}
 */
function checkAuth(result) {
  if (!result) return false;
  var msg = (result.error || '').toLowerCase();
  if (result.status === 401 || msg.indexOf('token invalid') !== -1
      || msg.indexOf('expired') !== -1 || msg.indexOf('please log in') !== -1) {
    handleSessionExpired();
    return true;
  }
  return false;
}

/**
 * Fetches the full corpus from the Railway API via the main process, stores cases in `corpus`.
 * @returns {Promise<void>}
 */
async function loadCorpus() {
  try {
    var result = await window.electronAPI.loadCorpus();
    if (checkAuth(result)) return;
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
  // v1.9.0 — Auto-resume. The Resume/Start Fresh dialog was removed
  // because counters are now derived server-side from COUNT(*) on pairs/
  // skips/flags (counter truth), so "Start Fresh" no longer has anything
  // meaningful to reset. On launch we always read the session and resume.
  try {
    var result = await window.electronAPI.readSession(CURRENT_USER_ID);
    if (checkAuth(result)) return;

    if (!result.success || !result.session) {
      // No session on server yet — use in-memory defaults. POST /session
      // will UPSERT on first write.
      sessionProgress = {
        last_case_id:    '',
        pairs_written:   0,
        pairs_train:     0,
        pairs_holdout:   0,
        skipped:         0,
        flagged:         0,
        session_start:   new Date().toISOString(),
        last_updated:    new Date().toISOString(),
        completed_cases: [],
        layout_preset:   'wide',
        review_mode:     'staged',
        std_variant:     '0'
      };
      console.log('[session] First launch — fresh in-memory session.');
      return;
    }

    sessionProgress = result.session;
    console.log('[session] Resuming at case ' + (result.session.last_case_id || '(none)') +
                '. ' + result.session.pairs_written + ' pair(s) written.');
  } catch (err) {
    console.error('[session] initSession failed:', err.message);
  }
}

// Placeholder kept so any stray call-site (should be none after v1.9.0)
// still exits cleanly instead of throwing. The resume dialog is gone.
function showResumeDialog() {
  // v1.9.0: the resume dialog was removed. This stub is retained only so
  // stray call sites (there should be none) exit cleanly instead of
  // throwing. The Promise resolves immediately.
  return Promise.resolve();
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
    document.getElementById('key-google').value    = keys.google || '';

    // Populate Cortex selectors from stored config
    var cortexEndpointSelect = document.getElementById('cortex-endpoint-select');
    var cortexModelSelect    = document.getElementById('cortex-model-select');
    if (cortexEndpointSelect && keys.cortex_endpoint) {
      cortexEndpointSelect.value = keys.cortex_endpoint;
    }
    if (cortexModelSelect && keys.cortex_model) {
      cortexModelSelect.value = keys.cortex_model;
    }
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

  var cortexEndpointSelect = document.getElementById('cortex-endpoint-select');
  var cortexModelSelect    = document.getElementById('cortex-model-select');
  var cortexEndpoint = cortexEndpointSelect
                     ? cortexEndpointSelect.value : 'railway';
  var cortexModel    = cortexModelSelect
                     ? cortexModelSelect.value
                     : 'mistralai/Mistral-7B-Instruct-v0.2';

  var keys = {
    together_ai:     document.getElementById('key-together').value.trim(),
    openai:          document.getElementById('key-openai').value.trim(),
    anthropic:       document.getElementById('key-anthropic').value.trim(),
    google:          document.getElementById('key-google').value.trim(),
    cortex_endpoint: cortexEndpoint,
    cortex_model:    cortexModel
  };

  if (saveBtn) saveBtn.disabled = true;

  try {
    var result = await window.electronAPI.writeApiKeys(keys);
    if (result.ok) {
      // Refresh all keys in memory from disk
      await initApiKeys();
      statusEl.textContent = '✓ Settings saved to config/api_keys.json';
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
  // Restart button
  var restartBtn = document.getElementById('btn-restart');
  if (restartBtn) {
    restartBtn.addEventListener('click', function() {
      window.electronAPI.restartApp();
    });
  }

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

  // Restore saved std-variant (default '0' for new CVAs)
  var variantSel = document.getElementById('std-variant-select');
  if (variantSel) {
    variantSel.value = (sessionProgress && sessionProgress.std_variant) || '0';
  }

  // Persist variant selection across sessions
  if (variantSel) {
    variantSel.addEventListener('change', function() {
      if (sessionProgress) {
        sessionProgress.std_variant = variantSel.value;
        saveSession();
      }
    });
  }
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
      // Step 8: confidence selection gates Write Pair
      updateWritePairEnabled();
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

// ─── Step 8: Right Rail Curation Defaults ─────────────────────────────────────

/**
 * Sets right rail curation controls to their default values based on the
 * current case's metadata. Called from loadCase() on every case navigation.
 *
 * Default logic (spec Section 9):
 *   - Pause-and-Ask toggle: ON if appropriate_intensity is Balanced or Direct
 *   - Identity Declaration toggle: matches identity_language field from corpus
 *   - Response Mode: Boundary/Silent if boundary_condition true;
 *       Humanizing if intensity=Light AND subtlety=Subtle; else Standard VAI
 *   - Confidence chips: cleared (CVA must select before Write Pair enables)
 *   - Dataset Split: defaults to Train
 *   - Preferred editor + hint line: cleared (fresh for new case)
 *   - CVA notes: cleared
 *   - Split ratio note: updated from session progress
 *
 * @param {object} caseData - Corpus case object with metadata fields
 * @returns {void}
 */
function setCurationDefaults(caseData) {
  // ── Protocol flags (spec Section 9.2) ──────────────────────────────────────

  // Pause-and-Ask: ON when intensity is Balanced or Direct
  var flagPna = document.getElementById('flag-pna');
  if (flagPna) {
    var intensity = caseData.appropriate_intensity || '';
    flagPna.checked = (intensity === 'Balanced' || intensity === 'Direct');
  }

  // Identity Declaration: matches identity_language field from case
  var flagIdentity = document.getElementById('flag-identity');
  if (flagIdentity) {
    flagIdentity.checked = !!caseData.identity_language;
  }

  // ── Response mode chips (spec Section 9.3) ─────────────────────────────────

  var modeChips = document.querySelectorAll('.mode-chip');
  var defaultMode = 'standard-vai';

  if (caseData.boundary_condition === true) {
    // Boundary condition cases always use Boundary / Silent mode
    defaultMode = 'boundary';
  } else if (caseData.appropriate_intensity === 'Light' &&
             caseData.subtlety === 'Subtle') {
    // Light intensity + Subtle subtlety → Humanizing pipeline
    defaultMode = 'humanizing';
  }

  modeChips.forEach(function(chip) {
    if (chip.getAttribute('data-mode') === defaultMode) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });

  // ── Confidence rating (spec Section 9.5) ───────────────────────────────────
  // Clear all — CVA must explicitly select before Write Pair enables
  document.querySelectorAll('[data-confidence]').forEach(function(chip) {
    chip.classList.remove('active');
  });

  // ── Dataset split (spec Section 9.6) ───────────────────────────────────────
  // Default to Train
  document.querySelectorAll('[data-split]').forEach(function(chip) {
    if (chip.getAttribute('data-split') === 'train') {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });

  // Update split ratio note from session progress
  var splitNote = document.getElementById('split-note');
  if (splitNote && sessionProgress) {
    var t = sessionProgress.pairs_train   || 0;
    var h = sessionProgress.pairs_holdout || 0;
    var total = t + h;
    var pctTrain   = total > 0 ? Math.round((t / total) * 100) : 0;
    var pctHoldout = total > 0 ? Math.round((h / total) * 100) : 0;
    splitNote.textContent = 'Current split: ' + t + ' train / ' + h +
      ' held-out (' + pctTrain + '% / ' + pctHoldout + '%)';
  }

  // ── Preferred editor + hint (spec Section 9.4) ─────────────────────────────
  // Cleared by clearRoleSelections() in loadCase(), but ensure clean state
  var editor   = document.getElementById('preferred-editor');
  var hintLine = document.getElementById('hint-line');
  if (editor)   editor.value = '';
  if (hintLine) hintLine.textContent = '';

  // ── CVA notes (spec Section 9.7) ───────────────────────────────────────────
  var cvaNotes = document.getElementById('cva-notes');
  if (cvaNotes) cvaNotes.value = '';

  // ── Clear validation hint ──────────────────────────────────────────────────
  showValidationHint('');
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
 * Loads a corpus case by case_id and populates all UI regions:
 *   - Sidebar metadata rows and entity cards
 *   - Prompt bar (case identifier label + prompt text)
 *   - Prompt bar inline badges (inversion type, subtlety, intensity)
 *   - Updates currentIndex and sessionProgress.last_case_id
 *   - Updates Prev button enabled state
 *
 * @param {number} caseId - The case_id to display
 * @returns {void}
 */
function loadCase(caseId) {
  // Cancel any in-flight streams from the previous case before loading new one
  window.electronAPI.cancelStream();

  // BUG 1 fix: Release prior queued case back to the queue if the CVA
  // navigated away without writing, skipping, or flagging it.
  if (currentQueuedCaseId !== null && currentQueuedCaseId !== caseId) {
    window.electronAPI.queueRelease(currentQueuedCaseId);
    currentQueuedCaseId = null;
  }

  // BUG 2 fix: Clear slotState before any UI reset so getSlotText() cannot
  // return stale text from the prior case.
  slotState.delete('std-0');
  slotState.delete('vai-0');

  // Reset pair count for the new case
  currentCasePairCount = 0;

  // Clear response panels so stale responses don't persist between cases
  var stdBody = document.getElementById('std-panel-body');
  var vaiBody = document.getElementById('vai-panel-body');
  if (stdBody) stdBody.innerHTML = '';
  if (vaiBody) vaiBody.innerHTML = '';

  // Reset role selections when navigating to a new case
  clearRoleSelections();

  // Reset VAI edit state on navigation
  exitVaiEditMode();
  vaiWasEdited = false;
  cortexResult = null;
  var cortexPopup = document.getElementById('cortex-popup');
  if (cortexPopup) cortexPopup.remove();

  // Find the case in the corpus array
  var c = corpus.find(function(item) { return item.case_id === caseId; });
  if (!c) {
    console.warn('[loadCase] Case ' + caseId + ' not found in corpus.');
    return;
  }

  // Update module-level index
  currentIndex = corpus.indexOf(c);

  // ── Sidebar metadata ──────────────────────────────────────────────────────
  setMetaBadge('meta-case-id', c.case_id);
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
    caseIdEl.textContent = 'Case ' + c.case_id + ' — ' + c.vertical;
  }

  // Populate the editable prompt textarea and store original for reset
  originalPrompt = c.prompt || '';
  var promptTextarea = document.getElementById('prompt-textarea');
  if (promptTextarea) promptTextarea.value = originalPrompt;

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
    sessionProgress.last_case_id = c.case_id;
    saveSession();
  }

  // ── Navigation button state ───────────────────────────────────────────────
  updateNavButtons();
  updateProgress();

  // Step 8: Set right rail curation defaults from case metadata
  setCurationDefaults(c);

  // Set intensity selector default from case data
  var intensitySelect = document.getElementById('vai-intensity-select');
  if (intensitySelect && c.appropriate_intensity) {
    intensitySelect.value = c.appropriate_intensity;
  }

  // Show case status banner and adjust Write Pair label
  updateCaseStatusBanner(c.case_id);

  // Reset variant selector to session sticky before restoring case record
  // (restoreCaseRecord will override this if the case has a historical wrapper_mode)
  var _variantSel = document.getElementById('std-variant-select');
  if (_variantSel && sessionProgress) {
    _variantSel.value = sessionProgress.std_variant || '0';
  }

  // Restore prior response state if case was already actioned
  restoreCaseRecord(c.case_id);
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
 * Next disabled when the queue is exhausted (no unworked cases remain).
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
    return c.case_id === (currentCase || {}).case_id;
  });

  btnPrev.disabled = (pos <= 0);
  // v1.13.0: Next is simply corpus[pos+1] — disable at the last case.
  btnNext.disabled    = (pos < 0 || pos >= filtered.length - 1);
  btnNext.textContent = 'Next ▶';
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
        return c.case_id === (currentCase || {}).case_id;
      });
      if (pos > 0) loadCase(filtered[pos - 1].case_id);
    });
  }

  if (btnNext) {
    // v1.13.0: Next = corpus[currentIndex + 1] in the filtered view.
    // Simple sequential navigation — no queue API call.
    btnNext.addEventListener('click', function() {
      var filtered    = getFilteredCorpus();
      var currentCase = corpus[currentIndex];
      var pos = filtered.findIndex(function(c) {
        return c.case_id === (currentCase || {}).case_id;
      });
      if (pos >= 0 && pos < filtered.length - 1) {
        loadCase(filtered[pos + 1].case_id);
      }
    });
  }

  if (btnJump) {
    btnJump.addEventListener('click', function() { showJumpModal(); });
  }
}

/**
 * Shows the Jump to Case ID inline modal.
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
    '<div class="dialog-card" style="width:320px;">',
    '  <h2 style="margin-bottom:10px;">Jump to Case ID</h2>',
    '  <input type="text" id="jump-input" maxlength="12"',
    '         placeholder="YYMMDD-NNNNN (e.g. 260314-00050)"',
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
    var raw = (input.value || '').trim();
    // Accept bare 1..99999 as shorthand and promote to seed-batch case_id.
    if (/^\d+$/.test(raw)) {
      var n = parseInt(raw, 10);
      if (n >= 1 && n <= 99999) {
        raw = '260314-' + String(n).padStart(5, '0');
      }
    }
    if (!/^\d{6}-\d{5}$/.test(raw)) {
      errorEl.textContent = 'Enter a case ID like 260314-00050.';
      return;
    }
    var found = corpus.find(function(c) { return c.case_id === raw; });
    if (!found) {
      errorEl.textContent = 'Case ' + raw + ' not found.';
      return;
    }
    modal.remove();
    loadCase(raw);
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
      queueExhausted = false;
      updateNavButtons();
    });
  }

  if (typeSelect) {
    typeSelect.addEventListener('change', function() {
      activeInversionType = typeSelect.value;
      queueExhausted = false;
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
    _apiKeysReady = true;
  } catch (err) {
    console.error('[apiKeys] Failed to load:', err.message);
  }
}

/**
 * Initializes the turndown HTML-to-markdown converter.
 * Configured to match the constrained Quill toolbar format set:
 * bold, italic, ordered list, bullet list, paragraph only.
 * Called once at startup.
 *
 * @returns {void}
 */
function initTurndown() {
  if (typeof TurndownService === 'undefined') {
    console.warn('[turndown] TurndownService not available.');
    return;
  }
  turndownService = new TurndownService({
    headingStyle:   'atx',
    bulletListMarker: '-',
    strongDelimiter: '**',
    emDelimiter:    '_'
  });
  console.log('[turndown] Initialized.');
}

/**
 * Initializes the Quill WYSIWYG editor with a constrained toolbar.
 * Allowed formats: bold, italic, ordered list, bullet list only.
 * Called on first Edit activation — lazy initialization.
 *
 * The toolbar maps directly to meaningful DPO training data formats:
 *   Bold    → **emphasis** on key person-centered phrases
 *   Italic  → _subtle emphasis_ or titles
 *   Bullet  → unordered list for multiple considerations
 *   Ordered → numbered steps when sequence matters
 *
 * No headers, no links, no color, no font size — WLYSIWLYCD.
 *
 * @returns {Quill|null} The initialized Quill instance, or null on failure
 */
function initQuillEditor() {
  if (typeof Quill === 'undefined') {
    console.warn('[quill] Quill not available.');
    return null;
  }
  if (quillEditor) return quillEditor; // already initialized

  quillEditor = new Quill('#vai-quill-editor', {
    theme: 'snow',
    modules: {
      toolbar: '#vai-quill-toolbar'  // use custom toolbar element from HTML
    },
    formats: ['bold', 'italic', 'list', 'background'], // background needed for highlights
    placeholder: 'Edit the VAI response here…'
  });

  // Track edits — any change marks response as edited
  quillEditor.on('text-change', function() {
    if (!vaiWasEdited) {
      vaiWasEdited = true;
      cortexResult = null;
      updateWritePairEnabled();
    }
  });

  // Wire axiological highlight buttons (I / E / S)
  var highlightI = document.querySelector('.ql-highlight-i');
  var highlightE = document.querySelector('.ql-highlight-e');
  var highlightS = document.querySelector('.ql-highlight-s');

  if (highlightI) highlightI.addEventListener('click', function() {
    applyHighlight('#b7f7c2', quillEditor);
  });
  if (highlightE) highlightE.addEventListener('click', function() {
    applyHighlight('#ffe0b2', quillEditor);
  });
  if (highlightS) highlightS.addEventListener('click', function() {
    applyHighlight('#e0e0e0', quillEditor);
  });

  console.log('[quill] Editor initialized with axiological highlight buttons.');
  return quillEditor;
}

/**
 * Wires the three axiological highlight buttons to Quill's
 * background format. Colors map to the I>E>S hierarchy:
 *   Intrinsic  = #b7f7c2  (light green)  — person at risk
 *   Extrinsic  = #ffe0b2  (light orange) — function/role
 *   Systemic   = #e0e0e0  (gray)         — rule/policy
 *
 * Highlights are CVA annotation only. They are stripped by
 * stripHighlights() before any training data write.
 *
 * @param {string} color - Quill background color hex string
 * @param {Quill} quill  - the Quill editor instance
 */
function applyHighlight(color, quill) {
  var range = quill.getSelection();
  if (!range || range.length === 0) return;
  var currentFormat = quill.getFormat(range);
  // Toggle: if same color already applied, remove it
  var newColor = currentFormat.background === color ? false : color;
  quill.formatText(range.index, range.length, 'background', newColor);
}

/**
 * Strips all Quill background-color spans from HTML before
 * markdown conversion. Highlights are CVA annotation only and
 * must never appear in DPO training data output.
 *
 * Quill renders background color as:
 *   <span style="background-color: #b7f7c2;">text</span>
 * This function unwraps those spans, preserving the inner text
 * and any other inline formatting.
 *
 * @param {string} html - raw HTML from Quill editor
 * @returns {string}    - HTML with all background-color spans unwrapped
 */
function stripHighlights(html) {
  var parser = new DOMParser();
  var doc = parser.parseFromString(html, 'text/html');
  doc.querySelectorAll('span[style*="background-color"]').forEach(function(span) {
    span.replaceWith.apply(span, Array.from(span.childNodes));
  });
  return doc.body.innerHTML;
}

/**
 * Returns the appropriate API key for a given model ID.
 * Looks up the provider field in AVAILABLE_MODELS from prompts.js,
 * then returns the corresponding key from the apiKeys config.
 *
 * @param {string} modelId - Model ID string
 * @returns {string} API key, or empty string if not configured
 */
function getApiKeyForModel(modelId) {
  // Find provider from AVAILABLE_MODELS list populated in the model dropdowns
  var select = document.getElementById('std-model-select');
  var option = select ? select.querySelector('option[value="' + modelId + '"]') : null;
  var provider = option ? option.getAttribute('data-provider') : '';

  if (provider === 'anthropic') return apiKeys.anthropic   || '';
  if (provider === 'openai')    return apiKeys.openai       || '';
  if (provider === 'google')    return apiKeys.google       || '';
  return apiKeys.together_ai || '';
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

  if (!_apiKeysReady) {
    var body = document.getElementById('std-panel-body');
    if (body) body.innerHTML = '<div class="response-error">Initializing…</div>';
    return;
  }

  var currentCase = corpus[currentIndex];
  if (!currentCase) {
    console.warn('[gen] No current case — cannot generate.');
    return;
  }

  var modelSelect   = document.getElementById('std-model-select');
  var variantSelect = document.getElementById('std-variant-select');
  var model         = modelSelect   ? modelSelect.value   : 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
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

  // Read prompt from the live textarea (may have been edited by the user)
  var prompt = (document.getElementById('prompt-textarea') || {}).value || currentCase.prompt;
  prompt = prompt.trim();

  var stdOpt = document.querySelector('#std-model-select option[value="' + model + '"]');
  var provider = stdOpt ? stdOpt.getAttribute('data-provider') : 'together';
  console.log('[gen] Standard panel → provider: ' + provider + ', model: ' + model);

  try {
    await window.electronAPI.generateStandard({
      prompt:    prompt,
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

  if (!_apiKeysReady) {
    var body = document.getElementById('vai-panel-body');
    if (body) body.innerHTML = '<div class="response-error">Initializing…</div>';
    return;
  }

  // Reset edit state on regeneration
  exitVaiEditMode();
  vaiWasEdited = false;
  cortexResult = null;
  var cortexPopup = document.getElementById('cortex-popup');
  if (cortexPopup) cortexPopup.remove();

  // Regen clears Preferred selection — response is new
  if (preferredSlotId === 'vai-0') {
    preferredSlotId = null;
    var prefPill = document.getElementById('pill-vai-pref');
    if (prefPill) prefPill.classList.remove('active-pref');
    var editor = document.getElementById('preferred-editor');
    if (editor) editor.value = '';
    updateWritePairEnabled();
  }

  var currentCase = corpus[currentIndex];
  if (!currentCase) return;

  var modelSelect     = document.getElementById('vai-model-select');
  var intensitySelect = document.getElementById('vai-intensity-select');
  var model           = modelSelect     ? modelSelect.value     : 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
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

  // Read prompt from the live textarea (may have been edited by the user)
  var prompt = (document.getElementById('prompt-textarea') || {}).value || currentCase.prompt;
  prompt = prompt.trim();

  // Derive provider from the active dropdown option's data-provider attribute
  var vaiSelect   = document.getElementById('vai-model-select');
  var vaiSelected = vaiSelect ? vaiSelect.options[vaiSelect.selectedIndex] : null;
  var provider    = vaiSelected ? (vaiSelected.getAttribute('data-provider') || 'together') : 'together';
  var providerLabel = { together: 'Together AI', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google' }[provider] || provider;
  console.log('[gen] VAI panel → provider: ' + providerLabel + ', model: ' + model);

  try {
    await window.electronAPI.generateVai({
      prompt:    prompt,
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
      // Detect model-unavailable errors and show amber warning instead of red error
      var err = data.error || 'Generation failed.';
      if (err.indexOf('MODEL_UNAVAILABLE:') === 0) {
        var parts   = err.split(':');
        var modelId = parts[1] || 'unknown';
        body.innerHTML = '<div class="response-error" style="border-color:var(--amber,#e8a735);color:var(--amber,#e8a735);">' +
          '⚠ Model <strong>' + modelId + '</strong> is currently unavailable. ' +
          'Select a different model in the panel header and regenerate.</div>';
      } else {
        body.innerHTML = '<div class="response-error">⚠ ' + err + '</div>';
      }
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

  // Wire the prompt reset button
  var btnResetPrompt = document.getElementById('btn-reset-prompt');
  if (btnResetPrompt) {
    btnResetPrompt.addEventListener('click', function() {
      var ta = document.getElementById('prompt-textarea');
      if (ta) ta.value = originalPrompt;
    });
  }

  // Wire the Submit button — fires both Standard and VAI generation
  var btnSubmit = document.getElementById('btn-submit-prompt');
  if (btnSubmit) {
    btnSubmit.addEventListener('click', function() {
      generateStandard('std-0');
      generateVai('vai-0');
    });
  }

  // Wire model selector change → enforce training eligibility
  var stdModelSelect = document.getElementById('std-model-select');
  var vaiModelSelect = document.getElementById('vai-model-select');
  if (stdModelSelect) {
    stdModelSelect.addEventListener('change', function() {
      console.log('[model] Standard panel → ' + stdModelSelect.value);
      enforceTrainingEligibility('standard', stdModelSelect.value);
    });
  }
  if (vaiModelSelect) {
    vaiModelSelect.addEventListener('change', function() {
      console.log('[model] VAI panel → ' + vaiModelSelect.value);
      enforceTrainingEligibility('vai', vaiModelSelect.value);
    });
  }
}

// ─── Exploration mode enforcement ─────────────────────────────────────────────
// Models that are NOT training-eligible.  Keyed by model ID.
// Outputs from these models must NEVER enter DPO training data.
var EXPLORATION_MODELS = {
  'gpt-5.4': true,
  'gpt-5.4-mini': true,
  'claude-opus-4-6': true,
  'claude-sonnet-4-6': true,
  'gemini-2.5-pro': true
};

/**
 * Disables role pills, Write Pair button, and Write Additional Pair button
 * for the given panel when the selected model is not training-eligible.
 * Exploration-only models (OpenAI, Anthropic) must never produce DPO training data.
 * @param {string} panelId - 'standard' or 'vai'
 * @param {string} modelId - model ID string
 */
function enforceTrainingEligibility(panelId, modelId) {
  var panel = document.getElementById('panel-' + panelId);
  if (!panel) return;

  var isExploration = !!EXPLORATION_MODELS[modelId];

  if (isExploration) {
    panel.classList.add('exploration-mode');
    // Add banner if not already present
    if (!panel.querySelector('.exploration-banner')) {
      var banner = document.createElement('div');
      banner.className = 'exploration-banner';
      banner.textContent = '\u26A0 Exploration only \u2014 outputs cannot be used as training data';
      var hdr = panel.querySelector('.panel-hdr');
      if (hdr && hdr.nextSibling) {
        hdr.parentNode.insertBefore(banner, hdr.nextSibling);
      }
    }
  } else {
    panel.classList.remove('exploration-mode');
    var existingBanner = panel.querySelector('.exploration-banner');
    if (existingBanner) existingBanner.remove();
  }

  // Disable Write Pair if EITHER panel is exploration-mode
  var stdExploration = document.getElementById('panel-standard')
                        && document.getElementById('panel-standard').classList.contains('exploration-mode');
  var vaiExploration = document.getElementById('panel-vai')
                        && document.getElementById('panel-vai').classList.contains('exploration-mode');
  var btnWritePair   = document.getElementById('btn-write-pair');
  var btnWriteAdd    = document.getElementById('btn-write-additional');

  if (stdExploration || vaiExploration) {
    if (btnWritePair) btnWritePair.disabled = true;
    if (btnWriteAdd)  btnWriteAdd.disabled  = true;
  } else {
    // Re-enable via normal logic
    updateWritePairEnabled();
  }
}

// ─── Step 7: Role selection ───────────────────────────────────────────────────

/**
 * Clears all active role pill selections visually and resets
 * role state variables. Called before applying a new selection
 * to enforce mutual exclusivity across all panels and slots.
 *
 * @returns {void}
 */
function clearRoleSelections() {
  // Remove active class from all role pills
  document.querySelectorAll('.pill-role').forEach(function(pill) {
    pill.classList.remove('active-pref', 'active-nonpref');
  });
  preferredSlotId    = null;
  nonPreferredSlotId = null;

  // Clear preferred editor and hint line
  var editor   = document.getElementById('preferred-editor');
  var hintLine = document.getElementById('hint-line');
  if (editor)   editor.value = '';
  if (hintLine) hintLine.textContent = '';

  // Disable Write Pair — requires both roles assigned
  updateWritePairEnabled();
}

/**
 * Returns the current full text content of a panel slot.
 * Reads from slotState if available (authoritative after stream),
 * falling back to the panel body's textContent.
 *
 * @param {string} slotId - Slot identifier ('std-0' or 'vai-0')
 * @returns {string} Full response text, or empty string if not generated
 */
function getSlotText(slotId) {
  var state = slotState.get(slotId);
  if (state && state.fullText) return state.fullText;

  // Fallback: read from DOM (handles edge cases where slotState is stale)
  var bodyId = slotId.startsWith('std') ? 'std-panel-body' : 'vai-panel-body';
  var body   = document.getElementById(bodyId);
  if (!body) return '';
  var textEl = body.querySelector('.response-text');
  return textEl ? textEl.textContent : '';
}

/**
 * Enables or disables the Write Pair button based on multiple gates:
 *   1. Neither panel in exploration mode (non-eligible model)
 *   2. Both preferred and non-preferred slots assigned to different slots
 *   3. Confidence chip selected (Step 8)
 *   4. Edited VAI responses validated via Cortex (Step 7B)
 *   5. Override explanation present if Cortex found issues (Step 7B)
 *
 * @returns {void}
 */
function updateWritePairEnabled() {
  var btn    = document.getElementById('btn-write-pair');
  var btnAdd = document.getElementById('btn-write-additional');
  if (!btn) return;

  // Helper: disable both buttons together
  function disableBoth() {
    btn.disabled = true;
    if (btnAdd) btnAdd.disabled = true;
  }

  // Block Write Pair when either panel is in exploration mode
  var stdPanel = document.getElementById('panel-standard');
  var vaiPanel = document.getElementById('panel-vai');
  if ((stdPanel && stdPanel.classList.contains('exploration-mode')) ||
      (vaiPanel && vaiPanel.classList.contains('exploration-mode'))) {
    disableBoth();
    return;
  }

  var bothAssigned = preferredSlotId    !== null &&
                     nonPreferredSlotId !== null &&
                     preferredSlotId    !== nonPreferredSlotId;

  if (!bothAssigned) {
    disableBoth();
    return;
  }

  // Step 8: Require a confidence chip selection before enabling Write Pair
  var hasConfidence = document.querySelector('[data-confidence].active') !== null;
  if (!hasConfidence) {
    disableBoth();
    showValidationHint('Select a confidence rating before writing.');
    return;
  }

  // If VAI was edited, require validation before enabling Write Pair
  if (vaiWasEdited && cortexResult === null) {
    disableBoth();
    showValidationHint('Edited response requires VAI validation. Click ⟳ Test to proceed.');
    return;
  }

  // Edited VAI with Cortex issues: block Write Pair entirely.
  // CVA must use Flag for Review to submit for human review, or Skip.
  if (vaiWasEdited && cortexResult && cortexResult.has_issues) {
    disableBoth();
    showValidationHint('Cortex detected an inversion in your edited response. Use ⚑ Flag for Review to submit for human review, or Skip.');
    updateFlagButtonLabel();
    return;
  }

  btn.disabled = false;
  if (btnAdd) btnAdd.disabled = false;
  showValidationHint('');
  updateFlagButtonLabel();
}

/**
 * Shows a validation hint message above the Write Pair button.
 * @param {string} message - Hint text. Empty string clears the hint.
 * @returns {void}
 */
function showValidationHint(message) {
  var el = document.getElementById('validation-error');
  if (el) el.textContent = message;
}

/**
 * Handles selection of a response slot as Preferred.
 * - Clears any existing role selections
 * - Marks the pill active
 * - Copies the slot's text into the preferred-editor textarea
 * - Sets the Pause-and-Ask hint if the flag is active
 * - Updates Write Pair enabled state
 *
 * Only VAI slots can be marked Preferred (Standard is non-preferred only).
 * This is enforced by only wiring this handler to VAI pills.
 *
 * @param {string} slotId - The slot being marked as preferred ('vai-0')
 * @returns {void}
 */
function onPreferredSelected(slotId) {
  // If VAI is in edit mode, flush Quill content to slotState before exiting
  // so getSlotText() returns the edited text, not the original.
  if (vaiEditMode) {
    var editedText = getVaiPanelText();
    if (editedText) {
      var state = slotState.get('vai-0');
      if (state) state.fullText = editedText;
      vaiWasEdited = true;
    }
    exitVaiEditMode();
    // Re-render the panel body with edited text so the user sees their
    // changes — exitVaiEditMode() shows the original panel body HTML.
    if (editedText) {
      var vaiBody = document.getElementById('vai-panel-body');
      if (vaiBody && typeof marked !== 'undefined') {
        vaiBody.innerHTML = '<div class="response-text markdown-body">' +
                            marked.parse(editedText) + '</div>';
      }
    }
  }

  // If this slot is already preferred, clicking again deselects it
  if (preferredSlotId === slotId) {
    preferredSlotId = null;
    var pill = document.getElementById('pill-' +
               (slotId.startsWith('vai') ? 'vai' : 'std') + '-pref');
    if (pill) pill.classList.remove('active-pref');
    var editor = document.getElementById('preferred-editor');
    if (editor) editor.value = '';
    updateWritePairEnabled();
    return;
  }

  // Clear previous selections first
  clearRoleSelections();

  preferredSlotId = slotId;

  // Auto-assign the opposite panel as Non-preferred
  var oppositeSlotId = slotId.startsWith('vai') ? 'std-0' : 'vai-0';
  nonPreferredSlotId = oppositeSlotId;
  var nonPrefPillId  = oppositeSlotId.startsWith('std') ? 'pill-std-nonpref' : 'pill-vai-nonpref';
  var nonPrefPill    = document.getElementById(nonPrefPillId);
  if (nonPrefPill) nonPrefPill.classList.add('active-nonpref');

  // Mark the correct pill active
  var pillId = slotId.startsWith('vai') ? 'pill-vai-pref' : 'pill-std-pref';
  var pill   = document.getElementById(pillId);
  if (pill) pill.classList.add('active-pref');

  // Copy slot text into preferred editor
  var text   = getSlotText(slotId);
  var editor = document.getElementById('preferred-editor');
  if (editor) editor.value = text;

  // Set Pause-and-Ask hint if flag is active
  var pnaCheckbox = document.getElementById('flag-pna');
  var hintLine    = document.getElementById('hint-line');
  if (hintLine) {
    hintLine.textContent = (pnaCheckbox && pnaCheckbox.checked)
      ? 'P&A active — preferred response must pause and ask before proceeding.'
      : '';
  }

  updateWritePairEnabled();

  // Auto-fire Cortex review when CVA marks a response as Preferred.
  // This ensures every preferred selection gets axiological validation
  // without requiring a manual Test click.
  var currentCase = corpus[currentIndex];
  if (currentCase && text) {
    fireCortexReview({
      prompt:   (document.getElementById('prompt-textarea') || {}).value || '',
      response: text,
      caseData: currentCase
    });
  }
}

/**
 * Handles selection of a response slot as Non-preferred.
 * - If this slot is already non-preferred, deselects it
 * - Otherwise clears existing selections and marks the slot
 * - Updates Write Pair enabled state
 *
 * Both Standard and VAI slots can be marked Non-preferred.
 *
 * @param {string} slotId - The slot being marked as non-preferred
 * @returns {void}
 */
function onNonPreferredSelected(slotId) {
  // Toggle off if already selected
  if (nonPreferredSlotId === slotId) {
    nonPreferredSlotId = null;
    var pillId = slotId.startsWith('std') ? 'pill-std-nonpref' : 'pill-vai-nonpref';
    var pill   = document.getElementById(pillId);
    if (pill) pill.classList.remove('active-nonpref');
    updateWritePairEnabled();
    return;
  }

  // Clear all first, then re-apply preferred if one was set
  var savedPreferred = preferredSlotId;
  clearRoleSelections();

  // Restore preferred selection if it existed
  if (savedPreferred) {
    preferredSlotId = savedPreferred;
    var prefPillId = savedPreferred.startsWith('vai')
                   ? 'pill-vai-pref' : 'pill-std-pref';
    var prefPill   = document.getElementById(prefPillId);
    if (prefPill) prefPill.classList.add('active-pref');

    // Restore preferred editor text
    var editor = document.getElementById('preferred-editor');
    if (editor) editor.value = getSlotText(savedPreferred);
  }

  nonPreferredSlotId = slotId;

  var nonPrefPillId = slotId.startsWith('std') ? 'pill-std-nonpref' : 'pill-vai-nonpref';
  var nonPrefPill   = document.getElementById(nonPrefPillId);
  if (nonPrefPill) nonPrefPill.classList.add('active-nonpref');

  updateWritePairEnabled();
}

/**
 * Wires all role selection pills to their handlers.
 * Standard panel: Non-preferred pill only.
 * VAI panel: both Preferred and Non-preferred pills.
 * Also resets role state when a new case loads (called from loadCase).
 *
 * @returns {void}
 */
function initRolePills() {
  // Standard panel — non-preferred only
  var pillStdNonpref = document.getElementById('pill-std-nonpref');
  if (pillStdNonpref) {
    pillStdNonpref.addEventListener('click', function() {
      onNonPreferredSelected('std-0');
    });
  }

  // VAI panel — non-preferred
  var pillVaiNonpref = document.getElementById('pill-vai-nonpref');
  if (pillVaiNonpref) {
    pillVaiNonpref.addEventListener('click', function() {
      onNonPreferredSelected('vai-0');
    });
  }

  // VAI panel — preferred
  var pillVaiPref = document.getElementById('pill-vai-pref');
  if (pillVaiPref) {
    pillVaiPref.addEventListener('click', function() {
      onPreferredSelected('vai-0');
    });
  }
}

// Cortex auto-fires on Preferred selection (see onPreferredSelected line 1946)
// and is also available via the manual Test button (pill-vai-test).

// ─── Step 7B: Edit, Test, and Cortex validation ──────────────────────────────

/**
 * Activates inline editing on the VAI panel body.
 * Makes the response-text div contenteditable.
 * Adds amber border to signal edit mode.
 * Wires input event to set vaiWasEdited and clear cortexResult.
 * Edit mode persists until navigation or regeneration.
 *
 * @returns {void}
 */
function enterVaiEditMode() {
  // Mutual exclusivity — clear Preferred if active
  if (preferredSlotId === 'vai-0') {
    preferredSlotId = null;
    var prefPill = document.getElementById('pill-vai-pref');
    if (prefPill) prefPill.classList.remove('active-pref');
    var editor = document.getElementById('preferred-editor');
    if (editor) editor.value = '';
    updateWritePairEnabled();
  }

  var body          = document.getElementById('vai-panel-body');
  var quillContainer = document.getElementById('vai-quill-container');
  var editBtn       = document.getElementById('pill-vai-edit');

  if (!body || !quillContainer) return;

  // Initialize Quill on first use
  var qe = initQuillEditor();
  if (!qe) return;

  // Get current response text from slotState (markdown)
  var currentText = getSlotText('vai-0');

  // Convert markdown to HTML for Quill display.
  // marked.parse() is available via window.electronAPI.renderMarkdown
  // which uses marked v4 (synchronous in this context).
  // We use the global marked object loaded via script tag instead
  // for synchronous access inside the editor init.
  var html = '';
  try {
    // marked is loaded as a global via node_modules script tag
    if (typeof marked !== 'undefined') {
      html = marked.parse(currentText);
    } else {
      // Fallback: wrap plain text in a paragraph
      html = '<p>' + currentText.replace(/\n\n/g, '</p><p>') + '</p>';
    }
  } catch(e) {
    html = '<p>' + currentText + '</p>';
  }

  // Load HTML into Quill — renders formatted content immediately
  qe.clipboard.dangerouslyPasteHTML(html);

  // Hide rendered panel body, show Quill container
  body.style.display          = 'none';
  quillContainer.style.display = 'flex';
  quillContainer.style.flexDirection = 'column';
  quillContainer.style.flex   = '1';
  quillContainer.style.minHeight = '0';

  // Visual indicator
  if (editBtn) editBtn.classList.add('active-edit');

  vaiEditMode = true;

  // Focus the editor
  setTimeout(function() { qe.focus(); }, 50);
}

/**
 * Exits VAI edit mode. Called on navigation or regeneration.
 * Does NOT save or revert — content stays as edited.
 *
 * @returns {void}
 */
function exitVaiEditMode() {
  var body           = document.getElementById('vai-panel-body');
  var quillContainer = document.getElementById('vai-quill-container');
  var editBtn        = document.getElementById('pill-vai-edit');

  if (body)           body.style.display           = '';
  if (quillContainer) quillContainer.style.display = 'none';
  if (editBtn)        editBtn.classList.remove('active-edit');

  vaiEditMode = false;
}

/**
 * Returns the current text content of the VAI panel body.
 * When in edit mode, reads from the contenteditable element
 * (which may differ from slotState if the CVA has made edits).
 * Falls back to slotState when not in edit mode.
 *
 * @returns {string} Current VAI panel text
 */
function getVaiPanelText() {
  if (quillEditor) {
    // Get HTML from Quill and convert to markdown
    var html = quillEditor.root.innerHTML;
    // Empty editor check
    if (html === '<p><br></p>' || html === '<p></p>') {
      return getSlotText('vai-0');
    }
    if (turndownService) {
      // Strip axiological highlights before markdown conversion —
      // highlights are CVA annotation only, never training data
      var strippedHtml = stripHighlights(html);
      return turndownService.turndown(strippedHtml);
    }
    // Fallback: return plain text if turndown unavailable
    return quillEditor.getText().trim();
  }
  return getSlotText('vai-0');
}

/**
 * Fires an axiological Cortex review for a given prompt/response pair.
 * Called automatically when the CVA marks a response as Preferred.
 * Posts to the Railway API at POST /review with the response text and case metadata.
 * Displays the result in the Cortex popup overlaid on the Standard panel.
 * @param {object} payload - { prompt: string, response: string, caseData: object }
 * @returns {Promise<void>}
 */
async function fireCortexReview(payload) {
  var testBtn = document.getElementById('pill-vai-test');

  // Show loading state
  if (testBtn) {
    testBtn.disabled    = true;
    testBtn.textContent = '⟳ Reviewing…';
  }

  // Show loading indicator in existing popup location
  showCortexPopup({ loading: true });

  try {
    var raw = await window.electronAPI.runCortexReview({
      text:     payload.response,
      caseData: payload.caseData
    });

    // Detect model-unavailable before normalizing — show amber warning
    if (raw.error === 'model_unavailable') {
      showCortexPopup({
        model_unavailable: true,
        model:   raw.model   || 'unknown',
        message: raw.message || 'Model is currently unavailable.'
      });
      return;
    }

    // Normalize API response shape
    var result = {
      has_issues:  raw.clean === false,
      flags:       raw.issues       || [],
      suggestions: raw.suggestions  || [],
      confidence:  raw.confidence   || 'Low',
      summary:     raw.summary      || '',
      error:       raw.error        || null
    };

    cortexResult = result;
    updateWritePairEnabled();
    showCortexPopup(result);

  } catch (err) {
    console.error('[cortex] Auto-review failed:', err.message);
    // Show inline error with retry button
    showCortexPopup({
      error: err.message,
      retryPayload: payload
    });
  } finally {
    if (testBtn) {
      testBtn.disabled    = false;
      testBtn.textContent = '⟳ Test';
    }
  }
}

/**
 * Runs Cortex validation on the current VAI panel text.
 * Calls the Railway /review endpoint via IPC.
 * Stores result in cortexResult.
 * Shows the result popup overlaid on the Standard panel.
 *
 * @returns {Promise<void>}
 */
async function runCortexValidation() {
  // Capture edited text BEFORE exiting edit mode —
  // getVaiPanelText() reads from Quill which is only
  // available while edit mode is active.
  var editedText = vaiEditMode ? getVaiPanelText() : null;

  // Test puts panel in neutral review state —
  // clear Edit mode and Preferred selection first
  if (vaiEditMode) {
    // Update slotState with edited content before exiting
    // so getVaiPanelText() returns correct text after exit
    if (editedText) {
      var state = slotState.get('vai-0');
      if (state) state.fullText = editedText;

      // Re-render the panel body with the edited markdown
      var body = document.getElementById('vai-panel-body');
      if (body && typeof marked !== 'undefined') {
        body.innerHTML = '<div class="response-text markdown-body">' +
                         marked.parse(editedText) +
                         '</div>';
      }
    }
    exitVaiEditMode();
  }

  if (preferredSlotId === 'vai-0') {
    preferredSlotId = null;
    var prefPill = document.getElementById('pill-vai-pref');
    if (prefPill) prefPill.classList.remove('active-pref');
    updateWritePairEnabled();
  }

  var testBtn  = document.getElementById('pill-vai-test');
  var text     = getVaiPanelText();
  var currentCase = corpus[currentIndex];

  if (!text || !currentCase) {
    showCortexPopup({ error: 'No response text to validate.' });
    return;
  }

  // Show loading state on Test button
  if (testBtn) {
    testBtn.disabled    = true;
    testBtn.textContent = '⟳ Testing…';
  }

  try {
    var raw = await window.electronAPI.runCortexReview({
      text:     text,
      caseData: currentCase
    });

    // Detect model-unavailable before normalizing
    if (raw.error === 'model_unavailable') {
      showCortexPopup({
        model_unavailable: true,
        model:   raw.model   || 'unknown',
        message: raw.message || 'Model is currently unavailable.'
      });
      return;
    }

    // Normalize API response shape to internal shape.
    // API returns { clean, issues, suggestions, confidence, summary }
    // Renderer uses { has_issues, flags, suggestions, confidence, summary }
    var result = {
      has_issues:  raw.clean === false,
      flags:       raw.issues       || [],
      suggestions: raw.suggestions  || [],
      confidence:  raw.confidence   || 'Low',
      summary:     raw.summary      || '',
      error:       raw.error        || null
    };

    cortexResult = result;
    updateWritePairEnabled();
    showCortexPopup(result);

  } catch (err) {
    console.error('[cortex] Validation failed:', err.message);
    showCortexPopup({ error: err.message });
  } finally {
    if (testBtn) {
      testBtn.disabled    = false;
      testBtn.textContent = '⟳ Test';
    }
  }
}

/**
 * Displays the Cortex validation result as a popup overlaid
 * on the Standard panel (left panel area).
 * Shows clean result or issues list.
 * If issues found and response was edited, shows override
 * explanation field.
 *
 * @param {Object} result - Cortex analysis result from Railway API
 * @returns {void}
 */
function showCortexPopup(result) {
  // Remove existing popup if present
  var existing = document.getElementById('cortex-popup');
  if (existing) existing.remove();

  // Build popup content
  var contentHtml;

  if (result.loading) {
    contentHtml = '<div class="cortex-loading" style="text-align:center;padding:16px;">' +
                  '<span style="font-size:18px;">⟳</span> Reviewing…</div>';

  } else if (result.model_unavailable) {
    // Amber/warning style — temporary service issue, not a system failure
    contentHtml = '<div class="cortex-error" style="border-color:var(--amber,#e8a735);' +
      'color:var(--amber,#e8a735);background:rgba(232,167,53,0.08);">' +
      '⚠ <strong>' + (result.model || 'Model') + '</strong> is currently unavailable on Together AI.<br>' +
      '<span style="font-size:11px;">Select a different Cortex model in ⚙ Settings and retry.</span></div>';

  } else if (result.error) {
    contentHtml = '<div class="cortex-error">⚠ ' + result.error;
    if (result.retryPayload) {
      contentHtml += ' <button id="btn-cortex-retry" class="btn-ghost btn-xs" ' +
                     'style="margin-left:8px;">↺ Retry</button>';
    }
    contentHtml += '</div>';

  } else if (!result.has_issues) {
    contentHtml = [
      '<div class="cortex-clean">',
      '  <span class="cortex-icon">✓</span>',
      '  <strong>VAI validation passed</strong>',
      '  <p>No value inversions detected in the preferred response.</p>',
      '</div>'
    ].join('');

  } else {
    // Issues found — show flags and optional override field
var flagsHtml = (result.flags || []).map(function(f) {
  if (typeof f === 'object' && f !== null) {
    var sevClass = f.severity === 'Severe' ? 'badge-red'
                 : f.severity === 'Moderate' ? 'badge-amber' : 'badge-green';
    var html = '<li>';
    html += '<strong>' + (f.inversion_type || '') + '</strong> ';
    html += (f.description || '') + ' ';
    if (f.severity) html += '<span class="' + sevClass + '">' + f.severity + '</span>';
    if (f.location) html += '<br><em style="font-size:11px;color:var(--text-muted,#888)">↳ "' + f.location + '"</em>';
    html += '</li>';
    return html;
  }
  return '<li>' + f + '</li>';
}).join('');

    // When edited VAI has Cortex issues, show guidance instead of override field.
    // Write Pair is blocked — CVA must use Flag for Review or Skip.
    var overrideHtml = vaiWasEdited
      ? '<div class="cortex-override" style="font-size:12px;color:var(--amber,#e8a735);margin-top:8px;">' +
        '⚠ Write Pair is blocked. Use <strong>⚑ Flag for Review</strong> to submit for human review, or <strong>Skip</strong>.' +
        '</div>'
      : '';

    var suggestionsHtml = (result.suggestions || []).length > 0
      ? '<div style="margin-top:8px;font-size:12px;">' +
        '<strong>Suggestions:</strong><ul>' +
        result.suggestions.map(function(s) { return '<li>' + s + '</li>'; }).join('') +
        '</ul></div>'
      : '';

    contentHtml = [
      '<div class="cortex-issues">',
      '  <span class="cortex-icon cortex-warn">⚠</span>',
      '  <strong>VAI validation — issues found</strong>',
      '  <ul>' + flagsHtml + '</ul>',
      suggestionsHtml,
      overrideHtml,
      '</div>'
    ].join('');
  }

  // Build popup element — anchored inside the VAI panel
  var popup = document.createElement('div');
  popup.id = 'cortex-popup';

  // Apply result-state border class
  popup.classList.remove('cortex-pass', 'cortex-fail');
  if (!result.loading && !result.error) {
    popup.classList.add(result.has_issues ? 'cortex-fail' : 'cortex-pass');
  }

  popup.innerHTML = [
    '<div class="cortex-popup-inner">',
    '  <div class="cortex-popup-header">',
    '    <span>VAI Cortex Analysis</span>',
    '    <button id="btn-cortex-close" title="Close">✕</button>',
    '  </div>',
    '  <div class="cortex-popup-body">' + contentHtml + '</div>',
    '</div>'
  ].join('');

  // Insert popup into body — uses position:fixed to center over Standard panel
  document.body.appendChild(popup);

  // Wire close button
  var closeBtn = document.getElementById('btn-cortex-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', function() {
      popup.remove();
    });
  }

  // Wire retry button (shown on Cortex call failure)
  var retryBtn = document.getElementById('btn-cortex-retry');
  if (retryBtn && result.retryPayload) {
    retryBtn.addEventListener('click', function() {
      fireCortexReview(result.retryPayload);
    });
  }

  // Wire override textarea to updateWritePairEnabled on input
  var overrideEl = document.getElementById('override-explanation');
  if (overrideEl) {
    overrideEl.addEventListener('input', function() {
      updateWritePairEnabled();
    });
  }
}

/**
 * Wires the Edit and Test pills in the VAI panel footer.
 *
 * Edit: toggles contenteditable on VAI panel body.
 *   Once activated stays on until navigation or regen.
 * Test: fires Cortex validation on current VAI panel text.
 *   Available at any time.
 *
 * @returns {void}
 */
function initEditTestPills() {
  var editBtn = document.getElementById('pill-vai-edit');
  var testBtn = document.getElementById('pill-vai-test');

  if (editBtn) {
    editBtn.addEventListener('click', function() {
      if (!vaiEditMode) {
        enterVaiEditMode();
      }
      // Once in edit mode, clicking again has no effect —
      // edit persists until navigation or regen
    });
  }

  if (testBtn) {
    testBtn.addEventListener('click', function() {
      runCortexValidation();
    });
  }
}

// ─── Step 8: Action Buttons (Write Pair, Write Additional, Skip, Flag) ───────

/**
 * Advances to the next queued case after a successful write/skip/flag.
 * Mirrors the Next button's queue:next call but without the Loading… label.
 * @returns {Promise<void>}
 */
async function advanceToNextQueuedCase() {
  try {
    var result = await window.electronAPI.queueNext(
      CURRENT_USER_ID,
      activeVertical      || 'all',
      activeInversionType || 'all'
    );
    if (checkAuth(result)) return;
    if (result.success && result.case && result.case.case_id) {
      queueExhausted = false;
      currentQueuedCaseId = result.case.case_id;
      loadCase(result.case.case_id);
    } else if (result.success && !result.case) {
      queueExhausted = true;
      updateNavButtons();
    }
  } catch (err) {
    console.error('[advance] Next queued case failed:', err.message);
  }
}

/**
 * Assembles the full DPO pair payload from the current case, right rail
 * curation controls, slot metadata, and response text.
 *
 * @returns {Object} Payload matching the PairSubmission schema on the backend
 */
function assemblePairPayload() {
  var c = corpus[currentIndex];

  // ── Right rail curation state ─────────────────────────────────────────────
  var flagPna      = document.getElementById('flag-pna');
  var flagIdentity = document.getElementById('flag-identity');
  var activeMode   = document.querySelector('.mode-chip.active');
  var activeConf   = document.querySelector('[data-confidence].active');
  var activeSplit  = document.querySelector('[data-split].active');
  var overrideEl   = document.getElementById('override-explanation');
  var cvaNotes     = document.getElementById('cva-notes');

  // ── Slot metadata ─────────────────────────────────────────────────────────
  var stdModelSel  = document.getElementById('std-model-select');
  var stdVariant   = document.getElementById('std-variant-select');
  var vaiModelSel  = document.getElementById('vai-model-select');
  var vaiIntensity = document.getElementById('vai-intensity-select');

  var stdOpt = stdModelSel ? stdModelSel.options[stdModelSel.selectedIndex] : null;
  var vaiOpt = vaiModelSel ? vaiModelSel.options[vaiModelSel.selectedIndex] : null;

  return {
    // Case metadata (from corpus)
    case_id:           c.case_id,
    vertical:              c.vertical,
    inversion_type:        c.inversion_type,
    subtlety:              c.subtlety,
    boundary_condition:    c.boundary_condition,
    inversion_severity:    c.inversion_severity,
    appropriate_intensity: c.appropriate_intensity,
    identity_language:     c.identity_language,
    data_classification:   c.data_classification || 'general',
    // ferpa_consent: not yet in corpus — defaults to false on backend

    // Curation controls
    cva_flags: {
      pause_and_ask:        flagPna      ? flagPna.checked        : false,
      identity_declaration: flagIdentity ? flagIdentity.checked   : false,
      response_mode:        activeMode   ? activeMode.getAttribute('data-mode')         : 'standard-vai',
      confidence:           activeConf   ? activeConf.getAttribute('data-confidence')   : null,
      cortex_result:        cortexResult,
      vai_was_edited:       vaiWasEdited,
      override_explanation: overrideEl   ? overrideEl.value.trim() : ''
    },
    cva_notes:     cvaNotes ? cvaNotes.value.trim() : '',
    dataset_split: activeSplit ? activeSplit.getAttribute('data-split') : 'train',
    pair_index:    currentCasePairCount,

    // Slot metadata
    wrapper_mode: stdVariant ? stdVariant.value : 'A',
    standard_slot: {
      model:    stdModelSel ? stdModelSel.value : '',
      provider: stdOpt      ? (stdOpt.getAttribute('data-provider') || '') : '',
      variant:  stdVariant  ? stdVariant.value  : 'A',
      edited:   false
    },
    vai_slot: {
      model:     vaiModelSel  ? vaiModelSel.value  : '',
      provider:  vaiOpt       ? (vaiOpt.getAttribute('data-provider') || '') : '',
      intensity: vaiIntensity ? vaiIntensity.value  : 'Balanced',
      edited:    vaiWasEdited
    },

    // DPO content
    input: {
      messages: [{
        role:    'user',
        content: (document.getElementById('prompt-textarea') || {}).value || ''
      }]
    },
    preferred_output: [{
      role:    'assistant',
      content: (document.getElementById('preferred-editor') || {}).value || ''
    }],
    non_preferred_output: [{
      role:    'assistant',
      content: getSlotText(nonPreferredSlotId)
    }]
  };
}

/**
 * Validates that all preconditions for writing a pair are met.
 * Returns an error message string, or empty string if valid.
 *
 * @returns {string} Validation error message, or '' if all gates pass
 */
function validateWritePairGates() {
  var c = corpus[currentIndex];
  if (!c) return 'No case loaded.';

  if (!preferredSlotId || !nonPreferredSlotId ||
      preferredSlotId === nonPreferredSlotId) {
    return 'Assign both Preferred and Non-preferred to different responses.';
  }

  var stdPanel = document.getElementById('panel-standard');
  var vaiPanel = document.getElementById('panel-vai');
  if ((stdPanel && stdPanel.classList.contains('exploration-mode')) ||
      (vaiPanel && vaiPanel.classList.contains('exploration-mode'))) {
    return 'Cannot write pairs with exploration-only models.';
  }

  if (!document.querySelector('[data-confidence].active')) {
    return 'Select a confidence rating before writing.';
  }

  if (vaiWasEdited && cortexResult === null) {
    return 'Edited response requires VAI validation. Click ⟳ Test.';
  }

  if (vaiWasEdited && cortexResult && cortexResult.has_issues) {
    return 'Cortex detected an inversion. Use Flag for Review or Skip.';
  }

  var prefText    = (document.getElementById('preferred-editor') || {}).value || '';
  var nonPrefText = getSlotText(nonPreferredSlotId);
  if (!prefText.trim()) return 'Preferred response is empty.';
  if (!nonPrefText.trim()) return 'Non-preferred response is empty.';

  return '';
}

/**
 * Updates the Flag button label based on whether an edited VAI response
 * was flagged by Cortex. In that state the button changes to "Flag for Review"
 * to signal that the pair will land in a review queue, not training data.
 *
 * @returns {void}
 */
function updateFlagButtonLabel() {
  var btnFlag = document.getElementById('btn-flag');
  if (!btnFlag) return;
  if (vaiWasEdited && cortexResult && cortexResult.has_issues) {
    btnFlag.textContent = '⚑ Flag for Review';
  } else {
    btnFlag.textContent = '⚑ Flag for Team Review';
  }
}

// ─── Case record helpers (status indicator + response restore) ────

/**
 * Persists a per-case action record to sessionProgress.case_records.
 * Called after every Write Pair, Skip, or Flag action so navigating
 * back to a completed case can restore its prior state.
 */
function saveCaseRecord(caseId, record) {
  if (!sessionProgress) return;
  if (!sessionProgress.case_records) sessionProgress.case_records = {};
  sessionProgress.case_records[caseId] = record;
  // saveSession() is called by the caller after other bookkeeping
}

/**
 * Updates the case status banner and Write Pair button label.
 */
function updateCaseStatusBanner(caseId) {
  var banner       = document.getElementById('case-status-banner');
  var writePairBtn = document.getElementById('btn-write-pair');
  if (!banner) return;
  var completed = sessionProgress ? (sessionProgress.completed_cases || []) : [];
  var skipped   = sessionProgress ? (sessionProgress.skipped_cases   || []) : [];
  var flagged   = sessionProgress ? (sessionProgress.flagged_cases   || []) : [];
  banner.className = 'case-status-banner';
  if (completed.indexOf(caseId) !== -1) {
    banner.classList.add('status-written');
    banner.textContent = '✓ Pair written — submitting again will replace it';
    if (writePairBtn) writePairBtn.textContent = 'Replace Pair →';
  } else if (skipped.indexOf(caseId) !== -1) {
    banner.classList.add('status-skipped');
    banner.textContent = '○ Previously skipped';
    if (writePairBtn) writePairBtn.textContent = 'Write Pair → DPO';
  } else if (flagged.indexOf(caseId) !== -1) {
    banner.classList.add('status-flagged');
    banner.textContent = '⚑ Previously flagged for review';
    if (writePairBtn) writePairBtn.textContent = 'Write Pair → DPO';
  } else {
    banner.classList.add('status-none');
    banner.textContent = '';
    if (writePairBtn) writePairBtn.textContent = 'Write Pair → DPO';
  }
}

/**
 * Restores prior response state for a case already actioned.
 * Only written cases get full restore; skipped/flagged show banner only.
 */
async function restoreCaseRecord(caseId) {
  if (!sessionProgress || !sessionProgress.case_records) return;
  var rec = sessionProgress.case_records[caseId];
  if (!rec || rec.action !== 'written') return;
  // Restore STD panel
  if (rec.std_text) {
    slotState.set('std-0', { streaming: false, fullText: rec.std_text });
    var stdBody = document.getElementById('std-panel-body');
    if (stdBody) {
      try {
        var stdHtml = await window.electronAPI.renderMarkdown(rec.std_text);
        stdBody.innerHTML = '<div class="response-text markdown-body">' + stdHtml + '</div>';
      } catch (e) {
        stdBody.innerHTML = '<div class="response-text">' + rec.std_text + '</div>';
      }
    }
  }
  // Restore VAI panel
  if (rec.vai_text) {
    slotState.set('vai-0', { streaming: false, fullText: rec.vai_text });
    var vaiBody = document.getElementById('vai-panel-body');
    if (vaiBody) {
      try {
        var vaiHtml = await window.electronAPI.renderMarkdown(rec.vai_text);
        vaiBody.innerHTML = '<div class="response-text markdown-body">' + vaiHtml + '</div>';
      } catch (e) {
        vaiBody.innerHTML = '<div class="response-text">' + rec.vai_text + '</div>';
      }
    }
  }
  // Restore role pills
  if (rec.std_role === 'preferred') {
    preferredSlotId    = 'std-0';
    nonPreferredSlotId = 'vai-0';
    var nonPrefPill = document.getElementById('pill-vai-nonpref');
    if (nonPrefPill) nonPrefPill.classList.add('active-nonpref');
  } else if (rec.vai_role === 'preferred') {
    preferredSlotId    = 'vai-0';
    nonPreferredSlotId = 'std-0';
    var prefPill    = document.getElementById('pill-vai-pref');
    var nonPrefPill = document.getElementById('pill-std-nonpref');
    if (prefPill)    prefPill.classList.add('active-pref');
    if (nonPrefPill) nonPrefPill.classList.add('active-nonpref');
  }
  // Restore preferred editor
  var prefEditor = document.getElementById('preferred-editor');
  if (prefEditor && rec.preferred_text != null) prefEditor.value = rec.preferred_text;
  // Restore CVA notes
  var notesEl = document.getElementById('cva-notes');
  if (notesEl && rec.cva_notes != null) notesEl.value = rec.cva_notes;
  // Restore confidence chip
  if (rec.confidence) {
    document.querySelectorAll('[data-confidence]').forEach(function(chip) {
      chip.classList.toggle('active', chip.getAttribute('data-confidence') === rec.confidence);
    });
  }
  // Restore dataset split chip
  if (rec.dataset_split) {
    document.querySelectorAll('[data-split]').forEach(function(chip) {
      chip.classList.toggle('active', chip.getAttribute('data-split') === rec.dataset_split);
    });
  }
  // Restore variant selector from historical wrapper_mode
  if (rec.wrapper_mode) {
    var _recVariantSel = document.getElementById('std-variant-select');
    if (_recVariantSel) _recVariantSel.value = rec.wrapper_mode;
  }

  // Re-evaluate Write Pair gate
  updateWritePairEnabled();
}

/**
 * Wires all four action buttons in the right rail:
 *   Write Pair, Write Additional Pair, Skip, Flag.
 *
 * @returns {void}
 */
function initActionButtons() {
  var btnWritePair = document.getElementById('btn-write-pair');
  var btnWriteAdd  = document.getElementById('btn-write-additional');
  var btnSkip      = document.getElementById('btn-skip');
  var btnFlag      = document.getElementById('btn-flag');

  // ── Write Pair ────────────────────────────────────────────────────────────
  if (btnWritePair) {
    btnWritePair.addEventListener('click', async function() {
      var error = validateWritePairGates();
      if (error) {
        showValidationHint(error);
        return;
      }

      btnWritePair.disabled    = true;
      btnWritePair.textContent = 'Writing…';

      try {
        var payload = assemblePairPayload();
        var result  = await window.electronAPI.writePair(payload);
        if (checkAuth(result)) return;

        if (result.success) {
          // Update session counters
          sessionProgress.pairs_written = (sessionProgress.pairs_written || 0) + 1;
          if (result.destination === 'holdout') {
            sessionProgress.pairs_holdout = (sessionProgress.pairs_holdout || 0) + 1;
          } else {
            sessionProgress.pairs_train = (sessionProgress.pairs_train || 0) + 1;
          }

          // Mark case completed (only once per case)
          if (!sessionProgress.completed_cases) sessionProgress.completed_cases = [];
          if (sessionProgress.completed_cases.indexOf(payload.case_id) === -1) {
            sessionProgress.completed_cases.push(payload.case_id);
          }

          currentCasePairCount++;
          currentQueuedCaseId = null;

          // Snapshot for status banner and response restore
          var activeConf  = document.querySelector('[data-confidence].active');
          var activeSplit = document.querySelector('[data-split].active');
          var _wrapperSel = document.getElementById('std-variant-select');
          saveCaseRecord(payload.case_id, {
            action:         'written',
            std_text:       getSlotText('std-0'),
            vai_text:       getSlotText('vai-0'),
            std_role:       preferredSlotId === 'std-0' ? 'preferred'
                            : (nonPreferredSlotId === 'std-0' ? 'non_preferred' : null),
            vai_role:       preferredSlotId === 'vai-0' ? 'preferred'
                            : (nonPreferredSlotId === 'vai-0' ? 'non_preferred' : null),
            preferred_text: (document.getElementById('preferred-editor') || {}).value || '',
            cva_notes:      (document.getElementById('cva-notes') || {}).value || '',
            confidence:     activeConf  ? activeConf.getAttribute('data-confidence')  : null,
            dataset_split:  activeSplit ? activeSplit.getAttribute('data-split')       : 'train',
            wrapper_mode:   _wrapperSel ? _wrapperSel.value : '0',
            pair_id:        result.pair_id,
            timestamp:      new Date().toISOString()
          });

          await saveSession();
          updateProgress();

          // Flash confirmation
          btnWritePair.textContent = 'Written!';
          showValidationHint('');
          setTimeout(function() {
            btnWritePair.textContent = 'Write Pair → DPO';
            btnWritePair.disabled = false;
            advanceToNextQueuedCase();
          }, 800);
        } else {
          showValidationHint('Write failed: ' + (result.error || 'Unknown error'));
          btnWritePair.textContent = 'Write Pair → DPO';
          btnWritePair.disabled = false;
        }
      } catch (err) {
        showValidationHint('Write error: ' + err.message);
        btnWritePair.textContent = 'Write Pair → DPO';
        btnWritePair.disabled = false;
      }
    });
  }

  // ── Write Additional Pair ─────────────────────────────────────────────────
  if (btnWriteAdd) {
    btnWriteAdd.addEventListener('click', async function() {
      var error = validateWritePairGates();
      if (error) {
        showValidationHint(error);
        return;
      }

      btnWriteAdd.disabled    = true;
      btnWriteAdd.textContent = 'Writing…';

      try {
        var payload = assemblePairPayload();
        var result  = await window.electronAPI.writePair(payload);
        if (checkAuth(result)) return;

        if (result.success) {
          sessionProgress.pairs_written = (sessionProgress.pairs_written || 0) + 1;
          if (result.destination === 'holdout') {
            sessionProgress.pairs_holdout = (sessionProgress.pairs_holdout || 0) + 1;
          } else {
            sessionProgress.pairs_train = (sessionProgress.pairs_train || 0) + 1;
          }

          // Do NOT add to completed_cases again or advance — stay on case
          currentCasePairCount++;
          await saveSession();
          updateProgress();

          btnWriteAdd.textContent = 'Written!';
          showValidationHint('');
          setTimeout(function() {
            btnWriteAdd.textContent = '+ Write Additional Pair';
            btnWriteAdd.disabled = false;
          }, 800);
        } else {
          showValidationHint('Write failed: ' + (result.error || 'Unknown error'));
          btnWriteAdd.textContent = '+ Write Additional Pair';
          btnWriteAdd.disabled = false;
        }
      } catch (err) {
        showValidationHint('Write error: ' + err.message);
        btnWriteAdd.textContent = '+ Write Additional Pair';
        btnWriteAdd.disabled = false;
      }
    });
  }

  // ── Skip ──────────────────────────────────────────────────────────────────
  // Hardcoded reason_code/reason_label — expand to a dialog in a future step
  if (btnSkip) {
    btnSkip.addEventListener('click', async function() {
      var c = corpus[currentIndex];
      if (!c) return;

      btnSkip.disabled    = true;
      btnSkip.textContent = 'Skipping…';

      try {
        var result = await window.electronAPI.writeSkip({
          case_id:  c.case_id,
          reason_code:  'cva_skip',
          reason_label: 'CVA skipped',
          cva_notes:    (document.getElementById('cva-notes') || {}).value || ''
        });
        if (checkAuth(result)) return;

        if (result.success) {
          sessionProgress.skipped = (sessionProgress.skipped || 0) + 1;

          // Track in skipped_cases array for status banner
          if (!sessionProgress.skipped_cases) sessionProgress.skipped_cases = [];
          if (sessionProgress.skipped_cases.indexOf(c.case_id) === -1) {
            sessionProgress.skipped_cases.push(c.case_id);
          }
          saveCaseRecord(c.case_id, {
            action:    'skipped',
            cva_notes: (document.getElementById('cva-notes') || {}).value || '',
            timestamp: new Date().toISOString()
          });

          currentQueuedCaseId = null;
          await saveSession();
          updateProgress();
          advanceToNextQueuedCase();
        } else {
          showValidationHint('Skip failed: ' + (result.error || 'Unknown error'));
        }
      } catch (err) {
        showValidationHint('Skip error: ' + err.message);
      } finally {
        btnSkip.textContent = 'Skip ▾';
        btnSkip.disabled    = false;
      }
    });
  }

  // ── Flag ──────────────────────────────────────────────────────────────────
  // Flag-and-release: POST /flags records the flag AND releases the case from
  // _in_flight so it returns to the queue pool. No cases are permanently
  // stranded. The flag record is preserved for future reviewer processing
  // (see renderer/review.js TODO).
  //
  // When an edited VAI response is flagged by Cortex (has_issues && vaiWasEdited),
  // the flag carries the full pair context as JSON in cva_notes with
  // flag_type: "cortex_override" so it lands in a review queue, not training data.
  if (btnFlag) {
    btnFlag.addEventListener('click', async function() {
      var c = corpus[currentIndex];
      if (!c) return;

      btnFlag.disabled    = true;
      btnFlag.textContent = 'Flagging…';

      try {
        var isCortexOverride = vaiWasEdited && cortexResult && cortexResult.has_issues;
        var flagType = isCortexOverride ? 'cortex_override' : 'team_review';
        var cvaNotes = (document.getElementById('cva-notes') || {}).value || '';

        // For cortex override flags, embed the full pair context so reviewers
        // can reconstruct the pair without re-running the case.
        if (isCortexOverride) {
          var pairContext = assemblePairPayload();
          pairContext.dataset_split = 'review';
          cvaNotes = JSON.stringify({
            cva_notes:    cvaNotes,
            cortex_result: cortexResult,
            pair_payload:  pairContext
          });
        }

        var result = await window.electronAPI.writeFlag({
          case_id: c.case_id,
          flag_type:   flagType,
          cva_notes:   cvaNotes
        });
        if (checkAuth(result)) return;

        if (result.success) {
          sessionProgress.flagged = (sessionProgress.flagged || 0) + 1;

          // Track in flagged_cases array for status banner
          if (!sessionProgress.flagged_cases) sessionProgress.flagged_cases = [];
          if (sessionProgress.flagged_cases.indexOf(c.case_id) === -1) {
            sessionProgress.flagged_cases.push(c.case_id);
          }
          saveCaseRecord(c.case_id, {
            action:    'flagged',
            flag_type: flagType,
            cva_notes: cvaNotes,
            timestamp: new Date().toISOString()
          });

          // Backend now releases from _in_flight on flag (flag-and-release)
          currentQueuedCaseId = null;
          await saveSession();
          updateProgress();
          advanceToNextQueuedCase();
        } else {
          showValidationHint('Flag failed: ' + (result.error || 'Unknown error'));
        }
      } catch (err) {
        showValidationHint('Flag error: ' + err.message);
      } finally {
        updateFlagButtonLabel();
        btnFlag.disabled = false;
      }
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

// Step 0: Resolve authenticated user ID from JWT before any API calls
window.electronAPI.getAuthUser().then(function(info) {
  CURRENT_USER_ID = (info && info.userId) ? info.userId : '';
  console.log('[auth] Authenticated user ID:', CURRENT_USER_ID);

// Step 2: Load corpus
return loadCorpus();
}).then(async function() {
  // Step 3: Init session (user ID resolved above from JWT)
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
    initTurndown();
    await initApiKeys();
    initStreamListeners();
    initRegenButtons();
    initRolePills();
    initEditTestPills();
    initActionButtons();

    // Step 5: Case display and navigation
    initNavigation();
    initFilters();

    // v1.9.0 — On launch, always request the next Raw case from the
    // queue so it gets claimed in queue_inflight. Previously we
    // bootstrapped from last_case_id (or corpus[0]), which could
    // reopen an already-worked case and skip the queue claim entirely
    // — letting two CVAs land on the same case. Per spec: fetch
    // session -> fetch next Raw case -> render.
    //
    // v1.12.0 — If the user has an unprocessed last_case_id that
    // differs from the first queued case, show a choice dialog so they
    // can either jump to first unpaired or resume where they left off.
    try {
      // Determine whether last_case_id is still unprocessed
      var _lastId = sessionProgress && sessionProgress.last_case_id;
      var _doneIds = [].concat(
        sessionProgress ? (sessionProgress.completed_cases || []) : [],
        sessionProgress ? (sessionProgress.skipped_cases   || []) : [],
        sessionProgress ? (sessionProgress.flagged_cases   || []) : []
      );
      var _lastIsUnprocessed = !!_lastId && _doneIds.indexOf(_lastId) === -1;

      var launchCase = await window.electronAPI.queueNext(
        CURRENT_USER_ID, 'all', 'all'
      );
      if (!checkAuth(launchCase)) {
        if (launchCase.success && launchCase.case && launchCase.case.case_id) {
          var _nextId = launchCase.case.case_id;

          // Show dialog only when the queued "first unpaired" differs from
          // the user's last unprocessed case -- otherwise just go there.
          // v1.12.2: await a Promise so the init chain pauses until the user
          // clicks, then loadCase runs in the same async context.
          if (_lastIsUnprocessed && _lastId !== _nextId) {
            var _choice = await new Promise(function(resolve) {
              var _dlg = document.getElementById('launch-dialog');
              var _resumeLabel = document.getElementById('launch-resume-id');
              if (_resumeLabel) _resumeLabel.textContent = _lastId;
              if (_dlg) _dlg.style.display = 'flex';
              document.getElementById('btn-launch-first').addEventListener('click', function() {
                if (_dlg) _dlg.style.display = 'none';
                resolve('first');
              }, { once: true });
              document.getElementById('btn-launch-resume').addEventListener('click', function() {
                if (_dlg) _dlg.style.display = 'none';
                resolve('resume');
              }, { once: true });
            });

            if (_choice === 'first') {
              queueExhausted = false;
              currentQueuedCaseId = _nextId;
              loadCase(_nextId);
            } else {
              // Release the queue claim on the "first unpaired" so another
              // CVA can pick it up, then load the resume target.
              try {
                await window.electronAPI.queueRelease(_nextId);
              } catch (e) {
                console.warn('[launch] queueRelease failed:', e.message);
              }
              currentQueuedCaseId = _lastId;
              loadCase(_lastId);
            }

          } else {
            // No ambiguity -- go straight to the first queued case
            queueExhausted = false;
            currentQueuedCaseId = _nextId;
            loadCase(_nextId);
          }

        } else if (launchCase.success && !launchCase.case) {
          queueExhausted = true;
          console.log('[launch] Queue exhausted -- no Raw cases remain.');
          // If the user has an unprocessed last case, let them resume it
          if (_lastIsUnprocessed) {
            console.log('[launch] Falling back to last unprocessed case:', _lastId);
            currentQueuedCaseId = _lastId;
            loadCase(_lastId);
          } else {
            updateNavButtons();
          }
        } else {
          console.warn("[launch] queueNext returned no case:", launchCase.error);
        }
      }
    } catch (err) {
      console.error("[launch] initial queueNext threw:", err.message);
    }

    updateProgress();
    // TODO Step 12: register keyboard shortcuts
  });
});
