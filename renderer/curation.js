/**
 * curation.js — Detached Curation Panel Logic
 * ==============================================
 * Role in VAI architecture:
 *   Runs in the renderer process of the detached curation BrowserWindow.
 *   Receives case data from the main window via IPC (curation:case-update),
 *   manages all curation control state, and fires write/skip/flag actions
 *   back to the main process via IPC (curation:pair-written, etc.).
 *
 *   Same functional scope as the right rail in renderer.js but in a
 *   standalone window suitable for a second monitor.
 *
 * Populated in: Step 13 (detached curation window)
 *
 * @module curation
 */

'use strict';

// TODO Step 13: Implement case context display, flag controls, mode selector,
//               edit field, confidence/split chips, notes, and action buttons.
//               Wire all IPC channels from spec Section 11.2.
