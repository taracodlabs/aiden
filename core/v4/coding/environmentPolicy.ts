/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import path from 'node:path';

export class ExternalCodingEnvironmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ExternalCodingEnvironmentError';
  }
}

export interface ExternalCodingEnvironmentRequest {
  platform?: NodeJS.Platform;
  source: NodeJS.ProcessEnv;
  sessionHome: string;
  sessionTemp: string;
  approved?: Readonly<Record<string, string>>;
  approvedKeys?: readonly string[];
}

const WINDOWS_SYSTEM_KEYS = new Set([
  'path', 'systemroot', 'windir', 'comspec', 'pathext', 'os',
  'processor_architecture', 'number_of_processors',
]);
const POSIX_SYSTEM_KEYS = new Set(['path', 'lang', 'lc_all', 'lc_ctype', 'term', 'colorterm']);
const RESERVED_KEYS = new Set([
  'home', 'userprofile', 'temp', 'tmp', 'tmpdir', 'appdata', 'localappdata',
]);

function find(source: NodeJS.ProcessEnv, key: string): string | undefined {
  const actual = Object.keys(source).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return actual ? source[actual] : undefined;
}

function outputKey(key: string): string {
  const normalized = key.toLowerCase();
  const preferred: Record<string, string> = {
    path: 'PATH', systemroot: 'SystemRoot', windir: 'WINDIR', comspec: 'COMSPEC',
    pathext: 'PATHEXT', os: 'OS', processor_architecture: 'PROCESSOR_ARCHITECTURE',
    number_of_processors: 'NUMBER_OF_PROCESSORS', lang: 'LANG', lc_all: 'LC_ALL',
    lc_ctype: 'LC_CTYPE', term: 'TERM', colorterm: 'COLORTERM',
  };
  return preferred[normalized] ?? key;
}

/** Build a fresh allowlisted environment; never spread the ambient process environment. */
export function createExternalCodingEnvironment(request: ExternalCodingEnvironmentRequest): Record<string, string> {
  const platform = request.platform ?? process.platform;
  const sessionHome = path.resolve(request.sessionHome);
  const sessionTemp = path.resolve(request.sessionTemp);
  if (!path.isAbsolute(sessionHome) || !path.isAbsolute(sessionTemp)) {
    throw new ExternalCodingEnvironmentError('INVALID_SESSION_PATH', 'Coding HOME and temporary directory must be absolute');
  }
  const environment: Record<string, string> = {};
  const systemKeys = platform === 'win32' ? WINDOWS_SYSTEM_KEYS : POSIX_SYSTEM_KEYS;
  for (const key of systemKeys) {
    const value = find(request.source, key);
    if (value !== undefined && value !== '') environment[outputKey(key)] = value;
  }
  environment.HOME = sessionHome;
  environment.USERPROFILE = sessionHome;
  environment.TEMP = sessionTemp;
  environment.TMP = sessionTemp;
  if (platform === 'win32') {
    environment.APPDATA = path.join(sessionHome, 'AppData', 'Roaming');
    environment.LOCALAPPDATA = path.join(sessionHome, 'AppData', 'Local');
  } else {
    environment.TMPDIR = sessionTemp;
  }

  const allowed = new Set((request.approvedKeys ?? []).map((key) => key.toLowerCase()));
  for (const [key, value] of Object.entries(request.approved ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) {
      throw new ExternalCodingEnvironmentError('INVALID_ENVIRONMENT_KEY', `Invalid approved environment key: ${key}`);
    }
    const normalized = key.toLowerCase();
    if (!allowed.has(normalized)) {
      throw new ExternalCodingEnvironmentError('UNDECLARED_ENVIRONMENT_KEY', `Approved environment key was not declared: ${key}`);
    }
    if (RESERVED_KEYS.has(normalized) || systemKeys.has(normalized)) {
      throw new ExternalCodingEnvironmentError('RESERVED_ENVIRONMENT_KEY', `Coding environment key is reserved: ${key}`);
    }
    environment[key] = value;
  }
  return environment;
}
