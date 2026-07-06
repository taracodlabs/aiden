import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { fileReadTool } from '../../../tools/v4/files/fileRead';
import { fileListTool } from '../../../tools/v4/files/fileList';
import { fileWriteTool } from '../../../tools/v4/files/fileWrite';
import { filePatchTool } from '../../../tools/v4/files/filePatch';
import { fileDeleteTool } from '../../../tools/v4/files/fileDelete';
import { fileMoveTool } from '../../../tools/v4/files/fileMove';
import { fileCopyTool } from '../../../tools/v4/files/fileCopy';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

let tmp: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-files-tool-'));
  ctx = {
    cwd: tmp,
    paths: resolveAidenPaths({ rootOverride: path.join(tmp, '.aiden') }),
  };
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('file tools — schemas', () => {
  it('1. file_read schema requires path', () => {
    expect(fileReadTool.schema.name).toBe('file_read');
    expect(fileReadTool.schema.inputSchema.required).toEqual(['path']);
    expect(fileReadTool.toolset).toBe('files');
    expect(fileReadTool.mutates).toBe(false);
    expect(fileReadTool.category).toBe('read');
  });

  it('2. file_list schema is path-optional', () => {
    expect(fileListTool.schema.name).toBe('file_list');
    expect(fileListTool.schema.inputSchema.required).toBeUndefined();
    expect(fileListTool.mutates).toBe(false);
  });
});

describe('file_read', () => {
  it('3. reads a file relative to ctx.cwd', async () => {
    await fs.writeFile(path.join(tmp, 'hello.txt'), 'world');
    const result = (await fileReadTool.execute({ path: 'hello.txt' }, ctx)) as {
      success: boolean;
      content: string;
    };
    expect(result.success).toBe(true);
    expect(result.content).toBe('world');
  });

  it('4. truncates content to 5000 chars and reports truncated=true', async () => {
    const big = 'x'.repeat(10_000);
    await fs.writeFile(path.join(tmp, 'big.txt'), big);
    const result = (await fileReadTool.execute({ path: 'big.txt' }, ctx)) as {
      success: boolean;
      content: string;
      truncated: boolean;
      size: number;
    };
    expect(result.success).toBe(true);
    expect(result.content.length).toBe(5000);
    expect(result.truncated).toBe(true);
    expect(result.size).toBe(10_000);
  });

  it('5. blocks denied paths (.ssh, .pem, credentials)', async () => {
    const denied = (
      await Promise.all(
        [
          path.join(tmp, '.ssh', 'id_rsa'),
          path.join(tmp, 'host.pem'),
          path.join(tmp, 'aws-credentials.json'),
        ].map(async (p) => {
          const result = await fileReadTool.execute({ path: p }, ctx);
          return result;
        }),
      )
    ) as { success: boolean; error: string }[];
    for (const r of denied) {
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/protected/i);
    }
  });

  it('6. returns error result for missing file', async () => {
    const result = (await fileReadTool.execute(
      { path: 'does-not-exist.txt' },
      ctx,
    )) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ENOENT|no such file/i);
  });

  it('7. requires a path argument', async () => {
    const result = (await fileReadTool.execute({}, ctx)) as {
      success: boolean;
      error: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no path/i);
  });
});

describe('file_list', () => {
  it('8. lists entries with type discrimination', async () => {
    await fs.writeFile(path.join(tmp, 'a.txt'), '');
    await fs.mkdir(path.join(tmp, 'subdir'));
    const result = (await fileListTool.execute({ path: tmp }, ctx)) as {
      success: boolean;
      entries: { name: string; type: string }[];
    };
    expect(result.success).toBe(true);
    const names = result.entries.map((e) => e.name).sort();
    expect(names).toEqual(['a.txt', 'subdir']);
    const a = result.entries.find((e) => e.name === 'a.txt');
    const sub = result.entries.find((e) => e.name === 'subdir');
    expect(a?.type).toBe('file');
    expect(sub?.type).toBe('dir');
  });

  it('9. defaults to ctx.cwd when path is omitted', async () => {
    await fs.writeFile(path.join(tmp, 'only.txt'), '');
    const result = (await fileListTool.execute({}, ctx)) as {
      success: boolean;
      entries: { name: string }[];
    };
    expect(result.success).toBe(true);
    expect(result.entries.map((e) => e.name)).toContain('only.txt');
  });

  it('10. returns error for missing dir', async () => {
    const result = (await fileListTool.execute(
      { path: path.join(tmp, 'nope') },
      ctx,
    )) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ENOENT|no such/i);
  });
});

