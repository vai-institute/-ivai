/**
 * main.js — Electron Main Process
 * ================================
 * Role in VAI architecture:
 *   This is the Node.js/Electron main process for the CVA Curation Tool.
 *   It owns all privileged operations: Railway API calls (corpus, session,
 *   queue, pairs, skips, flags, review), Together AI streaming, IPC channel
 *   registration, and BrowserWindow lifecycle management.
 *
 *   The renderer process (renderer/renderer.js) communicates with this
 *   process exclusively via the IPC bridge defined in preload.js.
 *   No renderer code has direct filesystem or network access.
 *
 * Architecture:
 *   - Corpus is fetched once on startup and cached in _corpusCache.
 *     All navigation and filtering operates on the local cache — only
 *     writes (pairs, skips, flags) hit the network.
 *   - All Railway API calls include X-User-Id header for server-side
 *     role enforcement (SOC 2 CC6).
 *   - API keys are stored locally in config/api_keys.json (never committed).
 *     The active userId is resolved from users.json at session start.
 *
 * Build sequence:
 *   Steps 1–4  — Complete (scaffold, corpus, session, layout)
 *   Step 5     — Wire corpus to sidebar + navigation (current)
 *   Step 6     — Together AI streaming (handlers present, Step 6 wires UI)
 *   Step 9     — DPO pair writes
 *   Step 10    — Skip / flag writes
 *   Step 13    — Detached curation window
 *   Steps 16–20 — Review Mode / audit log
 *
 * @module main
 */

'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path   = require('path');
const fs     = require('fs');
const { marked } = require('marked');

const {
  TEMP_STANDARD,
  TEMP_VAI,
  AVAILABLE_MODELS,
  STANDARD_PROMPTS,
  VAI_SYSTEM
} = require('./prompts');

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Railway backend base URL.
 * @see https://ivai-production.up.railway.app/health
 */
const API_BASE = 'https://ivai-production.up.railway.app';

/** Together AI endpoint — OpenAI-compatible chat completions */
const TOGETHER_ENDPOINT = 'https://api.together.xyz/v1/chat/completions';

/** OpenAI endpoint */
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

/** Anthropic endpoint */
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

/** Absolute path to the API keys config file. Never committed to git. */
const API_KEYS_PATH = path.join(__dirname, 'config', 'api_keys.json');

/** Absolute path to users config. */
const USERS_PATH = path.join(__dirname, 'config', 'users.json');

// ─── In-memory corpus cache ───────────────────────────────────────────────────

/**
 * Corpus cache — populated once on corpus:load, never re-fetched.
 * All navigation, filtering, and case lookup operates on this array.
 * @type {Array<Object>}
 */
let _corpusCache = [];

/**
 * Whether the corpus has been successfully loaded from the API.
 * @type {boolean}
 */
let _corpusLoaded = false;

// ─── Active user ──────────────────────────────────────────────────────────────

/**
 * The currently active CVA user ID, set when the session is initialized.
 * Used as the X-User-Id header on all authenticated API calls.
 * Defaults to 'peter_d' for single-user deployments.
 * @type {string}
 */
let _activeUserId = 'peter_d';

// ─── Streaming state ──────────────────────────────────────────────────────────

/**
 * Active streaming AbortControllers keyed by slotId.
 * Allows individual stream cancellation on navigation.
 * @type {Map<string, AbortController>}
 */
const activeStreams = new Map();

// ─── Window references ────────────────────────────────────────────────────────

/** @type {BrowserWindow|null} Main CVA workstation window */
let mainWindow = null;

// ─── API helper ───────────────────────────────────────────────────────────────

/**
 * Build standard headers for all Railway API calls.
 *
 * SOC 2 CC6 — Logical Access Controls:
 * Every authenticated request includes X-User-Id so the server can
 * enforce role-based access control independent of client-side UI state.
 *
 * @param {string} [userId] - Override user ID. Defaults to _activeUserId.
 * @returns {Object} Headers object with Content-Type and X-User-Id.
 */
function apiHeaders(userId) {
  return {
    'Content-Type': 'application/json',
    'X-User-Id': userId || _activeUserId
  };
}

// ─── Main window ─────────────────────────────────────────────────────────────

