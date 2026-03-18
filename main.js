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
const { marked } = require('marked');

/**
 * API_BASE
 * @description Railway backend base URL for all CVA Tool API calls.
 *   All file I/O (corpus, session, queue, pairs, skips, flags) routes
 *   through this endpoint. Electron is a pure frontend — no local JSONL
 *   scanning or progress.json reads after this migration.
 * @see https://ivai-production.up.railway.app/health to verify backend is live
 */
const API_BASE = 'https://ivai-production.up.railway.app';

const {
  TEMP_STANDARD,
  TEMP_VAI,
  AVAILABLE_MODELS,
  STANDARD_PROMPTS,
  VAI_SYSTEM
} = require('./prompts');

/** Together AI endpoint — OpenAI-compatible chat completions API */
const TOGETHER_ENDPOINT = 'https://api.together.xyz/v1/chat/completions';

/** OpenAI endpoint */
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

/** Anthropic endpoint */
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

/**
 * Active streaming AbortControllers keyed by slotId.
 * Allows individual stream cancellation when CVA navigates away.
 * @type {Map<string, AbortController>}
 */
const activeStreams = new Map();

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

// ── Step 6: Streaming response generation ────────────────────────────────────

/**
 * Shared SSE streaming helper used by generate-standard and generate-vai.
 * Makes a streaming API call to Together AI (or OpenAI/Anthropic) and
 * forwards tokens to the renderer via llm-chunk IPC events.
 *
 * Supports three provider formats:
 *   - Together AI / OpenAI: OpenAI-compatible chat completions with SSE
 *   - Anthropic: Messages API with SSE (content_block_delta events)
 *
 * Provider is inferred from the model ID string:
 *   - 'claude-' prefix → Anthropic
 *   - 'gpt-' prefix    → OpenAI
 *   - all others        → Together AI
 *
 * @param {Electron.IpcMainInvokeEvent} event    - IPC event for chunk routing
 * @param {Object}  opts
 * @param {string}  opts.slotId       - Panel slot ID for chunk routing
 * @param {string}  opts.apiKey       - Provider API key
 * @param {string}  opts.model        - Model ID
 * @param {string}  opts.systemPrompt - Full assembled system prompt text
 * @param {string}  opts.userPrompt   - User message content
 * @param {number}  opts.temperature  - Sampling temperature
 * @param {number}  opts.maxTokens    - Max tokens for this call
 * @returns {Promise<void>}
 */
