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
   * Reads session/progress.json.
   * Returns null progress on first launch or malformed file.
   *
   * @returns {Promise<{ progress: object|null, isFirstLaunch: boolean }>}
   */
  readSession: () => ipcRenderer.invoke('session:read'),

  /**
   * Writes the given progress object to session/progress.json.
   * Stamps last_updated in the main process before writing.
   *
   * @param {object} progress - Current progress state
   * @returns {Promise<{ ok: boolean, error: string|null }>}
   */
  writeSession: (progress) => ipcRenderer.invoke('session:write', progress),

  /**
   * Resets progress.json to factory defaults and returns the fresh state.
   * Called when CVA chooses "Start Fresh" in the resume dialog.
   *
   * @returns {Promise<{ ok: boolean, progress: object, error: string|null }>}
   */
  resetSession: () => ipcRenderer.invoke('session:reset'),

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

  // ── Step 6:  generateStandard / generateVAI (with streaming callbacks)
  // ── Step 9:  writePair
  // ── Step 10: writeSkip / writeFlag
  // ── Step 13: openCurationWindow / onCaseUpdate
  // ── Steps 16–20: review and audit channels
});