/**
 * Creates and configures the primary CVA workstation BrowserWindow.
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
    backgroundColor: '#F5F4F0',
    icon: path.join(__dirname, 'renderer', 'favicon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join('renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC handlers ─────────────────────────────────────────────────────────────

// ── User / session init ───────────────────────────────────────────────────────

/**
 * IPC handler: user:set-active
 * @description Sets the active user ID for this session. Must be called
 *   before any API calls that require authentication. The user ID is
 *   persisted in memory for the lifetime of the Electron process.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {string} userId - CVA user ID (e.g. 'peter_d')
 * @returns {{ success: boolean }}
 */
ipcMain.handle('user:set-active', (_event, userId) => {
  _activeUserId = userId || 'peter_d';
  console.log(`[user] Active user set to: ${_activeUserId}`);
  return { success: true };
});

/**
 * IPC handler: user:get-list
 * @description Returns the list of users from config/users.json so the
 *   renderer can populate the launch modal user selector.
 *
 * @returns {{ success: boolean, users: Array, roles: Object }}
 */
ipcMain.handle('user:get-list', () => {
  try {
    if (!fs.existsSync(USERS_PATH)) {
      return { success: false, users: [], roles: {}, error: 'users.json not found' };
    }
    const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    return { success: true, users: data.users || [], roles: data.roles || {} };
  } catch (err) {
    console.error('[user:get-list]', err.message);
    return { success: false, users: [], roles: {}, error: err.message };
  }
});

// ── Step 2: Corpus loading ────────────────────────────────────────────────────

/**
 * IPC handler: corpus:load
 * @description Fetches the full 3,200-case corpus from the Railway backend
 *   and caches it in memory. Subsequent calls return the cache immediately
 *   without a network round-trip.
 *
 *   The cache strategy: fetch once per app session. If the CVA needs
 *   a fresh corpus (e.g. new batches were added), they restart the app.
 *   This keeps navigation instant and reduces Railway egress costs.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {boolean} [force=false] - If true, bypass cache and re-fetch.
 * @returns {Promise<{success: boolean, cases: Array, error?: string}>}
 */
