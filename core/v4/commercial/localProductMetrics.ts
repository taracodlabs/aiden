/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AidenPaths } from '../paths';

export type LocalProductMilestone =
  | 'first_launch'
  | 'setup_completed'
  | 'first_successful_job'
  | 'first_browser_job'
  | 'first_coding_job'
  | 'first_app_connection';

export interface LocalProductMetricsSnapshot {
  version: 1;
  milestones: Partial<Record<LocalProductMilestone, string>>;
}

export class LocalProductMetrics {
  private readonly file: string;
  constructor(paths: AidenPaths, private readonly now: () => Date = () => new Date()) {
    this.file = path.join(paths.root, 'commercial', 'product-metrics.json');
  }

  async mark(milestone: LocalProductMilestone): Promise<LocalProductMetricsSnapshot> {
    const current = await this.snapshot();
    if (!current.milestones[milestone]) current.milestones[milestone] = this.now().toISOString();
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
    return current;
  }

  async snapshot(): Promise<LocalProductMetricsSnapshot> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as LocalProductMetricsSnapshot;
      return { version: 1, milestones: parsed.milestones ?? {} };
    } catch {
      return { version: 1, milestones: {} };
    }
  }
}

