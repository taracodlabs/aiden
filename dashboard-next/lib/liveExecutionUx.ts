/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

export interface LiveExecutionSurfaceChoice {
  surfaceId: string;
  kind: string;
  status: string;
  updatedAt: number;
}

export interface LiveExecutionSelection {
  selectedSurfaceId: string | null;
  pinnedSurfaceId: string | null;
  autoFollow: boolean;
  attentionSurfaceId?: string | null;
}

export interface LiveExecutionAutoOpenIdentity {
  jobId: string;
  attemptId: string;
  generation: number;
  runId: number;
}

export function liveExecutionAutoOpenKey(
  identity: LiveExecutionAutoOpenIdentity,
  surfaceId: string | null,
): string {
  return `${identity.jobId}:${identity.attemptId}:${identity.generation}:${identity.runId}:${surfaceId ?? 'none'}`;
}

export function shouldAutoOpenLiveExecution(
  identity: LiveExecutionAutoOpenIdentity,
  terminal: boolean,
  surfaceId: string | null,
  dismissedKey: string | null,
): boolean {
  return !terminal && surfaceId !== null && liveExecutionAutoOpenKey(identity, surfaceId) !== dismissedKey;
}

/** Presentation-only selection. Durable runtime focus remains backend-owned. */
export function chooseLiveExecutionSurface(
  surfaces: readonly LiveExecutionSurfaceChoice[],
  current: LiveExecutionSelection,
  activeSurfaceId: string | null,
  attentionSurfaceId: string | null = null,
): LiveExecutionSelection {
  const ids = new Set(surfaces.map((surface) => surface.surfaceId));
  if (current.pinnedSurfaceId && ids.has(current.pinnedSurfaceId)) {
    const attention = attentionSurfaceId && attentionSurfaceId !== current.pinnedSurfaceId
      ? { attentionSurfaceId }
      : {};
    return { ...current, selectedSurfaceId: current.pinnedSurfaceId, ...attention };
  }
  if (current.selectedSurfaceId && ids.has(current.selectedSurfaceId) && !current.autoFollow) {
    return attentionSurfaceId ? { ...current, attentionSurfaceId } : current;
  }
  const preferred = activeSurfaceId && ids.has(activeSurfaceId)
    ? activeSurfaceId
    : current.selectedSurfaceId && ids.has(current.selectedSurfaceId)
      ? current.selectedSurfaceId
      : [...surfaces].sort((a, b) => b.updatedAt - a.updatedAt || a.surfaceId.localeCompare(b.surfaceId))[0]?.surfaceId ?? null;
  return { ...current, selectedSurfaceId: preferred, pinnedSurfaceId: null, attentionSurfaceId };
}

export function liveExecutionLayout(width: number): {
  mode: 'split' | 'drawer' | 'sheet';
  navigationWidth: number;
  liveWidth: number;
} {
  if (width < 600) return { mode: 'sheet', navigationWidth: 0, liveWidth: width };
  if (width < 1100) return { mode: 'drawer', navigationWidth: 72, liveWidth: Math.min(480, width) };
  return {
    mode: 'split', navigationWidth: width >= 1600 ? 236 : 220,
    liveWidth: Math.max(380, Math.min(600, Math.round(width * 0.36))),
  };
}