ipcMain.handle('corpus:load', async (_event, force = false) => {
  // Return cache on subsequent calls unless forced
  if (_corpusLoaded && !force) {
    console.log(`[corpus] Returning ${_corpusCache.length} cached cases.`);
    return { success: true, cases: _corpusCache };
  }

  try {
    const response = await fetch(`${API_BASE}/corpus`, {
      headers: apiHeaders()
    });
    if (!response.ok) {
      throw new Error(`Corpus fetch failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    const cases = Array.isArray(data) ? data : (data.cases || []);

    _corpusCache = cases;
    _corpusLoaded = true;

    console.log(`[corpus] Loaded ${cases.length} cases from Railway API.`);
    return { success: true, cases };
  } catch (err) {
    console.error('[corpus:load]', err.message);
    return { success: false, error: err.message, cases: [] };
  }
});

/**
 * IPC handler: corpus:get-case
 * @description Returns a single case by case_number from the in-memory cache.
 *   Used by Step 5 navigation (Prev/Next/Jump) to avoid re-fetching the corpus.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {number} caseNumber - The case_number to retrieve.
 * @returns {{ success: boolean, case: Object|null, error?: string }}
 */
ipcMain.handle('corpus:get-case', (_event, caseNumber) => {
  if (!_corpusLoaded) {
    return { success: false, case: null, error: 'Corpus not loaded yet.' };
  }
  const found = _corpusCache.find(c => c.case_number === caseNumber);
  if (!found) {
    return { success: false, case: null, error: `Case #${caseNumber} not found.` };
  }
  return { success: true, case: found };
});

/**
 * IPC handler: corpus:get-verticals
 * @description Returns the unique list of verticals present in the corpus.
 *   Used to populate the sidebar vertical filter dropdown.
 *
 * @returns {{ success: boolean, verticals: string[] }}
 */
ipcMain.handle('corpus:get-verticals', () => {
  if (!_corpusLoaded) return { success: false, verticals: [] };
  const verticals = [...new Set(_corpusCache.map(c => c.vertical).filter(Boolean))].sort();
  return { success: true, verticals };
});

/**
 * IPC handler: corpus:get-filtered
 * @description Returns a filtered subset of the corpus based on vertical
 *   and/or inversion_type. Operates on the in-memory cache — no network call.
 *   Used by the sidebar queue filter dropdowns.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {Object} filters
 * @param {string} [filters.vertical]       - Filter by vertical ('all' = no filter)
 * @param {string} [filters.inversion_type] - Filter by inversion type ('all' = no filter)
 * @returns {{ success: boolean, cases: Array, total: number }}
 */
ipcMain.handle('corpus:get-filtered', (_event, filters = {}) => {
  if (!_corpusLoaded) return { success: false, cases: [], total: 0 };

  let cases = _corpusCache;
  if (filters.vertical && filters.vertical !== 'all') {
    cases = cases.filter(c => c.vertical === filters.vertical);
  }
  if (filters.inversion_type && filters.inversion_type !== 'all') {
    cases = cases.filter(c => c.inversion_type === filters.inversion_type);
  }
  return { success: true, cases, total: cases.length };
});

// ── Step 3: Session state ─────────────────────────────────────────────────────

/**
 * IPC handler: session:read
 * @description Fetches CVA session state from the Railway API.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {string} userId - CVA user ID
 * @returns {Promise<{success: boolean, session: Object|null, error?: string}>}
 */
ipcMain.handle('session:read', async (_event, userId) => {
  try {
    const response = await fetch(
      `${API_BASE}/session/${encodeURIComponent(userId)}`,
      { headers: apiHeaders(userId) }
    );
    if (!response.ok) {
      throw new Error(`Session read failed: ${response.status} ${response.statusText}`);
    }
    const raw = await response.json();
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
 * @description Persists CVA session state to the Railway API.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {string} userId
 * @param {Object} state
 * @returns {Promise<{success: boolean, error?: string}>}
 */
ipcMain.handle('session:write', async (_event, userId, state) => {
  try {
    const response = await fetch(
      `${API_BASE}/session/${encodeURIComponent(userId)}`,
      {
        method: 'POST',
        headers: apiHeaders(userId),
        body: JSON.stringify(state)
      }
    );
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
 * @description Resets CVA session to factory defaults.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {string} userId
 * @returns {Promise<{success: boolean, session: Object|null, error?: string}>}
 */
ipcMain.handle('session:reset', async (_event, userId) => {
  const defaultSession = {
    last_case_number: 1,
    pairs_written:    0,
    pairs_train:      0,
    pairs_holdout:    0,
    skipped:          0,
    flagged:          0,
    session_start:    new Date().toISOString(),
    last_updated:     new Date().toISOString(),
    completed_cases:  [],
    layout_preset:    'wide',
    review_mode:      'staged'
  };
  try {
    const response = await fetch(
      `${API_BASE}/session/${encodeURIComponent(userId)}`,
      {
        method: 'POST',
        headers: apiHeaders(userId),
        body: JSON.stringify(defaultSession)
      }
    );
    if (!response.ok) {
      throw new Error(`Session reset failed: ${response.status} ${response.statusText}`);
    }
    return { success: true, session: defaultSession };
  } catch (err) {
    console.error('[session:reset]', err.message);
    return { success: false, error: err.message, session: null };
  }
});

// ── Queue ─────────────────────────────────────────────────────────────────────

/**
 * IPC handler: queue:next
 * @description Requests next unworked case from the Railway queue.
 *   Returns the full case object from cache after getting the case_number.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {string} userId
 * @param {string} [vertical]
 * @param {string} [inversionType]
 * @returns {Promise<{success: boolean, case: Object|null, error?: string}>}
 */
ipcMain.handle('queue:next', async (_event, userId, vertical, inversionType) => {
  try {
    const params = new URLSearchParams();
    if (vertical && vertical !== 'all') params.append('vertical', vertical);
    if (inversionType && inversionType !== 'all') params.append('inversion_type', inversionType);

    const qs = params.toString() ? `?${params.toString()}` : '';
    const response = await fetch(`${API_BASE}/queue/next${qs}`, {
      headers: apiHeaders(userId)
    });
    if (!response.ok) {
      throw new Error(`Queue fetch failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    // API returns the full case object in data.case
    const caseObj = data.case || null;
    return { success: true, case: caseObj };
  } catch (err) {
    console.error('[queue:next]', err.message);
    return { success: false, case: null, error: err.message };
  }
});

/**
 * IPC handler: queue:release
 * @description Releases a case from the in-flight set when CVA navigates
 *   away without completing it.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {number} caseNumber
 * @returns {Promise<{success: boolean}>}
 */
ipcMain.handle('queue:release', async (_event, caseNumber) => {
  try {
    await fetch(`${API_BASE}/queue/release/${caseNumber}`, {
      method: 'POST',
      headers: apiHeaders()
    });
    return { success: true };
  } catch (err) {
    console.error('[queue:release]', err.message);
    return { success: false };
  }
});

// ── Step 9: Write pair ────────────────────────────────────────────────────────

/**
 * IPC handler: write-pair
 * @description Submits a completed DPO pair to the Railway API.
 *   PII scrubbing, FERPA firewall, and audit logging are handled
 *   server-side in the /pairs endpoint.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {Object} pairData - Full DPO pair payload (spec Section 4.3)
 * @returns {Promise<{success: boolean, pair_id?: string, error?: string}>}
 */
ipcMain.handle('write-pair', async (_event, pairData) => {
  try {
    const response = await fetch(`${API_BASE}/pairs`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(pairData)
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Pair write failed: ${response.status} — ${errText}`);
    }
    const result = await response.json();
    console.log(`[write-pair] Pair ${result.pair_id} → ${result.destination}`);
    return { success: true, pair_id: result.pair_id, destination: result.destination };
  } catch (err) {
    console.error('[write-pair]', err.message);
    return { success: false, error: err.message };
  }
});

// ── Step 10: Skip / Flag ──────────────────────────────────────────────────────

/**
 * IPC handler: write-skip
 * @description Submits a skip record to the Railway API.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {Object} skipData - Skip record (spec Section 4.4)
 * @returns {Promise<{success: boolean, skip_id?: string, error?: string}>}
 */
ipcMain.handle('write-skip', async (_event, skipData) => {
  try {
    const response = await fetch(`${API_BASE}/skips`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(skipData)
    });
    if (!response.ok) {
      throw new Error(`Skip write failed: ${response.status}`);
    }
    const result = await response.json();
    return { success: true, skip_id: result.skip_id };
  } catch (err) {
    console.error('[write-skip]', err.message);
    return { success: false, error: err.message };
  }
});

/**
 * IPC handler: write-flag
 * @description Submits a flag record to the Railway API.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {Object} flagData - Flag record payload
 * @returns {Promise<{success: boolean, flag_id?: string, error?: string}>}
 */
ipcMain.handle('write-flag', async (_event, flagData) => {
  try {
    const response = await fetch(`${API_BASE}/flags`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(flagData)
    });
    if (!response.ok) {
      throw new Error(`Flag write failed: ${response.status}`);
    }
    const result = await response.json();
    return { success: true, flag_id: result.flag_id };
  } catch (err) {
    console.error('[write-flag]', err.message);
    return { success: false, error: err.message };
  }
});

// ── Step 6: Streaming response generation ────────────────────────────────────

// Provider routing — exploration models (OpenAI, Anthropic) are NOT training-eligible.
// Their outputs must never reach arlaf_training_data.jsonl or arlaf_holdout_data.jsonl.
// Enforcement: renderer disables role pills and Write Pair when trainingEligible === false.

/**
 * Shared SSE streaming helper for generate-standard and generate-vai.
 * Forwards tokens to the renderer via 'llm-chunk' IPC events.
 *
 * Provider is inferred from model ID:
 *   - 'claude-' prefix → Anthropic Messages API
 *   - 'gpt-' prefix    → OpenAI Chat Completions
 *   - all others        → Together AI (OpenAI-compatible)
 *
 * @param {Electron.IpcMainInvokeEvent} event
 * @param {Object} opts
 * @param {string} opts.slotId
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {number} opts.temperature
 * @param {number} opts.maxTokens
 * @returns {Promise<void>}
 */
async function streamToPanel(event, opts) {
  const { slotId, apiKey, model, systemPrompt, userPrompt, temperature, maxTokens } = opts;

  const isAnthropic = model.startsWith('claude-');
  const isOpenAI    = model.startsWith('gpt-');
  const endpoint    = isAnthropic ? ANTHROPIC_ENDPOINT
                    : isOpenAI    ? OPENAI_ENDPOINT
                    : TOGETHER_ENDPOINT;

  const controller = new AbortController();
  activeStreams.set(slotId, controller);

  const startTime = performance.now();

  try {
    let headers, body;

    if (isAnthropic) {
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      };
      body = {
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        temperature,
        stream: true
      };
    } else {
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      };
      body = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt }
        ],
        temperature,
        max_tokens: maxTokens,
        stream: true
      };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text();
      let errMsg = `HTTP ${response.status}`;
      try { errMsg += ': ' + JSON.parse(errText).error.message; }
      catch { errMsg += ': ' + errText.substring(0, 200); }
      throw new Error(errMsg);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer   = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          let chunkText = '';

          if (isAnthropic) {
            if (parsed.type === 'content_block_delta' &&
                parsed.delta?.type === 'text_delta') {
              chunkText = parsed.delta.text;
            }
          } else {
            const choices = parsed.choices;
            if (!choices || choices.length === 0) continue;
            const delta = choices[0].delta;
            if (!delta || !delta.content) continue;
            chunkText = delta.content;
          }

          if (chunkText) {
            fullText += chunkText;
            if (!event.sender.isDestroyed()) {
              event.sender.send('llm-chunk', { slotId, content: chunkText });
            }
          }
        } catch {
          // Skip unparseable SSE chunks
        }
      }
    }

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    if (!event.sender.isDestroyed()) {
      event.sender.send('llm-done', { slotId, fullText, elapsed });
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      if (!event.sender.isDestroyed()) {
        event.sender.send('llm-done', { slotId, fullText: '', elapsed: '0' });
      }
    } else {
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      if (!event.sender.isDestroyed()) {
        event.sender.send('llm-error', { slotId, error: err.message, elapsed });
      }
    }
  } finally {
    activeStreams.delete(slotId);
  }
}

