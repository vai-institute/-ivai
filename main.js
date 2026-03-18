/**
 * main.js — Electron Main Process
 * ================================
 * Role in VAI architecture:
 *   This is the Node.js/Electron main process for the CVA Curation Tool.
 *   It owns all privileged operations: file I/O (reading corpus JSONL,
 *   writing DPO output pairs, updating session state), Together AI API
 *   calls with streaming, IPC channel registration, and BrowserWindow
 *   lifecycle management (main window + optional detached curation window).
 *
 *   The renderer process (renderer/renderer.js) communicates with this
 *   process exclusively via the IPC bridge defined in preload.js.
 *   No renderer code has direct filesystem or network access.
 *
 * Build sequence:
 *   Step 1  — Scaffold: opens a blank main window (current)
 *   Step 2  — Corpus loading
 *   Step 3  — Session state
 *   Step 6  — Together AI streaming
 *   Step 9  — DPO pair file writes
 *   Step 13 — Detached curation window
 *   Steps 16–20 — Review Mode / audit log
 *
 * @module main
 */

'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');

/**
 * API_BASE
 * @description Railway backend base URL for all CVA Tool API calls.
 *   All file I/O (corpus, session, queue, pairs, skips, flags) routes
 *   through this endpoint. Electron is a pure frontend — no local JSONL
 *   scanning or progress.json reads after this migration.
 * @see https://ivai-production.up.railway.app/health to verify backend is live
 */
const API_BASE = 'https://ivai-production.up.railway.app';

// ─── Window references ────────────────────────────────────────────────────────
// Kept in module scope so they are not garbage-collected while open.

/** @type {BrowserWindow|null} Main CVA workstation window */
let mainWindow = null;

// ─── Main window creation ─────────────────────────────────────────────────────

/**
 * Creates and configures the primary CVA workstation BrowserWindow.
 *
 * Window settings follow the spec (Section 7.1):
 *   - Minimum width/height enforce the panel minimum widths defined in the layout spec.
 *   - Context isolation + preload bridge pattern matches the demo app's security model.
 *   - nodeIntegration is explicitly false — all Node access is via preload.js.
 *
 * @returns {void}
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'CVA Curation Tool — IVAI',
    backgroundColor: '#F5F4F0', // neutral background, matches planned stylesheet
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // Required — isolates renderer from Node globals
      nodeIntegration: false    // Required — renderer has no direct Node access
    }
  });

  // Load the main window HTML shell.
  // In Step 1 this is a minimal blank page; full UI is built in Steps 4–5.
  mainWindow.loadFile(path.join('renderer', 'index.html'));

  // Clean up reference when window is closed to allow GC.
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

/**
 * Electron 'ready' event — all Chromium subsystems are initialized.
 * Safe to create BrowserWindows here.
 */
