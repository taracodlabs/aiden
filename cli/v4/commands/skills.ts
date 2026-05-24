/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/skills.ts — Phase 14b
 *
 * `/skills [list|view <name>|install <id>]` — minimal CLI surface to
 * Phase 10's SkillLoader + Phase 14a's SkillsHub. Default subcommand: list.
 */
import { promises as fsp, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import type { SlashCommand } from '../commandRegistry';
import { renderTable } from '../table';
import { CandidateStore } from '../../../core/v4/skillMining/candidateStore';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { parseSkillContent } from '../../../core/v4/skillSpec';
// v4.9.5 Slice 1 — static import (vitest CJS resolver doesn't auto-
// resolve `.ts` files via lazy require — same v4.9.3 Slice 1b lesson).
import { runCuratedSetupFlow } from '../skills/curatedSetupFlow';

export const skills: SlashCommand = {
  name: 'skills',
  description: 'List, view, or install skills.',
  category: 'system',
  icon: '⚡',
  handler: async (ctx) => {
    const sub = (ctx.args[0] ?? 'list').toLowerCase();
    if (sub === 'list') {
      if (!ctx.skillLoader) {
        ctx.display.warn('Skill loader not wired.');
        return {};
      }
      const skills = await ctx.skillLoader.list();
      // v4.9.5 Slice 1 — Author column added between Name and
      // Description so attribution is visible at-a-glance. The
      // "(uncredited)" marker fires when a community-trust skill
      // omits the `author` frontmatter field. Builtin skills (Aiden's
      // own bundled skills) show "(builtin)" in muted — they're
      // self-attributed via the package LICENSE so no per-skill author
      // is meaningful.
      const authorFor = (s: { author?: string; trustLevel?: string }): string => {
        if (s.author && s.author.trim().length > 0) return s.author;
        return s.trustLevel === 'builtin' ? '(builtin)' : '(uncredited)';
      };
      ctx.display.write(
        renderTable(
          skills.map((s) => ({
            name:        s.name,
            author:      authorFor(s),
            description: s.description ?? '',
          })),
          [
            { key: 'name',        header: 'Name',        align: 'left', minWidth: 16 },
            { key: 'author',      header: 'Author',      align: 'left', minWidth: 14,
              color: (_v, row) => {
                const a = (row as { author: string }).author;
                if (a === '(uncredited)') return 'warn';
                if (a === '(builtin)')    return 'muted';
                return undefined;
              } },
            { key: 'description', header: 'Description', align: 'left', flex: true },
          ],
          {
            title:        'Skills',
            totalCount:   `${skills.length} installed`,
            emptyMessage: 'no skills installed',
          },
        ),
      );
      return {};
    }

    // v4.9.5 Slice 1 — /skills setup. Re-invokes the curated install
    // flow used by the onboarding wizard. Per Phase B Q3 (cut #2):
    // ships additive — installs missing skills, no reconciliation /
    // update semantics (those land in v4.10's /skills update).
    if (sub === 'setup') {
      if (!ctx.skillsHub) {
        ctx.display.warn('SkillsHub not wired.');
        return {};
      }
      // v4.9.5 Slice 1.5 — the flow now drives its own three-tier
      // prompt + checkbox picker via ctx.prompt (raw text input),
      // not ctx.confirm. The chat-session promptApi exposes
      // readLine via ctx.prompt; we adapt it to the input(msg)
      // shape CuratedSetupPrompts expects.
      if (!ctx.prompt) {
        ctx.display.printError('Cannot prompt in this context.');
        return {};
      }
      await runCuratedSetupFlow({
        hub:     ctx.skillsHub,
        display: {
          write:      (s) => ctx.display.write(s),
          dim:        (s) => ctx.display.dim(s),
          warn:       (s) => ctx.display.warn(s),
          success:    (s) => ctx.display.success(s),
          printError: (s, hint) => ctx.display.printError(s, hint),
          paint:      (s, kind) => ctx.display.paint(s, kind),
        },
        prompts: {
          input: (msg) => ctx.prompt!(msg),
        },
      });
      return {};
    }
    if (sub === 'view') {
      const name = ctx.args[1];
      if (!name) {
        ctx.display.printError('Usage: /skills view <name>');
        return {};
      }
      if (!ctx.skillLoader) {
        ctx.display.warn('Skill loader not wired.');
        return {};
      }
      const parsed = await ctx.skillLoader.load(name);
      if (!parsed) {
        ctx.display.printError(`Skill '${name}' not found.`);
        return {};
      }
      ctx.display.info(`${parsed.frontmatter.name} v${parsed.frontmatter.version}`);
      ctx.display.dim(parsed.frontmatter.description ?? '(no description)');
      ctx.display.write('\n');
      ctx.display.write(parsed.body.slice(0, 1200));
      if (parsed.body.length > 1200) ctx.display.dim('… (truncated)');
      ctx.display.write('\n');
      return {};
    }
    if (sub === 'install') {
      const id = ctx.args.slice(1).join(' ').trim();
      if (!id) {
        ctx.display.printError('Usage: /skills install <identifier>');
        return {};
      }
      if (!ctx.skillsHub) {
        ctx.display.warn('SkillsHub not wired.');
        return {};
      }
      const spinner = ctx.display.startSpinner(`Installing ${id}…`);
      const res = await ctx.skillsHub.install(id);
      spinner.stop();
      if (res.ok) {
        ctx.display.success(`Installed at ${res.installPath ?? '(?)'}`);
      } else {
        ctx.display.printError(`Install failed: ${res.reason ?? 'unknown'}`);
      }
      return {};
    }

    // ── Phase v4.1-skill-mining ──────────────────────────────────
    // /skills review              — list pending mined candidates
    // /skills view-candidate <id> — preview a candidate's SKILL.md
    // /skills accept <id>         — promote candidate to live skill
    // /skills reject <id> [reason]— record rejection (dedup-aware)
    // /skills propose             — explanation of the mining hook
    const store = new CandidateStore();

    if (sub === 'review') {
      const candidates = await store.list();
      ctx.display.write(
        renderTable(
          candidates.map((c) => {
            let name = '(unparsed)';
            let description = '';
            try {
              const parsed = parseSkillContent(c.skillContent);
              name = parsed.frontmatter.name ?? name;
              description = parsed.frontmatter.description ?? '';
            } catch { /* fall through to defaults */ }
            return {
              id:         c.id.slice(0, 8),
              name,
              confidence: c.candidateConfidence.toFixed(2),
              session:    c.sourceSessionId.slice(0, 8),
              created:    c.createdAt.slice(0, 19).replace('T', ' '),
              description,
            };
          }),
          [
            { key: 'id',          header: 'ID',          align: 'left'  },
            { key: 'name',        header: 'Name',        align: 'left'  },
            { key: 'confidence',  header: 'Conf',        align: 'right' },
            { key: 'session',     header: 'Session',     align: 'left'  },
            { key: 'created',     header: 'Created',     align: 'left'  },
            { key: 'description', header: 'Description', align: 'left', flex: true },
          ],
          {
            title:        'Pending skill candidates',
            totalCount:   `${candidates.length} pending`,
            emptyMessage: 'no pending candidates — mined skills appear here after a successful 3+ tool turn',
          },
        ),
      );
      if (candidates.length === 0) return {};
      ctx.display.dim('Use `/skills view-candidate <id-prefix>` to preview, `/skills accept <id>` to promote, `/skills reject <id> [reason]` to dismiss.');
      return {};
    }

    if (sub === 'view-candidate') {
      const idPrefix = ctx.args[1];
      if (!idPrefix) {
        ctx.display.printError('Usage: /skills view-candidate <id>');
        return {};
      }
      const all = await store.list();
      const match = all.find((c) => c.id.startsWith(idPrefix));
      if (!match) {
        ctx.display.printError(`No candidate matches id prefix '${idPrefix}'.`);
        return {};
      }
      ctx.display.info(`Candidate ${match.id} (confidence ${match.candidateConfidence.toFixed(2)}):`);
      ctx.display.write('\n');
      ctx.display.write(match.skillContent);
      ctx.display.write('\n');
      return {};
    }

    if (sub === 'accept') {
      const idPrefix = ctx.args[1];
      if (!idPrefix) {
        ctx.display.printError('Usage: /skills accept <id>');
        return {};
      }
      const all = await store.list();
      const match = all.find((c) => c.id.startsWith(idPrefix));
      if (!match) {
        ctx.display.printError(`No candidate matches id prefix '${idPrefix}'.`);
        return {};
      }
      let parsed;
      try {
        parsed = parseSkillContent(match.skillContent);
      } catch (err) {
        ctx.display.printError(`Candidate did not round-trip through the parser: ${(err as Error).message}`);
        return {};
      }
      const skillName = parsed.frontmatter.name;
      if (!skillName) {
        ctx.display.printError('Candidate missing required `name` frontmatter field.');
        return {};
      }
      const paths = resolveAidenPaths();
      const targetDir = path.join(paths.skillsDir, skillName);
      if (!existsSync(paths.skillsDir)) mkdirSync(paths.skillsDir, { recursive: true });
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
      const targetFile = path.join(targetDir, 'SKILL.md');
      try {
        await fsp.writeFile(targetFile, match.skillContent, 'utf8');
      } catch (err) {
        ctx.display.printError(`Failed to write skill: ${(err as Error).message}`);
        return {};
      }
      await store.remove(match.id);
      // Invalidate the loader cache so the new skill is visible
      // on the next /skills list call without a session restart.
      try {
        ctx.skillLoader?.invalidate?.();
      } catch { /* best-effort */ }
      ctx.display.success(`Promoted '${skillName}' to ${targetFile}.`);
      return {};
    }

    if (sub === 'reject') {
      const idPrefix = ctx.args[1];
      if (!idPrefix) {
        ctx.display.printError('Usage: /skills reject <id> [reason]');
        return {};
      }
      const reason = ctx.args.slice(2).join(' ').trim() || undefined;
      const all = await store.list();
      const match = all.find((c) => c.id.startsWith(idPrefix));
      if (!match) {
        ctx.display.printError(`No candidate matches id prefix '${idPrefix}'.`);
        return {};
      }
      await store.recordRejection(match.fingerprint, reason);
      await store.remove(match.id);
      ctx.display.success(
        `Rejected candidate '${match.id.slice(0, 8)}'.` +
        (reason ? ` Reason recorded: "${reason}"` : ''),
      );
      return {};
    }

    if (sub === 'propose') {
      // Manual mining fires automatically post-turn via aidenAgent;
      // this subcommand surfaces what's currently pending so the
      // user understands the hook without needing to remember
      // /skills review.
      const candidates = await store.list();
      ctx.display.info(`Skill mining is active — successful 3+ tool turns auto-stage candidates.`);
      ctx.display.dim(`Pending: ${candidates.length}. Run /skills review to inspect.`);
      return {};
    }

    ctx.display.printError(
      `Unknown subcommand: ${sub}`,
      'Try: /skills list | view <name> | install <id> | review | view-candidate <id> | accept <id> | reject <id> [reason] | propose',
    );
    return {};
  },
};