/**
 * IPC handler: generate-standard
 * @description Fires a streaming call for the Standard panel.
 *
 * @param {Electron.IpcMainInvokeEvent} event
 * @param {Object} params
 * @param {string} params.prompt
 * @param {string} params.vertical
 * @param {string} params.variantId
 * @param {string} params.model
 * @param {string} params.slotId
 * @param {string} params.apiKey
 */
ipcMain.handle('generate-standard', async (event, params) => {
  const { prompt, vertical, variantId, model, slotId, apiKey } = params;

  const variants = STANDARD_PROMPTS[vertical];
  if (!variants) {
    event.sender.send('llm-error', { slotId, error: `No standard prompt for vertical: ${vertical}` });
    return;
  }
  const variant = variants.find(v => v.id === variantId);
  if (!variant) {
    event.sender.send('llm-error', { slotId, error: `No variant ${variantId} for vertical: ${vertical}` });
    return;
  }
  if (!apiKey) {
    event.sender.send('llm-error', { slotId, error: 'API key not configured.' });
    return;
  }

  await streamToPanel(event, {
    slotId, apiKey, model,
    systemPrompt: variant.text,
    userPrompt: prompt,
    temperature: TEMP_STANDARD,
    maxTokens: 300
  });
});

/**
 * IPC handler: generate-vai
 * @description Fires a streaming call for the VAI panel with axiological context.
 *
 * @param {Electron.IpcMainInvokeEvent} event
 * @param {Object} params
 * @param {string} params.prompt
 * @param {Object} params.caseData
 * @param {string} params.intensity
 * @param {string} params.model
 * @param {string} params.slotId
 * @param {string} params.apiKey
 */
