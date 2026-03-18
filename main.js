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
 * Scans data/corpus/ for all .jsonl files, parses every line into a case
 * object, sorts by case_number ascending, and returns the full array to
 * the renderer.
 *
 * Spec reference: Section 5 — Corpus Loading.
 *
 * Log format (to main process stdout):
 *   "Loaded 3,200 cases from 32 JSONL files."
 *
 * Error handling:
 *   - Missing corpus directory: returns empty array, logs warning.
 *   - Malformed JSON line: skips line, logs warning with filename + line number.
 *   - Empty file: skipped silently (contributes 0 cases).
 *
 * @param {Electron.IpcMainInvokeEvent} _event - Electron IPC event (unused)
 * @returns {{ cases: object[], fileCount: number, errors: string[] }}
 *   cases     — full sorted case array
 *   fileCount — number of .jsonl files found
 *   errors    — non-fatal parse warnings (empty array if clean)
 */
ipcMain.handle('corpus:load', (_event) => {
  const corpusDir = path.join(__dirname, 'data', 'corpus');
  const errors    = [];

  // Guard: corpus directory must exist
  if (!fs.existsSync(corpusDir)) {
    const msg = `[WARN] corpus directory not found: ${corpusDir}`;
    console.warn(msg);
    return { cases: [], fileCount: 0, errors: [msg] };
  }

  // Collect all .jsonl files in the directory (not recursive)
  const files = fs.readdirSync(corpusDir)
    .filter(f => f.endsWith('.jsonl'))
    .sort(); // alphabetical — preserves batch order for logging

  const allCases = [];

  for (const filename of files) {
    const filepath = path.join(corpusDir, filename);
    const raw      = fs.readFileSync(filepath, 'utf8');
    const lines    = raw.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue; // skip blank lines (common at end of file)

      try {
        const caseObj = JSON.parse(line);
        allCases.push(caseObj);
      } catch (err) {
        // Non-fatal: log and skip malformed line
        const msg = `[WARN] JSON parse error in ${filename} line ${i + 1}: ${err.message}`;
        console.warn(msg);
        errors.push(msg);
      }
    }
  }

  // Sort by case_number ascending so navigation is always sequential
  // regardless of the order files were read from disk.
  allCases.sort((a, b) => a.case_number - b.case_number);

  // Log to main process stdout — matches spec format (Section 5)
  console.log(`Loaded ${allCases.length.toLocaleString()} cases from ${files.length} JSONL files.`);

  return { cases: allCases, fileCount: files.length, errors };
});

// ── Step 3: Session state ─────────────────────────────────────────────────────

/** Absolute path to the session progress file. */
const SESSION_PATH = path.join(__dirname, 'session', 'progress.json');

/**
 * Default progress state written on first launch (no existing progress.json).
 * All fields defined here so later steps can rely on their presence.
 *
 * Fields from spec Section 4.5:
 *   last_case_number  — case_number of the last case the CVA was working on
 *   pairs_written     — total DPO pairs written (train + holdout)
 *   pairs_train       — pairs written to arlaf_training_data.jsonl
 *   pairs_holdout     — pairs written to arlaf_holdout_data.jsonl
 *   skipped           — cases written to skipped_cases.jsonl
 *   flagged           — cases written to flagged_cases.jsonl
 *   session_start     — ISO timestamp of first-ever session start
 *   last_updated      — ISO timestamp of most recent write
 *   completed_cases   — array of case_numbers fully processed (any outcome)
 *
 * Additional fields used by later steps:
 *   layout            — last-used layout preset (Section 7.2); default "Wide"
 *   review_mode       — staged | selective (Section 19.1); default "staged"
 *
 * @returns {object} Fresh default progress state
 */
function defaultProgress() {
  const now = new Date().toISOString();
  return {
    last_case_number: null,   // null = not yet started; set on first navigation
    pairs_written:    0,
    pairs_train:      0,
    pairs_holdout:    0,
    skipped:          0,
    flagged:          0,
    session_start:    now,
    last_updated:     now,
    completed_cases:  [],
    layout:           'Wide',     // spec Section 7.2 default
    review_mode:      'staged'    // spec Section 19.1 default
  };
}

/**
 * Reads session/progress.json and returns its contents.
 * If the file does not exist (first launch), returns null — the renderer
 * interprets null as "no prior session" and skips the resume dialog.
 * If the file is malformed, logs a warning and returns null (safe fallback).
 *
 * Spec reference: Section 4.5, Step 3.
 *
 * @param {Electron.IpcMainInvokeEvent} _event - IPC event (unused)
 * @returns {{ progress: object|null, isFirstLaunch: boolean }}
 *   progress       — parsed progress object, or null if no prior session
 *   isFirstLaunch  — true if progress.json did not exist
 */
ipcMain.handle('session:read', (_event) => {
  if (!fs.existsSync(SESSION_PATH)) {
    console.log('[session] No progress.json found — first launch.');
    return { progress: null, isFirstLaunch: true };
  }

  try {
    const raw      = fs.readFileSync(SESSION_PATH, 'utf8');
    const progress = JSON.parse(raw);
    console.log(`[session] Resuming — last case: #${progress.last_case_number}, ` +
                `${progress.pairs_written} pairs written.`);
    return { progress, isFirstLaunch: false };
  } catch (err) {
    // Malformed file — treat as first launch rather than crashing
    console.warn(`[session] progress.json is malformed, starting fresh: ${err.message}`);
    return { progress: null, isFirstLaunch: true };
  }
});

/**
 * Writes the provided progress object to session/progress.json.
 * Always updates the `last_updated` timestamp before writing.
 * Uses synchronous write to prevent partial writes on crash.
 *
 * Called by the renderer after every pair write, skip, flag, or navigation.
 *
 * Spec reference: Section 4.5, Section 15.1 (sync writes).
 *
 * @param {Electron.IpcMainInvokeEvent} _event    - IPC event (unused)
 * @param {object}                      progress  - Progress object to persist
 * @returns {{ ok: boolean, error: string|null }}
 */
ipcMain.handle('session:write', (_event, progress) => {
  try {
    // Always stamp last_updated at write time
    progress.last_updated = new Date().toISOString();

    // Ensure session/ directory exists (created in scaffold but defensive)
    const sessionDir = path.dirname(SESSION_PATH);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    fs.writeFileSync(SESSION_PATH, JSON.stringify(progress, null, 2), 'utf8');
    return { ok: true, error: null };
  } catch (err) {
    console.error(`[session] Write failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

/**
 * Creates a fresh default progress.json and writes it to disk.
 * Called when the CVA chooses "Start Fresh" in the resume dialog,
 * or on very first launch.
 *
 * @param {Electron.IpcMainInvokeEvent} _event - IPC event (unused)
 * @returns {{ ok: boolean, progress: object, error: string|null }}
 */
ipcMain.handle('session:reset', (_event) => {
  try {
    const fresh = defaultProgress();
    const sessionDir = path.dirname(SESSION_PATH);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    fs.writeFileSync(SESSION_PATH, JSON.stringify(fresh, null, 2), 'utf8');
    console.log('[session] Progress reset — starting fresh.');
    return { ok: true, progress: fresh, error: null };
  } catch (err) {
    console.error(`[session] Reset failed: ${err.message}`);
    return { ok: false, progress: null, error: err.message };
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