describe('file_write', () => {
  it('11. creates a new file', async () => {
    const target = path.join(tmp, 'new.txt');
    const r = (await fileWriteTool.execute(
      { path: target, content: 'hello' },
      ctx,
    )) as { success: boolean };
    expect(r.success).toBe(true);
    expect(await fs.readFile(target, 'utf-8')).toBe('hello');
  });

  it('12. overwrites an existing file', async () => {
    const target = path.join(tmp, 'over.txt');
    await fs.writeFile(target, 'OLD');
    const r = (await fileWriteTool.execute(
      { path: target, content: 'NEW' },
      ctx,
    )) as { success: boolean };
    expect(r.success).toBe(true);
    expect(await fs.readFile(target, 'utf-8')).toBe('NEW');
  });

  it('13. creates parent dirs', async () => {
    const target = path.join(tmp, 'a', 'b', 'c', 'deep.txt');
    const r = (await fileWriteTool.execute(
      { path: target, content: 'x' },
      ctx,
    )) as { success: boolean };
    expect(r.success).toBe(true);
    expect(await fs.readFile(target, 'utf-8')).toBe('x');
  });

  it('14. blocks protected paths', async () => {
    const r = (await fileWriteTool.execute(
      { path: path.join(tmp, '.ssh', 'id_rsa'), content: 'pwn' },
      ctx,
    )) as { success: boolean; error: string };
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/protected/i);
  });

  it('15. is registered as a write/mutating tool', () => {
    expect(fileWriteTool.category).toBe('write');
    expect(fileWriteTool.mutates).toBe(true);
    expect(fileWriteTool.toolset).toBe('files');
  });
});

describe('file_patch', () => {
  it('16. applies a unique replacement', async () => {
    const target = path.join(tmp, 'p.txt');
    await fs.writeFile(target, 'hello world');
    const r = (await filePatchTool.execute(
      { path: target, find: 'world', replace: 'aiden' },
      ctx,
    )) as { success: boolean; replacements: number };
    expect(r.success).toBe(true);
    expect(r.replacements).toBe(1);
    expect(await fs.readFile(target, 'utf-8')).toBe('hello aiden');
  });

  it('17. fails cleanly on no match', async () => {
    const target = path.join(tmp, 'p2.txt');
    await fs.writeFile(target, 'hello');
    const r = (await filePatchTool.execute(
      { path: target, find: 'WORLD', replace: 'aiden' },
      ctx,
    )) as { success: boolean; error: string };
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  it('18. refuses ambiguous match without replace_all', async () => {
    const target = path.join(tmp, 'p3.txt');
    await fs.writeFile(target, 'a a a');
    const r = (await filePatchTool.execute(
      { path: target, find: 'a', replace: 'b' },
      ctx,
    )) as { success: boolean; error: string };
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not unique/i);
  });

  it('19. honors replace_all=true', async () => {
    const target = path.join(tmp, 'p4.txt');
    await fs.writeFile(target, 'a a a');
    const r = (await filePatchTool.execute(
      { path: target, find: 'a', replace: 'b', replace_all: true },
      ctx,
    )) as { success: boolean; replacements: number };
    expect(r.success).toBe(true);
    expect(r.replacements).toBe(3);
    expect(await fs.readFile(target, 'utf-8')).toBe('b b b');
  });
});

describe('verified writes — file_write + file_patch route through writeFileVerified', () => {
  it('file_write returns verified:true with the ACTUAL on-disk byte length', async () => {
    const target = path.join(tmp, 'verified.txt');
    const content = 'verified content — ✓';
    const r = (await fileWriteTool.execute({ path: target, content }, ctx)) as {
      success: boolean; verified?: boolean; bytes?: number;
    };
    expect(r.success).toBe(true);
    expect(r.verified).toBe(true);                                  // only the helper sets this
    expect(r.bytes).toBe(Buffer.byteLength(content, 'utf-8'));
    expect(r.bytes).toBe((await fs.stat(target)).size);            // matches disk exactly
  });

  it('file_patch returns verified:true with the on-disk byte length after the edit', async () => {
    const target = path.join(tmp, 'patched.txt');
    await fs.writeFile(target, 'the OLD value stays');
    const r = (await filePatchTool.execute(
      { path: target, find: 'OLD', replace: 'NEW-and-longer' },
      ctx,
    )) as { success: boolean; verified?: boolean; bytes?: number; replacements?: number };
    expect(r.success).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.replacements).toBe(1);
    expect(r.bytes).toBe((await fs.stat(target)).size);
    expect(await fs.readFile(target, 'utf-8')).toBe('the NEW-and-longer value stays');
  });
});