async function streamToPanel(event, opts) {
  const { slotId, apiKey, model, systemPrompt, userPrompt, temperature, maxTokens } = opts;

  // Infer provider from model ID
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
      // Anthropic Messages API format
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
      // OpenAI-compatible format (Together AI and OpenAI)
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

    // Read the SSE stream
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer   = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer

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
              // Route chunk to the correct panel slot in the renderer
              event.sender.send('llm-chunk', { slotId, content: chunkText });
            }
          }
        } catch {
          // Skip unparseable SSE chunks
        }
      }
    }

    // Notify renderer that stream is complete
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    if (!event.sender.isDestroyed()) {
      event.sender.send('llm-done', { slotId, fullText, elapsed });
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      // Normal cancellation on navigation — not an error
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
 * @description Fires a streaming Together AI (or OpenAI/Anthropic exploration)
 *   call for the Standard panel using the vertical's system prompt variant.
 *   Streams tokens back to the renderer via 'llm-chunk' IPC events.
 *   Completes with 'llm-done'. Errors with 'llm-error'.
 *
 *   slotId identifies the target panel slot (e.g. 'std-0', 'std-1') so the
 *   renderer can route chunks to the correct panel body element.
 *
 * @param {Electron.IpcMainInvokeEvent} event
 * @param {Object} params
 * @param {string} params.prompt          - The corpus case prompt text
 * @param {string} params.vertical        - Corpus vertical (key into STANDARD_PROMPTS)
 * @param {string} params.variantId       - 'A' or 'B'
 * @param {string} params.model           - Model ID string
 * @param {string} params.slotId          - Panel slot identifier for chunk routing
 * @param {string} params.apiKey          - Provider API key
 * @returns {Promise<void>}
 */
ipcMain.handle('generate-standard', async (event, params) => {
  const { prompt, vertical, variantId, model, slotId, apiKey } = params;

  // Resolve system prompt from vertical + variant
  const variants = STANDARD_PROMPTS[vertical];
  if (!variants) {
    event.sender.send('llm-error', {
      slotId, error: `No standard prompt for vertical: ${vertical}`
    });
    return;
  }
  const variant = variants.find(v => v.id === variantId);
  if (!variant) {
    event.sender.send('llm-error', {
      slotId, error: `No variant ${variantId} for vertical: ${vertical}`
    });
    return;
  }

  if (!apiKey) {
    event.sender.send('llm-error', { slotId, error: 'API key not configured.' });
    return;
  }

  await streamToPanel(event, {
    slotId,
    apiKey,
    model,
    systemPrompt: variant.text,
    userPrompt: prompt,
    temperature: TEMP_STANDARD,
    maxTokens: 600
  });
});

/**
 * IPC handler: generate-vai
 * @description Fires a streaming Together AI call for the VAI panel.
 *   Builds the full VAI system prompt by appending an axiological context
 *   block (Section 8.2) to VAI_SYSTEM. The context block is constructed
 *   from the corpus case metadata passed in caseData.
 *
 * @param {Electron.IpcMainInvokeEvent} event
 * @param {Object} params
 * @param {string} params.prompt          - The corpus case prompt text
 * @param {Object} params.caseData        - Full corpus case object
 * @param {string} params.intensity       - Override intensity ('Light'|'Balanced'|'Direct')
 * @param {string} params.model           - Model ID string
 * @param {string} params.slotId          - Panel slot identifier
 * @param {string} params.apiKey          - Together AI API key
 * @returns {Promise<void>}
 */
ipcMain.handle('generate-vai', async (event, params) => {
  const { prompt, caseData, intensity, model, slotId, apiKey } = params;

  if (!apiKey) {
    event.sender.send('llm-error', { slotId, error: 'API key not configured.' });
    return;
  }

  // Build axiological context block (spec Section 8.2)
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

  const systemPrompt = VAI_SYSTEM + '\n\n' + axiologicalContext;

  await streamToPanel(event, {
    slotId,
    apiKey,
    model,
    systemPrompt,
    userPrompt: prompt,
    temperature: TEMP_VAI,
    maxTokens: 800
  });
});

/**
 * IPC handler: cancel-stream
 * @description Aborts a specific active stream by slotId, or all streams
 *   if no slotId is provided. Called when CVA navigates to a new case
 *   mid-generation.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {string} [slotId] - Specific slot to cancel. Omit to cancel all.
 * @returns {void}
 */
ipcMain.handle('cancel-stream', (_event, slotId) => {
  if (slotId) {
    const controller = activeStreams.get(slotId);
    if (controller) {
      controller.abort();
      activeStreams.delete(slotId);
    }
  } else {
    // Cancel all active streams (e.g. on case navigation)
    for (const controller of activeStreams.values()) {
      controller.abort();
    }
    activeStreams.clear();
  }
});

/**
 * IPC handler: cortex:review
 * @description Sends the VAI response text to the Railway /review
 *   endpoint for Cortex validation. Returns structured analysis.
 *   Uses the cortex_model from api_keys.json config.
 *
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {Object} params
 * @param {string} params.text     - VAI response text to validate
 * @param {Object} params.caseData - Corpus case metadata
 * @returns {Promise<{has_issues: boolean, flags: string[],
 *           suggestions: string[], error?: string}>}
 */
ipcMain.handle('cortex:review', async (_event, params) => {
  try {
    const response = await fetch(`${API_BASE}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt:         params.caseData.prompt        || '',
        response:       params.text                   || '',
        inversion_type: params.caseData.inversion_type || '',
        intensity:      params.caseData.appropriate_intensity || 'Balanced'
      })
    });

    if (!response.ok) {
      throw new Error(`Cortex review failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    return result;

  } catch (err) {
    console.error('[cortex:review]', err.message);
    return { has_issues: false, flags: [], error: err.message };
  }
});

// ── Markdown rendering ────────────────────────────────────────────────────────

/**
 * IPC handler: render-markdown
 * @description Renders markdown to HTML using marked.js in the main process.
 *   Called from the renderer after stream completion to format panel text.
 *   Runs in main process because Electron 29+ sandboxed preloads cannot
 *   require() npm packages.
 * @param {Electron.IpcMainInvokeEvent} _event
 * @param {string} markdown - Raw markdown text
 * @returns {string} HTML string
 */
ipcMain.handle('render-markdown', (_event, markdown) => {
  return marked.parse(markdown || '');
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
  const defaults = {
    together_ai:      '',
    openai:           '',
    anthropic:        '',
    cortex_endpoint:  'railway',
    cortex_model:     'mistralai/Mistral-Small-24B-Instruct-2501'
  };
  try {
    if (!fs.existsSync(API_KEYS_PATH)) return defaults;
    const raw  = fs.readFileSync(API_KEYS_PATH, 'utf8');
    const data = JSON.parse(raw);
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
      _comment:        'CVA Tool API key configuration. Edit here or via the gear icon in the topbar.',
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

// ── Step 6:  'generate-standard', 'generate-vai' — added in Step 6
// ── Step 9:  'write-pair'                         — added in Step 9
// ── Step 10: 'write-skip', 'write-flag'           — added in Step 10
// ── Step 13: 'curation:open-window'               — added in Step 13
// ── Steps 16–20: review and audit channels        — added in Steps 16–20
