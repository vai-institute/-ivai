/**
 * preload.js — Secure IPC Bridge
 * ================================
 * Role in VAI architecture:
 *   Runs in a special context that has access to both the renderer's DOM
 *   and Electron's Node.js/IPC APIs, but isolates them via contextBridge.
 *
 *   This file is the ONLY surface through which the renderer can trigger
 *   privileged operations (file I/O, API calls, session state). No renderer
 *   code calls ipcRenderer directly — it calls window.electronAPI methods
 *   defined here.
 *
 *   In Step 1 this file only exposes a minimal version check. IPC channels
 *   are added here as each build step is completed.
 *
 * Security model:
 *   - contextIsolation: true (set in main.js BrowserWindow config)
 *   - nodeIntegration: false
 *   - Only explicitly whitelisted channels are exposed
 *
 * IPC channels registered by build step:
 *   Step 2:  corpus:load
 *   Step 3:  session:read, session:write
 *   Step 6:  generate-standard, generate-vai
 *   Step 9:  write-pair
 *   Step 10: write-skip, write-flag
 *   Step 13: curation:open-window, curation:case-update
 *   Steps 16–20: review and audit channels
 *
 * @module preload
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ─── Exposed API surface ──────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Returns the Electron version string for diagnostic display.
   * Used in Step 1 to verify the preload bridge is wired correctly.
   *
   * @returns {string} Electron version (e.g. "29.0.0")
   */
  getElectronVersion: () => process.versions.electron,

  // ── Step 2: Corpus loading ──────────────────────────────────────────────────

  /**
   * Scans data/corpus/ for all .jsonl files and returns the full parsed
   * case array sorted by case_number ascending.
   *
   * @returns {Promise<{ cases: object[], fileCount: number, errors: string[] }>}
   */
  loadCorpus: () => ipcRenderer.invoke('corpus:load'),

  /**
   * Fetches session state for the given user from the Railway API.
   * @param {string} userId - CVA user ID (e.g. 'peter_d')
   * @returns {Promise<{success: boolean, session: Object|null, error?: string}>}
   */
  readSession: (userId) => ipcRenderer.invoke('session:read', userId),

  /**
   * Persists session state for the given user to the Railway API.
   * @param {string} userId - CVA user ID
   * @param {Object} state - Full session state object
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  writeSession: (userId, state) => ipcRenderer.invoke('session:write', userId, state),

  /**
   * Resets session to factory defaults for the given user.
   * @param {string} userId - CVA user ID
   * @returns {Promise<{success: boolean, session: Object|null, error?: string}>}
   */
  resetSession: (userId) => ipcRenderer.invoke('session:reset', userId),

  /**
   * queueNext
   * @description Requests the next unworked case from the backend queue.
   * @param {string} userId - CVA user ID
   * @param {string} [vertical] - Optional vertical filter
   * @param {string} [inversionType] - Optional inversion type filter
   * @returns {Promise<{success: boolean, case_number: number, error?: string}>}
   */
  queueNext: (userId, vertical, inversionType) =>
    ipcRenderer.invoke('queue:next', userId, vertical, inversionType),

  /**
   * Reads stored API keys from config/api_keys.json.
   * @returns {Promise<{ together_ai: string, openai: string, anthropic: string }>}
   */
  readApiKeys: () => ipcRenderer.invoke('config:read-keys'),

  /**
   * Saves API keys to config/api_keys.json.
   * @param {{ together_ai: string, openai: string, anthropic: string }} keys
   * @returns {Promise<{ ok: boolean, error: string|null }>}
   */
  writeApiKeys: (keys) => ipcRenderer.invoke('config:write-keys', keys),

  // ── Step 6: Response generation ────────────────────────────────────────────

  /**
   * Fires a streaming Standard panel generation request.
   * @param {Object} params - { prompt, vertical, variantId, model, slotId, apiKey }
   * @returns {Promise<void>}
   */
  generateStandard: (params) => ipcRenderer.invoke('generate-standard', params),

  /**
   * Fires a streaming VAI panel generation request.
   * @param {Object} params - { prompt, caseData, intensity, model, slotId, apiKey }
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
   * Registers a callback for incoming stream token chunks.
   * Returns an unsubscribe function — call it on navigation to avoid leaks.
   * @param {function({slotId: string, content: string}): void} callback
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
   * @param {function({slotId: string, fullText: string, elapsed: string}): void} callback
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
   * @param {function({slotId: string, error: string}): void} callback
   * @returns {function} unsubscribe
   */
  onLlmError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('llm-error', handler);
    return () => ipcRenderer.removeListener('llm-error', handler);
  },

  /**
   * Renders a markdown string to safe HTML via the main process.
   * @param {string} markdown - Raw markdown text
   * @returns {Promise<string>} HTML string
   */
  renderMarkdown: (markdown) => ipcRenderer.invoke('render-markdown', markdown),

  // ── Step 9:  writePair
  // ── Step 10: writeSkip / writeFlag
  // ── Step 13: openCurationWindow / onCaseUpdate
  // ── Steps 16–20: review and audit channels
});
