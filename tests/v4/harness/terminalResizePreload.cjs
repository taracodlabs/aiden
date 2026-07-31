/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Windows node-pty resizes its ConPTY host without updating the child Node
 * process's stdout dimensions. Focused resize tests use a private size file
 * to deliver the dimensions and event exposed by a physical console host.
 */
'use strict';

const fs = require('node:fs');

const sizeFile = process.env.AIDEN_TEST_TERMINAL_SIZE_FILE;
if (sizeFile) {
  let columns = process.stdout.columns;
  let rows = process.stdout.rows;

  const readSize = () => {
    let next;
    try {
      next = JSON.parse(fs.readFileSync(sizeFile, 'utf8'));
    } catch {
      return false;
    }
    if (!Number.isInteger(next.columns) || next.columns < 1
      || !Number.isInteger(next.rows) || next.rows < 1) return false;
    if (columns === next.columns && rows === next.rows) return false;
    columns = next.columns;
    rows = next.rows;
    return true;
  };

  readSize();
  Object.defineProperties(process.stdout, {
    columns: { configurable: true, get: () => columns, set: () => undefined },
    rows: { configurable: true, get: () => rows, set: () => undefined },
  });

  const originalEmit = process.stdout.emit;
  let emittedColumns = columns;
  let emittedRows = rows;
  process.stdout.emit = function emit(event, ...args) {
    if (event === 'resize') {
      if (columns === emittedColumns && rows === emittedRows) return false;
      emittedColumns = columns;
      emittedRows = rows;
    }
    return originalEmit.call(this, event, ...args);
  };

  const listener = () => {
    if (readSize()) process.stdout.emit('resize');
  };
  fs.watchFile(sizeFile, { interval: 20, persistent: false }, listener);
  process.once('exit', () => fs.unwatchFile(sizeFile, listener));
}
