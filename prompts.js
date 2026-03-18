/**
 * prompts.js — System Prompt Definitions
 * ========================================
 * Role in VAI architecture:
 *   Exports all system prompts used by the CVA Curation Tool to generate
 *   Standard and VAI responses for DPO pair curation.
 *
 *   Two prompt categories:
 *     - STANDARD_PROMPTS: Ten verticals × two variants (A/B) each.
 *       Used by the Standard panel. Variants expose different "assistant
 *       personas" so the CVA can observe how the inversion manifests
 *       under different framing conditions.
 *
 *     - VAI_SYSTEM: The full VAI system prompt (copied from vaidemo/app/prompts.js).
 *       Used by the VAI panel with an appended axiological context block
 *       built dynamically from each case's metadata (see main.js Section 8.2).
 *
 *   Temperature constants:
 *     - TEMP_STANDARD (0.7): promotes diversity in non-preferred responses
 *     - TEMP_VAI      (0.4): promotes consistency in preferred responses
 *
 *   Available models (Together AI only — training data must be clean-path):
 *     - AVAILABLE_MODELS: pre-populated list for the model selector dropdowns
 *
 * Populated in: Step 6 (response generation)
 * Read by:      main.js (IPC handlers for generate-standard, generate-vai)
 *
 * @module prompts
 */

'use strict';

// ─── Temperature constants ────────────────────────────────────────────────────
// Not user-configurable. Set here as named constants per spec Section 7.6.

/** Standard panel temperature — higher value promotes response diversity */
const TEMP_STANDARD = 0.7;

/** VAI panel temperature — lower value promotes preferred response consistency */
const TEMP_VAI = 0.4;

// ─── Model list ───────────────────────────────────────────────────────────────
// Together AI models are "training-eligible" — their outputs may be selected
// as preferred/non-preferred and written to DPO training files.
//
// OpenAI and Anthropic models are "exploration only" — available for ideation
// and comparison but copy is disabled and role pills are blocked when these
// models are active. Their outputs NEVER enter training data. This distinction
// respects OpenAI/Anthropic ToS (no training competing models on their outputs)
// while still allowing CVAs to use them for learning purposes.
//
// trainingEligible: true  → Together AI clean path — role pills + copy enabled
// trainingEligible: false → Exploration only — role pills + copy disabled,
//                           panel shows "Exploration only" indicator

const AVAILABLE_MODELS = [
  // ── Together AI (training-eligible) ──────────────────────────────────────
  {
    id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
    label: 'Llama 4 Maverick',
    provider: 'Together AI',
    trainingEligible: true
  },
  {
    id: 'mistralai/Mixtral-8x7B-Instruct-v0.1',
    label: 'Mixtral 8x7B',
    provider: 'Together AI',
    trainingEligible: true
  },
  // ── OpenAI (exploration only) ─────────────────────────────────────────────
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    provider: 'OpenAI',
    trainingEligible: false
  },
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o mini',
    provider: 'OpenAI',
    trainingEligible: false
  },
  // ── Anthropic (exploration only) ──────────────────────────────────────────
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    provider: 'Anthropic',
    trainingEligible: false
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    provider: 'Anthropic',
    trainingEligible: false
  }
];

// ─── Standard prompt variants (populated Step 6) ──────────────────────────────
// TODO Step 6: Copy full STANDARD_PROMPTS object from spec Section 6.1.
const STANDARD_PROMPTS = {};

// ─── VAI system prompt (populated Step 6) ────────────────────────────────────
// TODO Step 6: Copy VAI_SYSTEM verbatim from C:\projects\vaidemo\app\prompts.js
const VAI_SYSTEM = '';

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  TEMP_STANDARD,
  TEMP_VAI,
  AVAILABLE_MODELS,
  STANDARD_PROMPTS,
  VAI_SYSTEM
};
