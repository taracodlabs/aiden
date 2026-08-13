/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 B1.1 — a11y snapshot semantics + ElementLease store.
 * The in-page DOM walk (pwAxSnapshot) is live-smoked against a real page
 * (layout/visibility/cross-origin can't be faithfully unit-tested in jsdom);
 * these tests cover the TS semantics: role mapping, accessible-name precedence,
 * @eN assignment, full lease population, store refresh, and frame-grouped output.
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { resolveBrowserProfileDirectory } from '../../../core/playwrightBridge';
import {
  axRoleFor,
  accessibleName,
  LeaseStore,
  getLeaseStore,
  formatAxSnapshot,
  projectStructuredForms,
  sha256Hex,
  type AxRawDescriptor,
} from '../../../core/v4/browserState';

function desc(over: Partial<AxRawDescriptor> = {}): AxRawDescriptor {
  return {
    tag: 'button', roleAttr: '', inputType: '', ariaLabel: '', labelledByText: '',
    textContent: '', placeholder: '', alt: '', title: '',
    css_path: 'button:nth-of-type(1)', bbox: { x: 0, y: 0, w: 10, h: 10 }, frame_id: 'main', submit: false,
    ...over,
  };
}

describe('browser profile isolation', () => {
  it('keeps the persistent browser profile inside the isolated Aiden home', () => {
    expect(resolveBrowserProfileDirectory({ AIDEN_HOME: 'C:\\isolated-aiden' })).toBe(
      path.resolve('C:\\isolated-aiden', 'browser-profile'),
    );
  });

  it('honours an explicit browser-profile directory', () => {
    expect(resolveBrowserProfileDirectory({
      AIDEN_HOME: 'C:\\isolated-aiden',
      AIDEN_BROWSER_PROFILE_DIR: 'C:\\disposable-browser-profile',
    })).toBe(path.resolve('C:\\disposable-browser-profile'));
  });
});

describe('axRoleFor — role mapping', () => {
  it('explicit role attr wins', () => {
    expect(axRoleFor({ tag: 'div', roleAttr: 'tab', inputType: '' })).toBe('tab');
  });
  it('maps by tag/type when no role attr', () => {
    expect(axRoleFor({ tag: 'a', roleAttr: '', inputType: '' })).toBe('link');
    expect(axRoleFor({ tag: 'button', roleAttr: '', inputType: '' })).toBe('button');
    expect(axRoleFor({ tag: 'select', roleAttr: '', inputType: '' })).toBe('combobox');
    expect(axRoleFor({ tag: 'textarea', roleAttr: '', inputType: '' })).toBe('textbox');
    expect(axRoleFor({ tag: 'input', roleAttr: '', inputType: 'text' })).toBe('textbox');
    expect(axRoleFor({ tag: 'input', roleAttr: '', inputType: 'checkbox' })).toBe('checkbox');
    expect(axRoleFor({ tag: 'input', roleAttr: '', inputType: 'radio' })).toBe('radio');
    expect(axRoleFor({ tag: 'input', roleAttr: '', inputType: 'submit' })).toBe('button');
    expect(axRoleFor({ tag: 'span', roleAttr: '', inputType: '' })).toBe('generic');
  });
});

describe('structured form projection', () => {
  it('projects bounded field state and keeps password values redacted', () => {
    const store = new LeaseStore();
    const leases = store.refresh(9, 'https://form.example.test', [
      desc({
        tag: 'input', inputType: 'email', ariaLabel: 'Email', formId: 'profile',
        required: true, value: 'user@example.test', autocomplete: 'email',
      }),
      desc({
        tag: 'input', inputType: 'password', ariaLabel: 'Password', formId: 'profile',
        value: 'must-not-appear', autocomplete: 'current-password',
      }),
      desc({
        tag: 'select', ariaLabel: 'Country', formId: 'profile', value: 'ee',
        options: [
          { value: 'in', label: 'India', selected: false },
          { value: 'ee', label: 'Estonia', selected: true },
        ],
      }),
      desc({ tag: 'button', textContent: 'Save', formId: 'profile', submit: true }),
    ]);
    const projected = projectStructuredForms(leases);
    expect(projected).toEqual([{
      formId: 'profile',
      fields: [
        expect.objectContaining({ ref: '@e1', type: 'email', required: true, value: 'user@example.test' }),
        expect.objectContaining({ ref: '@e2', type: 'password', value: '' }),
        expect.objectContaining({ ref: '@e3', type: 'select', options: [
          { value: 'in', label: 'India', selected: false },
          { value: 'ee', label: 'Estonia', selected: true },
        ] }),
      ],
      submitRefs: ['@e4'],
    }]);
    expect(JSON.stringify(projected)).not.toContain('must-not-appear');
  });
});

describe('accessibleName — precedence chain', () => {
  it('aria-label → labelledby → textContent → placeholder → alt → title', () => {
    expect(accessibleName({ ariaLabel: 'Aria', labelledByText: 'LB', textContent: 'T', placeholder: 'P', alt: 'A', title: 'Ti' })).toBe('Aria');
    expect(accessibleName({ ariaLabel: '', labelledByText: 'LB', textContent: 'T', placeholder: 'P', alt: 'A', title: 'Ti' })).toBe('LB');
    expect(accessibleName({ ariaLabel: '', labelledByText: '', textContent: 'T', placeholder: 'P', alt: 'A', title: 'Ti' })).toBe('T');
    expect(accessibleName({ ariaLabel: '', labelledByText: '', textContent: '', placeholder: 'P', alt: 'A', title: 'Ti' })).toBe('P');
    expect(accessibleName({ ariaLabel: '', labelledByText: '', textContent: '', placeholder: '', alt: 'A', title: 'Ti' })).toBe('A');
    expect(accessibleName({ ariaLabel: '', labelledByText: '', textContent: '', placeholder: '', alt: '', title: 'Ti' })).toBe('Ti');
    expect(accessibleName({ ariaLabel: '', labelledByText: '', textContent: '', placeholder: '', alt: '', title: '' })).toBe('');
  });
  it('collapses whitespace and caps length', () => {
    expect(accessibleName({ textContent: '  Sign\n   in  ' } as never)).toBe('Sign in');
    expect(accessibleName({ textContent: 'x'.repeat(500) } as never).length).toBe(200);
  });
});

describe('LeaseStore — @eN assignment + full lease population', () => {
  it('assigns @e1…@eN in order and populates every ElementLease field', () => {
    const store = new LeaseStore();
    const leases = store.refresh(1000, 'https://ex.com/page', [
      desc({ tag: 'button', textContent: 'Sign in', css_path: '#login', bbox: { x: 1, y: 2, w: 3, h: 4 } }),
      desc({ tag: 'input', inputType: 'text', placeholder: 'Email', frame_id: 'main' }),
    ]);
    expect(leases.map((l) => l.ref)).toEqual(['@e1', '@e2']);
    expect(leases[0]).toEqual({
      ref: '@e1', snapshot_id: 1000, url: 'https://ex.com/page', frame_id: 'main',
      role: 'button', name: 'Sign in', css_path: '#login', bbox: { x: 1, y: 2, w: 3, h: 4 },
      visible_text_hash: sha256Hex('Sign in'), submit: false,
    });
    expect(leases[1].role).toBe('textbox');
    expect(leases[1].name).toBe('Email'); // placeholder fallback
  });

  it('get(ref) resolves; all() returns the set; currentSnapshotId tracks', () => {
    const store = new LeaseStore();
    store.refresh(7, 'u', [desc({ textContent: 'A' })]);
    expect(store.get('@e1')?.name).toBe('A');
    expect(store.get('@e9')).toBeUndefined();
    expect(store.all().length).toBe(1);
    expect(store.currentSnapshotId).toBe(7);
  });

  it('refresh REPLACES the prior snapshot (refs reassigned, old cleared)', () => {
    const store = new LeaseStore();
    store.refresh(1, 'u1', [desc({ textContent: 'old1' }), desc({ textContent: 'old2' })]);
    store.refresh(2, 'u2', [desc({ textContent: 'new1' })]);
    expect(store.all().length).toBe(1);
    expect(store.get('@e1')?.name).toBe('new1');
    expect(store.get('@e2')).toBeUndefined(); // gone after refresh
    expect(store.currentSnapshotId).toBe(2);
  });

  it('getLeaseStore() is a process-wide singleton', () => {
    expect(getLeaseStore()).toBe(getLeaseStore());
  });
});

describe('formatAxSnapshot — grouped by frame', () => {
  it('groups refs under their frame with role + quoted name', () => {
    const store = new LeaseStore();
    const leases = store.refresh(1, 'u', [
      desc({ tag: 'button', textContent: 'Sign in', frame_id: 'main' }),
      desc({ tag: 'input', inputType: 'text', placeholder: 'Email', frame_id: 'main' }),
      desc({ tag: 'a', roleAttr: '', textContent: 'Help', frame_id: 'frame-1' }),
    ]);
    const out = formatAxSnapshot(leases);
    expect(out).toContain('main:');
    expect(out).toContain('  @e1 button "Sign in"');
    expect(out).toContain('  @e2 textbox "Email"');
    expect(out).toContain('frame-1:');
    expect(out).toContain('  @e3 link "Help"');
  });
  it('(no name) for nameless elements; empty → friendly message', () => {
    const store = new LeaseStore();
    expect(formatAxSnapshot(store.refresh(1, 'u', [desc({ tag: 'button' })]))).toContain('@e1 button (no name)');
    expect(formatAxSnapshot([])).toContain('No interactive elements');
  });
});