describe('file_delete', () => {
  it('20. deletes a file', async () => {
    const target = path.join(tmp, 'del.txt');
    await fs.writeFile(target, 'x');
    const r = (await fileDeleteTool.execute({ path: target }, ctx)) as {
      success: boolean;
    };
    expect(r.success).toBe(true);
    await expect(fs.access(target)).rejects.toThrow();
  });

  it('21. deletes a directory tree with recursive=true', async () => {
    const dir = path.join(tmp, 'tree');
    await fs.mkdir(path.join(dir, 'inner'), { recursive: true });
    await fs.writeFile(path.join(dir, 'inner', 'a.txt'), 'x');
    const r = (await fileDeleteTool.execute(
      { path: dir, recursive: true },
      ctx,
    )) as { success: boolean };
    expect(r.success).toBe(true);
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it('22. refuses filesystem root', async () => {
    const root = process.platform === 'win32' ? 'C:\\' : '/';
    const r = (await fileDeleteTool.execute({ path: root }, ctx)) as {
      success: boolean;
      error: string;
    };
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/root/i);
  });
});

describe('file_move', () => {
  it('23. renames a file', async () => {
    const from = path.join(tmp, 'from.txt');
    const to = path.join(tmp, 'to.txt');
    await fs.writeFile(from, 'data');
    const r = (await fileMoveTool.execute({ from, to }, ctx)) as {
      success: boolean;
    };
    expect(r.success).toBe(true);
    expect(await fs.readFile(to, 'utf-8')).toBe('data');
    await expect(fs.access(from)).rejects.toThrow();
  });

  it('24. creates parent dirs at destination', async () => {
    const from = path.join(tmp, 'src.txt');
    const to = path.join(tmp, 'a', 'b', 'dst.txt');
    await fs.writeFile(from, 'data');
    const r = (await fileMoveTool.execute({ from, to }, ctx)) as {
      success: boolean;
    };
    expect(r.success).toBe(true);
    expect(await fs.readFile(to, 'utf-8')).toBe('data');
  });
});

describe('file_copy', () => {
  it('25. duplicates a file', async () => {
    const from = path.join(tmp, 'orig.txt');
    const to = path.join(tmp, 'dup.txt');
    await fs.writeFile(from, 'data');
    const r = (await fileCopyTool.execute({ from, to }, ctx)) as {
      success: boolean;
    };
    expect(r.success).toBe(true);
    expect(await fs.readFile(from, 'utf-8')).toBe('data');
    expect(await fs.readFile(to, 'utf-8')).toBe('data');
  });

  it('26. duplicates a directory tree', async () => {
    const from = path.join(tmp, 'tree');
    const to = path.join(tmp, 'tree-copy');
    await fs.mkdir(path.join(from, 'inner'), { recursive: true });
    await fs.writeFile(path.join(from, 'inner', 'a.txt'), 'x');
    const r = (await fileCopyTool.execute({ from, to }, ctx)) as {
      success: boolean;
    };
    expect(r.success).toBe(true);
    expect(await fs.readFile(path.join(to, 'inner', 'a.txt'), 'utf-8')).toBe(
      'x',
    );
  });
});