ipcMain.handle('generate-vai', async (event, params) => {
  const { prompt, caseData, intensity, model, slotId, apiKey } = params;

  if (!apiKey) {
    event.sender.send('llm-error', { slotId, error: 'API key not configured.' });
    return;
  }

  const axiologicalContext = `
=== AXIOLOGICAL CONTEXT FOR THIS CASE ===
Inversion type: ${caseData.inversion_type}
Subtlety: ${caseData.subtlety}
Inversion severity: ${caseData.inversion_severity}
Primary person at risk (I): ${caseData.primary_entity_i}
Systemic element creating pressure (S): ${caseData.primary_systemic_element_s}
User underlying need: ${caseData.user_underlying_need}
Appropriate response intensity: ${intensity}
Identity language required: ${caseData.identity_language ? 'Yes' : 'No'}
Boundary condition: ${caseData.boundary_condition
    ? 'Yes — refusal with identity declaration required'
    : 'No'}
=========================================`;

  await streamToPanel(event, {
    slotId, apiKey, model,
    systemPrompt: VAI_SYSTEM + '\n\n' + axiologicalContext,
    userPrompt: prompt,
    temperature: TEMP_VAI,
    maxTokens: 800
  });
});

/**
 * IPC handler: cancel-stream
 * @description Aborts a specific active stream, or all streams if no slotId given.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {string} [slotId]
 */
