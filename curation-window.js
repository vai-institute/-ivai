/**
 * curation-window.js — Detachable Curation BrowserWindow
 * =========================================================
 * Role in VAI architecture:
 *   Manages the optional detached curation panel window (spec Section 11).
 *   When the CVA clicks "Detach to second monitor", this module opens a
 *   separate BrowserWindow (480×900) loading renderer/curation.html.
 *
 *   State synchronization between the main window and the curation window
 *   is handled via IPC channels (spec Section 11.2):
 *     curation:case-update   — main → curation (new case + responses)
 *     curation:pair-written  — curation → main (triggers case advance)
 *     curation:skip          — curation → main
 *     curation:flag          — curation → main
 *     curation:response-selected — curation → main
 *
 *   The main window's right rail collapses (0 width) while the curation
 *   window is open, and re-expands if the window is closed without writing.
 *
 * Populated in: Step 13 (detached curation window)
 * Called by:    main.js IPC handler for 'curation:open-window'
 *
 * @module curation-window
 */

'use strict';

// TODO Step 13: Implement createCurationWindow(), closeCurationWindow(),
//               and IPC sync logic as specified in Section 11.

module.exports = {};
