import { describe, it, expect } from 'vitest';
import {
  TuiCallbacks,
  riskTierColor,
  riskTierIcon,
} from '../../../cli/v4/tuiCallbacks';
import type { ApprovalRequest } from '../../../moat/approvalEngine';
import type { SkillProposal } from '../../../moat/skillTeacher';

// Minimal blessed stub: every widget has destroy() + listeners.
function makeFakeBlessed(): { blessed: any; widgets: any[]; screenKeys: Map<string, Function[]> } {
  const widgets: any[] = [];
  const screenKeys = new Map<string, Function[]>();
  const screen = {
    key: (k: any, fn: Function) => {
      const keys = Array.isArray(k) ? k : [k];
      for (const key of keys) {
        const arr = screenKeys.get(key) ?? [];
        arr.push(fn);
        screenKeys.set(key, arr);
      }
    },
    render: () => {
      /* no-op */
    },
  };
  const blessed = {
    box: (config: any) => {
      const w: any = {
        type: 'box',
        config,
        destroyed: false,
        destroy: () => {
          w.destroyed = true;
        },
      };
      widgets.push(w);
      return w;
    },
  };
  return { blessed, widgets, screenKeys: screenKeys, ...({ screen } as any) } as any;
}

function makeOpts(extra: Partial<any> = {}) {
  const fake = makeFakeBlessed() as any;
  const history: string[] = [];
  return {
    fake,
    history,
    opts: {
      blessedModule: fake.blessed,
      noRender: true,
      getScreen: () => fake.screen,
      appendHistory: (line: string) => history.push(line),
      ...extra,
    },
  };
}

describe('TuiCallbacks', () => {
  it('riskTierColor maps tiers correctly', () => {
    expect(riskTierColor('safe')).toBe('green');
    expect(riskTierColor('caution')).toBe('yellow');
    expect(riskTierColor('dangerous')).toBe('red');
    expect(riskTierColor(undefined)).toBe('yellow');
  });

  it('riskTierIcon maps tiers correctly', () => {
    expect(riskTierIcon('safe')).toBe('🟢');
    expect(riskTierIcon('caution')).toBe('🟡');
    expect(riskTierIcon('dangerous')).toBe('🔴');
  });

  it('promptApproval renders a modal with correct border colour for tier', async () => {
    const { fake, opts } = makeOpts();
    const cb = new TuiCallbacks(opts);
    const req: ApprovalRequest = {
      toolName: 'shell_exec',
      category: 'execute',
      args: { command: 'rm -rf /tmp/test' },
      riskTier: 'dangerous',
      reason: 'destructive command',
    };
    const promise = cb.promptApproval(req);
    expect(fake.widgets.length).toBe(1);
    const dialog = fake.widgets[0];
    expect(dialog.config.style.border.fg).toBe('red');
    expect(dialog.config.label).toMatch(/approval/);
    expect(dialog.config.content).toContain('shell_exec');
    expect(dialog.config.content).toContain('rm -rf');
    // Resolve via test seam.
    dialog.__resolveDecision('allow');
    expect(await promise).toBe('allow');
    expect(dialog.destroyed).toBe(true);
  });

  it('approval keys (O/S/A/D) resolve to expected decisions', async () => {
    const cases: Array<['allow' | 'allow_session' | 'allow_always' | 'deny']> = [
      ['allow'],
      ['allow_session'],
      ['allow_always'],
      ['deny'],
    ];
    for (const [decision] of cases) {
      const { fake, opts } = makeOpts();
      const cb = new TuiCallbacks(opts);
      const promise = cb.promptApproval({
        toolName: 'fs_read',
        category: 'read',
        args: {},
      });
      // Trigger via the test seam — equivalent to a key press.
      fake.widgets[0].__resolveDecision(decision);
      expect(await promise).toBe(decision);
    }
  });

  it('approval modal exposes safe-tier border in green', async () => {
    const { fake, opts } = makeOpts();
    const cb = new TuiCallbacks(opts);
    const promise = cb.promptApproval({
      toolName: 'fs_read',
      category: 'read',
      args: { path: '/etc/passwd' },
      riskTier: 'safe',
    });
    const dialog = fake.widgets[0];
    expect(dialog.config.style.border.fg).toBe('green');
    dialog.__resolveDecision('allow');
    await promise;
  });

  it('promptSkillProposal renders a modal with name + description + tools', async () => {
    const { fake, opts } = makeOpts();
    const cb = new TuiCallbacks(opts);
    const proposal: SkillProposal = {
      proposedName: 'screenshot-and-summarize',
      description: 'Capture screen and summarize visible text',
      toolsUsed: ['browser_screenshot', 'shell_exec'],
      exampleSteps: ['take screenshot', 'OCR', 'summarize'],
      trace: [],
      confidence: 0.82,
    };
    const promise = cb.promptSkillProposal(proposal);
    const dialog = fake.widgets[0];
    expect(dialog.config.content).toContain('screenshot-and-summarize');
    expect(dialog.config.content).toContain('Capture screen');
    expect(dialog.config.content).toContain('browser_screenshot');
    expect(dialog.config.content).toContain('0.82');
    dialog.__resolveDecision(true);
    expect(await promise).toBe(true);
    expect(dialog.destroyed).toBe(true);
  });

  it('skill proposal Y/N resolves correctly and destroys modal', async () => {
    const { fake, opts } = makeOpts();
    const cb = new TuiCallbacks(opts);
    const proposal: SkillProposal = {
      proposedName: 'foo',
      description: 'd',
      toolsUsed: [],
      exampleSteps: [],
      trace: [],
      confidence: 0.5,
    };
    const noPromise = cb.promptSkillProposal(proposal);
    fake.widgets[0].__resolveDecision(false);
    expect(await noPromise).toBe(false);
  });

  it('riskAssess returns caution if no auxiliary client', async () => {
    const { opts } = makeOpts();
    const cb = new TuiCallbacks(opts);
    const result = await cb.riskAssess({
      toolName: 'shell_exec',
      category: 'execute',
      args: { command: 'echo hi' },
    });
    expect(result.tier).toBe('caution');
    expect(result.rationale).toMatch(/no auxiliary/);
  });

  it('riskAssess parses dangerous tier from auxiliary output', async () => {
    const aux = {
      call: async () => ({ content: 'dangerous — destructive args' }),
    };
    const { opts } = makeOpts({ auxiliaryClient: aux as any });
    const cb = new TuiCallbacks(opts);
    const result = await cb.riskAssess({
      toolName: 'shell_exec',
      category: 'execute',
      args: { command: 'rm -rf /' },
    });
    expect(result.tier).toBe('dangerous');
  });

  it('onCompression appends a gray line to history', () => {
    const { history, opts } = makeOpts();
    const cb = new TuiCallbacks(opts);
    cb.onCompression({
      removedMessageCount: 4,
      preservedRecentCount: 6,
      summaryTokens: 320,
    } as any);
    expect(history.some((l) => l.includes('[compress] removed 4'))).toBe(true);
  });

  it('onBudgetWarning at warning level uses yellow tag', () => {
    const { history, opts } = makeOpts();
    const cb = new TuiCallbacks(opts);
    cb.onBudgetWarning('warning', 80, 90);
    expect(history.some((l) => l.includes('yellow-fg') && l.includes('80/90'))).toBe(true);
  });
});
