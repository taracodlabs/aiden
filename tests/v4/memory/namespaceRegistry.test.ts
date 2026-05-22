/**
 * tests/v4/memory/namespaceRegistry.test.ts — v4.9.0 Slice 11.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getNamespace, hasNamespace, listNamespaces, listNamespaceNames,
  registerNamespace, _resetNamespacesForTests,
} from '../../../core/v4/memory/namespaceRegistry';

beforeEach(() => { _resetNamespacesForTests(); });

describe('namespaceRegistry — Slice 11', () => {
  it('ships 3 built-in namespaces in order', () => {
    expect(listNamespaceNames()).toEqual(['memory', 'user', 'project']);
  });

  it('built-in char limits match design', () => {
    expect(getNamespace('memory').charLimit).toBe(2200);
    expect(getNamespace('user').charLimit).toBe(1375);
    expect(getNamespace('project').charLimit).toBe(1800);
  });

  it('project namespace requires a root', () => {
    expect(getNamespace('project').requiresProject).toBe(true);
    expect(getNamespace('memory').requiresProject).toBeFalsy();
  });

  it('all 3 default to injectIntoPrompt', () => {
    for (const ns of listNamespaces()) {
      expect(ns.injectIntoPrompt).toBe(true);
    }
  });

  it('hasNamespace + getNamespace agree', () => {
    expect(hasNamespace('memory')).toBe(true);
    expect(hasNamespace('frobnitz')).toBe(false);
    expect(() => getNamespace('frobnitz')).toThrow(/unknown memory namespace/);
  });

  it('project.resolve throws without projectRoot', () => {
    const ns = getNamespace('project');
    expect(() => ns.resolve({} as never, null)).toThrow(/requires a project root/);
  });

  it('project.resolve composes path under .aiden/PROJECT.md', () => {
    const p = getNamespace('project').resolve({} as never, '/tmp/myproj');
    expect(p).toMatch(/myproj[\\/]\.aiden[\\/]PROJECT\.md$/);
  });

  it('registerNamespace adds a new entry; duplicate registration throws', () => {
    registerNamespace({
      name: 'workspace', label: 'Workspace', description: 'test', charLimit: 500,
      injectIntoPrompt: false, resolve: () => '/tmp/ws.md',
    });
    expect(hasNamespace('workspace')).toBe(true);
    expect(() => registerNamespace({
      name: 'workspace', label: '', description: '', charLimit: 1,
      injectIntoPrompt: false, resolve: () => '',
    })).toThrow(/already registered/);
  });

  it('_resetNamespacesForTests restores the 3 built-ins', () => {
    registerNamespace({
      name: 'extra', label: '', description: '', charLimit: 1,
      injectIntoPrompt: false, resolve: () => '',
    });
    expect(listNamespaceNames()).toContain('extra');
    _resetNamespacesForTests();
    expect(listNamespaceNames()).toEqual(['memory', 'user', 'project']);
  });
});
