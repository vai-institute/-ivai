/**
 * preload.js — Secure IPC Bridge
 * ================================
 * Role in VAI architecture:
 *   Runs in a special context that has access to both the renderer's DOM
 *   and Electron's Node.js/IPC APIs, but isolates them via contextBridge.
 *
 *   This file is the ONLY surface through which the renderer can trigger
 *   privileged operations (API calls, session state, streaming). No renderer
 *   code calls ipcRenderer directly — it calls window.electronAPI methods
 *   defined here.
 *
 * Security model:
 *   - contextIsolation: true (set in main.js BrowserWindow config)
 *   - nodeIntegration: false
 *   - Only explicitly whitelisted channels are exposed
 *
 * IPC channels by build step:
 *   Step 2:  corpus:load, corpus:get-case, corpus:get-verticals,
 *            corpus:get-filtered
 *   Step 3:  session:read, session:write
 *   Step 4:  user:set-active, user:get-list
 *   Step 5:  queue:next, queue:release
 *   Step 6:  generate-standard, generate-vai, cancel-stream, cortex:review
 *            llm-chunk / llm-done / llm-error event listeners
 *   Step 9:  write-pair
 *   Step 10: write-skip, write-flag
 *   Step 13: curation:open-window, curation:case-update
 *   Steps 16–20: review and audit channels
 *
 * @module preload
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  /**
   * Returns the Electron version string for diagnostic display.
   * @returns {string}
   */
  getElectronVersion: () => process.versions.electron,

  /**
   * Relaunches the entire Electron app (topbar restart button).
   * @returns {Promise<void>}
   */
  restartApp: () => ipcRenderer.invoke('app:restart'),

  // ── Authentication ───────────────────────────────────────────────────────────────────────

  /** Authenticate with user_id + password. Main process stores JWT,
   *  closes login window, and opens the main workstation window.
   *  @param {{ userId: string, password: string }} credentials
   *  @returns {Promise<{ success: boolean, error?: string }>} */
  login: (credentials) => ipcRenderer.invoke('auth:login', credentials),

  /** Clear the JWT and return to the login screen.
   *  @returns {Promise<void>} */
  logout: () => ipcRenderer.invoke('auth:logout'),

  /** Return current user info without exposing the token.
   *  @returns {Promise<{ userId: string }>} */
  getAuthUser: () => ipcRenderer.invoke('auth:get-user'),

  // ── User management ─────────────────────────────────────────────────────────

  /**
   * Sets the active CVA user for this session.
   * Must be called before any authenticated API call.
   * @param {string} userId
   * @returns {Promise<{ success: boolean }>}
   */
  setActiveUser: (userId) => ipcRenderer.invoke('user:set-active', userId),

  /**
   * Returns the full user list and role definitions from config/users.json.
   * Used to populate the launch modal user selector.
   * @returns {Promise<{ success: boolean, users: Array, roles: Object }>}
   */
  getUserList: () => ipcRenderer.invoke('user:get-list'),

  // ── Corpus ──────────────────────────────────────────────────────────────────

  /**
   * Fetches the full corpus from Railway and caches it in memory.
   * Subsequent calls return the cache. Pass force=true to re-fetch.
   * @param {boolean} [force=false]
   * @returns {Promise<{ success: boolean, cases: Object[], error?: string }>}
   */
  loadCorpus: (force) => ipcRenderer.invoke('corpus:load', force),

  /**
   * Returns a single case by case_id from the in-memory cache.
   * Used by Prev/Next/Jump navigation — no network call.
   * @param {string} caseId - The case_id (YYMMDD-NNNNN)
   * @returns {{ success: boolean, case: Object|null, error?: string }}
   */
  getCase: (caseId) => ipcRenderer.invoke('corpus:get-case', caseId),

  /**
   * Returns the unique list of verticals in the corpus.
   * Used to populate the sidebar vertical filter dropdown.
   * @returns {{ success: boolean, verticals: string[] }}
   */
  getVerticals: () => ipcRenderer.invoke('corpus:get-verticals'),

  /**
   * Returns a filtered subset of the corpus from cache.
   * @param {{ vertical?: string, inversion_type?: string }} filters
   * @returns {{ success: boolean, cases: Object[], total: number }}
   */
  getFilteredCases: (filters) => ipcRenderer.invoke('corpus:get-filtered', filters),

  // ── Session ─────────────────────────────────────────────────────────────────

  /**
   * Fetches CVA session state from the Railway API.
   * @param {string} userId
   * @returns {Promise<{ success: boolean, session: Object|null, error?: string }>}
   */
  readSession: (userId) => ipcRenderer.invoke('session:read', userId),

  /**
   * Persists CVA session state to the Railway API.
   * @param {string} userId
   * @param {Object} state
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  writeSession: (userId, state) => ipcRenderer.invoke('session:write', userId, state),

  // ── Queue ───────────────────────────────────────────────────────────────────
  // v1.9.0 note: resetSession was removed — counters are server-derived.

  /**
   * Requests the next unworked case from the Railway queue.
   * Returns the full case object.
   * @param {string} userId
   * @param {string} [vertical]
   * @param {string} [inversionType]
   * @returns {Promise<{ success: boolean, case: Object|null, error?: string }>}
   */
  queueNext: (userId, vertical, inversionType) =>
    ipcRenderer.invoke('queue:next', userId, vertical, inversionType),

  /**
   * Releases a case from the in-flight set when navigating away
   * without completing it.
   * @param {string} caseId - The case_id (YYMMDD-NNNNN)
   * @returns {Promise<{ success: boolean }>}
   */
  queueRelease: (caseId) => ipcRenderer.invoke('queue:release', caseId),

  // ── API key configuration ───────────────────────────────────────────────────

  /**
   * Reads stored API keys from config/api_keys.json.
   * @returns {Promise<{ together_ai: string, openai: string, anthropic: string,
   *                     cortex_endpoint: string, cortex_model: string }>}
   */
  readApiKeys: () => ipcRenderer.invoke('config:read-keys'),

  /**
   * Saves API keys to config/api_keys.json.
   * @param {Object} keys
   * @returns {Promise<{ ok: boolean, error: string|null }>}
   */
  writeApiKeys: (keys) => ipcRenderer.invoke('config:write-keys', keys),

  // ── Step 6: Response generation ─────────────────────────────────────────────

  /**
   * Fires a streaming Standard panel generation request.
   * @param {{ prompt, vertical, variantId, model, slotId, apiKey }} params
   * @returns {Promise<void>}
   */
  generateStandard: (params) => ipcRenderer.invoke('generate-standard', params),

  /**
   * Fires a streaming VAI panel generation request.
   * @param {{ prompt, caseData, intensity, model, slotId, apiKey }} params
   * @returns {Promise<void>}
   */
  generateVai: (params) => ipcRenderer.invoke('generate-vai', params),

  /**
   * Cancels an active stream by slotId, or all streams if no slotId given.
   * @param {string} [slotId]
   * @returns {Promise<void>}
   */
  cancelStream: (slotId) => ipcRenderer.invoke('cancel-stream', slotId),

  /**
   * Sends VAI response text to Railway Cortex for validation.
   * @param {{ text: string, caseData: Object }} params
   * @returns {Promise<Object>}
   */
  runCortexReview: (params) => ipcRenderer.invoke('cortex:review', params),

  /**
   * Registers a callback for incoming stream token chunks.
   * Returns an unsubscribe function — call it on navigation to prevent leaks.
   * @param {function({ slotId: string, content: string }): void} callback
   * @returns {function} unsubscribe
   */
  onLlmChunk: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('llm-chunk', handler);
    return () => ipcRenderer.removeListener('llm-chunk', handler);
  },

  /**
   * Registers a callback for stream completion.
   * Returns an unsubscribe function.
   * @param {function({ slotId: string, fullText: string, elapsed: string }): void} callback
   * @returns {function} unsubscribe
   */
  onLlmDone: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('llm-done', handler);
    return () => ipcRenderer.removeListener('llm-done', handler);
  },

  /**
   * Registers a callback for stream errors.
   * Returns an unsubscribe function.
   * @param {function({ slotId: string, error: string }): void} callback
   * @returns {function} unsubscribe
   */
  onLlmError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('llm-error', handler);
    return () => ipcRenderer.removeListener('llm-error', handler);
  },

  /**
   * Renders a markdown string to safe HTML via the main process.
   * @param {string} markdown
   * @returns {Promise<string>} HTML string
   */
  renderMarkdown: (markdown) => ipcRenderer.invoke('render-markdown', markdown),

  // ── Step 9: Write pair ──────────────────────────────────────────────────────

  /**
   * Submits a completed DPO pair to the Railway API.
   * PII scrubbing, FERPA firewall, and audit logging are server-side.
   * @param {Object} pairData - Full DPO pair payload (spec Section 4.3)
   * @returns {Promise<{ success: boolean, pair_id?: string,
   *                     destination?: string, error?: string }>}
   */
  writePair: (pairData) => ipcRenderer.invoke('write-pair', pairData),

  // ── Step 10: Skip / Flag ────────────────────────────────────────────────────

  /**
   * Submits a skip record to the Railway API.
   * @param {Object} skipData - Skip payload (spec Section 4.4)
   * @returns {Promise<{ success: boolean, skip_id?: string, error?: string }>}
   */
  writeSkip: (skipData) => ipcRenderer.invoke('write-skip', skipData),

  /**
   * Submits a flag record to the Railway API.
   * @param {Object} flagData - Flag payload
   * @returns {Promise<{ success: boolean, flag_id?: string, error?: string }>}
   */
  writeFlag: (flagData) => ipcRenderer.invoke('write-flag', flagData),

  // ── Steps 13, 16–20 — added in their respective steps ──────────────────────
  // Step 13: openCurationWindow, onCurationCaseUpdate
  // Steps 16–20: review and audit channels

});
