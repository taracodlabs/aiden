/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/license — Aiden v4.0.0 Pro license subsystem (Phase 20).
 *
 * Public exports:
 *   - LicenseClient           — activate / verify / deactivate against the
 *                               Cloudflare worker.
 *   - getMachineFingerprint   — deterministic 32-char hex id for this host.
 *   - LicenseCache            — persisted shape on disk (encrypted).
 *   - isWellFormedKey         — pre-flight format check.
 */

export { LicenseClient, isWellFormedKey } from './licenseClient';
export type { LicenseFetch, LicenseClientOptions, LicenseServerResponse } from './licenseClient';
export {
  getMachineFingerprint,
  getMachineDisplayName,
} from './machineFingerprint';
export {
  loadLicense,
  saveLicense,
  clearLicense,
  hasLicense,
  getLicenseFilePath,
} from './licenseStore';
export type { LicenseCache } from './licenseStore';
export { FeatureGate, createFeatureGate, FEATURE_FLAGS } from './featureGate';
export type { FeatureFlag, FeatureGateOptions } from './featureGate';