app.whenReady().then(() => {
  createMainWindow();

  // macOS: re-create the window when the dock icon is clicked and no windows
  // are open (standard macOS behavior).
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

/**
 * Quit the app when all windows are closed.
 * Exception: macOS — apps conventionally stay active until Cmd+Q.
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ─── IPC handlers ────────────────────────────────────────────────────────────

// ── Step 2: Corpus loading ────────────────────────────────────────────────────

/**
 * IPC handler: corpus:load
 * @description Fetches the full 3,200-case corpus from the Railway backend.
 *   Replaces the previous local JSONL file scan. Returns cases sorted by
 *   case_number ascending — the API guarantees this order.
 * @returns {Promise<{success: boolean, cases: Array, error?: string}>}
 */
ipcMain.handle('corpus:load', async () => {
  try {
    const response = await fetch(`${API_BASE}/corpus`);
    if (!response.ok) {
      throw new Error(`Corpus fetch failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    // API returns { cases: [...] } — extract the array
    const cases = Array.isArray(data) ? data : (data.cases || []);
    console.log(`Loaded ${cases.length} cases from Railway API.`);
    return { success: true, cases };
  } catch (err) {
    console.error('[corpus:load]', err.message);
    return { success: false, error: err.message, cases: [] };
  }
});

// ── Step 3: Session state ─────────────────────────────────────────────────────

/**
 * IPC handler: session:read
 * @description Fetches CVA session state for a given user from the Railway API.
 *   Replaces the previous progress.json read. The backend returns the stored
 *   session object or a default session if none exists yet.
 * @param {Electron.IpcMainInvokeEvent} _event - IPC event (unused)
 * @param {string} userId - CVA user ID (e.g. 'peter_d')
 * @returns {Promise<{success: boolean, session: Object|null, error?: string}>}
 */
ipcMain.handle('session:read', async (_event, userId) => {
  try {
    const response = await fetch(`${API_BASE}/session/${encodeURIComponent(userId)}`);
    if (!response.ok) {
      throw new Error(`Session read failed: ${response.status} ${response.statusText}`);
    }
    const raw = await response.json();
    // Normalize server field names to our internal session schema (Section 4.5).
    // Server uses current_case_number; our renderer uses last_case_number.
    const session = {
      last_case_number: raw.last_case_number || raw.current_case_number || 1,
      pairs_written:    raw.pairs_written    || 0,
      pairs_train:      raw.pairs_train      || 0,
      pairs_holdout:    raw.pairs_holdout    || 0,
      skipped:          raw.skipped          || 0,
      flagged:          raw.flagged          || 0,
      session_start:    raw.session_start    || new Date().toISOString(),
      last_updated:     raw.last_updated     || new Date().toISOString(),
      completed_cases:  raw.completed_cases  || [],
      layout_preset:    raw.layout_preset    || 'wide',
      review_mode:      raw.review_mode      || 'staged'
    };
    return { success: true, session };
  } catch (err) {
    console.error('[session:read]', err.message);
    return { success: false, error: err.message, session: null };
  }
});

/**
 * IPC handler: session:write
 * @description Persists CVA session state for a user to the Railway API.
 *   Replaces the previous fs.writeFileSync to progress.json.
 *   Called whenever the CVA navigates, writes a pair, skips, or flags.
 * @param {Electron.IpcMainInvokeEvent} _event - IPC event (unused)
 * @param {string} userId - CVA user ID
 * @param {Object} state - Full session state object conforming to Section 4.5 schema
 * @returns {Promise<{success: boolean, error?: string}>}
 */
ipcMain.handle('session:write', async (_event, userId, state) => {
  try {
    const response = await fetch(`${API_BASE}/session/${encodeURIComponent(userId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
    if (!response.ok) {
      throw new Error(`Session write failed: ${response.status} ${response.statusText}`);
    }
    return { success: true };
  } catch (err) {
    console.error('[session:write]', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * IPC handler: session:reset
 * @description Resets the CVA session to factory defaults via Railway API.
 *   Constructs the default session object locally, posts it to the server,
 *   and returns it to the renderer so the UI can update without a second read.
 *   Called when the CVA chooses "Start Fresh" in the resume dialog.
 * @param {Electron.IpcMainInvokeEvent} _event - IPC event (unused)
 * @param {string} userId - CVA user ID
 * @returns {Promise<{success: boolean, session: Object|null, error?: string}>}
 */
ipcMain.handle('session:reset', async (_event, userId) => {
  // Default session — matches Section 4.5 data model exactly
  const defaultSession = {
    last_case_number: 1,
    pairs_written: 0,
    pairs_train: 0,
    pairs_holdout: 0,
    skipped: 0,
    flagged: 0,
    session_start: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    completed_cases: [],
    layout_preset: 'wide',
    review_mode: 'staged'
  };
  try {
    const response = await fetch(`${API_BASE}/session/${encodeURIComponent(userId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(defaultSession)
    });
    if (!response.ok) {
      throw new Error(`Session reset failed: ${response.status} ${response.statusText}`);
    }
    return { success: true, session: defaultSession };
  } catch (err) {
    console.error('[session:reset]', err.message);
    return { success: false, error: err.message, session: null };
  }
});

/**
 * IPC handler: queue:next
 * @description Requests the next unworked case number from the Railway queue.
 *   The backend uses distributed queue logic to prevent two CVAs from working
 *   the same case simultaneously. Supports optional vertical and inversion_type
 *   filters — the backend returns the next case matching the active filter.
 * @param {Electron.IpcMainInvokeEvent} _event - IPC event (unused)
 * @param {string} userId - CVA user ID
 * @param {string} [vertical] - Optional vertical filter ('all' = no filter)
 * @param {string} [inversionType] - Optional inversion type filter ('all' = no filter)
 * @returns {Promise<{success: boolean, case_number: number, error?: string}>}
 */
ipcMain.handle('queue:next', async (_event, userId, vertical, inversionType) => {
  try {
    // Build query string — omit filter params when set to 'all'
    const params = new URLSearchParams({ user_id: userId });
    if (vertical && vertical !== 'all') params.append('vertical', vertical);
    if (inversionType && inversionType !== 'all') params.append('inversion_type', inversionType);

    const response = await fetch(`${API_BASE}/queue/next?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Queue fetch failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    // API returns { case: { case_number: N, ... } } — extract case_number
    const caseNumber = data.case_number || (data.case && data.case.case_number);
    return { success: true, case_number: caseNumber };
  } catch (err) {
    console.error('[queue:next]', err.message);
    return { success: false, error: err.message };
  }
});

// ── API key configuration ─────────────────────────────────────────────────────

/** Absolute path to the API keys config file. */
const API_KEYS_PATH = path.join(__dirname, 'config', 'api_keys.json');

/**
 * Reads config/api_keys.json and returns the stored keys.
 * Values are returned as-is — masking is handled in the renderer.
 * Returns empty strings for all providers if file is missing or malformed.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @returns {{ together_ai: string, openai: string, anthropic: string }}
 */
ipcMain.handle('config:read-keys', (_event) => {
  const defaults = { together_ai: '', openai: '', anthropic: '' };
  try {
    if (!fs.existsSync(API_KEYS_PATH)) return defaults;
    const raw  = fs.readFileSync(API_KEYS_PATH, 'utf8');
    const data = JSON.parse(raw);
    return {
      together_ai: data.together_ai || '',
      openai:      data.openai      || '',
      anthropic:   data.anthropic   || ''
    };
  } catch (err) {
    console.warn('[config] Could not read api_keys.json:', err.message);
    return defaults;
  }
});

/**
 * Writes updated API keys to config/api_keys.json.
 * Preserves the _comment field so the file stays human-readable.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {{ together_ai: string, openai: string, anthropic: string }} keys
 * @returns {{ ok: boolean, error: string|null }}
 */
ipcMain.handle('config:write-keys', (_event, keys) => {
  try {
    const data = {
      _comment:   'CVA Tool API key configuration. Edit here or via the gear icon in the topbar.',
      together_ai: keys.together_ai || '',
      openai:      keys.openai      || '',
      anthropic:   keys.anthropic   || ''
    };
    fs.writeFileSync(API_KEYS_PATH, JSON.stringify(data, null, 2), 'utf8');
    console.log('[config] API keys saved.');
    return { ok: true, error: null };
  } catch (err) {
    console.error('[config] Write keys failed:', err.message);
    return { ok: false, error: err.message };
  }
});

// ── Step 6:  'generate-standard', 'generate-vai' — added in Step 6
// ── Step 9:  'write-pair'                         — added in Step 9
// ── Step 10: 'write-skip', 'write-flag'           — added in Step 10
// ── Step 13: 'curation:open-window'               — added in Step 13
// ── Steps 16–20: review and audit channels        — added in Steps 16–20