ipcMain.handle('cancel-stream', (_event, slotId) => {
  if (slotId) {
    const controller = activeStreams.get(slotId);
    if (controller) { controller.abort(); activeStreams.delete(slotId); }
  } else {
    for (const controller of activeStreams.values()) controller.abort();
    activeStreams.clear();
  }
});

// ── Cortex review ─────────────────────────────────────────────────────────────

/**
 * IPC handler: cortex:review
 * @description Proxies a VAI Cortex review call to the Railway /review endpoint.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {Object} params
 * @param {string} params.text
 * @param {Object} params.caseData
 * @returns {Promise<Object>}
 */
ipcMain.handle('cortex:review', async (_event, params) => {
  try {
    const response = await fetch(`${API_BASE}/review`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        preferred_text: params.text || '',
        case_context: {
          vertical:       params.caseData.vertical        || '',
          inversion_type: params.caseData.inversion_type  || '',
          primary_entity_i:          params.caseData.primary_entity_i          || '',
          primary_systemic_element_s: params.caseData.primary_systemic_element_s || ''
        }
      })
    });
    if (!response.ok) {
      throw new Error(`Cortex review failed: ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } catch (err) {
    console.error('[cortex:review]', err.message);
    return { has_issues: false, flags: [], error: err.message };
  }
});

// ── Markdown rendering ────────────────────────────────────────────────────────

/**
 * IPC handler: render-markdown
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {string} markdown
 * @returns {string} HTML
 */
ipcMain.handle('render-markdown', (_event, markdown) => {
  return marked.parse(markdown || '');
});

// ── API key configuration ─────────────────────────────────────────────────────

/**
 * IPC handler: config:read-keys
 * @returns {{ together_ai: string, openai: string, anthropic: string,
 *             cortex_endpoint: string, cortex_model: string }}
 */
ipcMain.handle('config:read-keys', () => {
  const defaults = {
    together_ai:      '',
    openai:           '',
    anthropic:        '',
    cortex_endpoint:  'railway',
    cortex_model:     'mistralai/Mistral-Small-24B-Instruct-2501'
  };
  try {
    if (!fs.existsSync(API_KEYS_PATH)) return defaults;
    const data = JSON.parse(fs.readFileSync(API_KEYS_PATH, 'utf8'));
    return {
      together_ai:     data.together_ai     || '',
      openai:          data.openai          || '',
      anthropic:       data.anthropic       || '',
      cortex_endpoint: data.cortex_endpoint || 'railway',
      cortex_model:    data.cortex_model    || 'mistralai/Mistral-Small-24B-Instruct-2501'
    };
  } catch (err) {
    console.warn('[config] Could not read api_keys.json:', err.message);
    return defaults;
  }
});

/**
 * IPC handler: config:write-keys
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {Object} keys
 * @returns {{ ok: boolean, error: string|null }}
 */
ipcMain.handle('config:write-keys', (_event, keys) => {
  try {
    const data = {
      _comment:        'CVA Tool API key configuration. Edit here or via gear icon.',
      together_ai:     keys.together_ai     || '',
      openai:          keys.openai          || '',
      anthropic:       keys.anthropic       || '',
      cortex_endpoint: keys.cortex_endpoint || 'railway',
      cortex_model:    keys.cortex_model    || 'mistralai/Mistral-Small-24B-Instruct-2501'
    };
    fs.writeFileSync(API_KEYS_PATH, JSON.stringify(data, null, 2), 'utf8');
    console.log('[config] API keys saved.');
    return { ok: true, error: null };
  } catch (err) {
    console.error('[config] Write keys failed:', err.message);
    return { ok: false, error: err.message };
  }
});

// ── Steps 13, 16–20 — added in their respective steps ────────────────────────
// Step 13: 'curation:open-window'
// Steps 16–20: review and audit channels
