/**
 * Copyright (c) 2026 Shiva Deore (Taracod). Licensed under AGPL-3.0.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/replyRenderer.ts — Phase v4.1-reply-formatting
 *
 * Configures marked-terminal with skin-aware renderers so Aiden's
 * agent replies render as structured markdown instead of raw walls
 * of text. Headers, lists, code blocks, blockquotes, inline emphasis,
 * and links all get terminal-friendly painting.
 *
 * The renderer is an instance — `getReplyRenderer().render(text)`
 * returns the painted string. Used by:
 *   - `display.markdown(text)` (non-streaming agent reply)
 *   - `display.streamComplete()` (post-stream re-render, optional)
 *   - the citation footer composer
 *
 * Stable-prefix split for streaming lives in `streamingPrefix.ts`
 * (pure function over the buffered text); this module is only the
 * static renderer.
 *
 * NO_COLOR honour: the skin engine already returns plain text when
 * `NO_COLOR` is set, so every paint call gracefully degrades.
 */

import { marked } from 'marked';
import { getSkinEngine } from './skinEngine';
import { highlightCode, isSupportedLang } from './syntaxHighlight';
// v4.8.0 Slice 8 — token-sourced bullet glyphs + task-list markers.
import { glyphs } from './design/tokens';
// v4.1.4 reply-quality polish: single source of truth for frame math.
// Replaces 3 inline `Math.min(process.stdout.columns ?? 80, 100) - 4`
// callsites in this file with `getBodyWidth()` and adds soft-wrap for
// code-block lines that previously overflowed the viewport.
import { getBodyWidth, getIndent, wrap as frameWrap, GUTTER } from './display/frame';
import { visibleLength } from './box';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TerminalRenderer = require('marked-terminal').default ?? require('marked-terminal');

type Painter = (text: string) => string;

function paint(kind: 'brand' | 'heading' | 'muted' | 'agent' | 'tool' | 'success' | 'warn' | 'error' | 'accent' | 'tertiary'): Painter {
  return (text: string) => getSkinEngine().applyColors(text, kind);
}

/**
 * v4.1.3-essentials → v4.5 TUI polish: bold (`**foo**`) markdown
 * emphasis renders as plain ANSI bold. Earlier iterations tried
 * 'brand' (orange, collided with heading hierarchy), bright-white
 * (low contrast on dark themes), and bold+underline (made bulleted
 * list items look like clickable hyperlinks — user feedback after
 * v4.5 Phase 8 stabilisation).
 *
 * Landed on bold-only: weight carries emphasis, no color slot
 * consumed, and no underline confusion with terminal URL/path
 * auto-highlight features.
 *
 * ANSI sequence: `\x1b[1m{text}\x1b[22m` — bold ON, bold OFF.
 *
 * Bypasses the skin system intentionally — emphasis is an
 * opinionated default for this slice. Same caveat as the prior
 * bold-as-color iteration: nested markdown loses the outer style
 * after close (pre-existing limitation of the painter-stack
 * architecture).
 *
 * Honors `NO_COLOR=1` per the standard (skips the wrap entirely).
 * Strictly speaking `NO_COLOR` is about color, but the wrap still
 * emits ANSI escapes; honoring the env var keeps output paste-safe
 * in scripted contexts.
 *
 * Function name: `paintEmphasis` rather than `paintBold` because
 * the latter is already taken by a different (parameterised) helper
 * below.
 */
function paintEmphasis(text: string): string {
  if (process.env.NO_COLOR && process.env.NO_COLOR !== '') return text;
  return `\x1b[1m${text}\x1b[22m`;
}

/**
 * v4.1.3-essentials reply-polish: bold-on + skin paint + bold-off.
 * Used by the 4-tier heading hierarchy so each level can pick its own
 * color while sharing the bold weight. Emit order matches the rest of
 * the painter stack: outer wrap is bold, inner wrap is fg color.
 *
 * Honors `NO_COLOR=1` via the skin engine's own gate; the bold ANSI
 * still emits because bold is a weight, not a color (matches the
 * paintBoldUnderline convention for `**bold**`).
 */
function paintBold(
  kind: 'brand' | 'heading' | 'muted' | 'agent' | 'tool' | 'success' | 'warn' | 'error' | 'accent',
): Painter {
  const colorize = paint(kind);
  return (text: string) => `\x1b[1m${colorize(text)}\x1b[22m`;
}

/**
 * Render a fenced code block: top divider with language label, body
 * with optional syntax highlighting, bottom divider.
 *
 *     ── typescript ─────────────
 *       const x = 1;
 *     ──────────────────────────
 *
 * Used by the prototype-override path below — marked-terminal's
 * internal `Renderer.prototype.code` ignores user `opts.code` and
 * runs its own highlighter, so we override the prototype method
 * directly. The token-object signature is what marked v15 calls
 * the renderer with; the older positional path is kept for
 * compatibility.
 */
/**
 * v4.1.3-essentials reply-polish: 24-bit dark background applied per
 * line so code stands out from prose.
 *
 * Color choice: `\x1b[48;2;50;50;60m` (#32323c, slightly bluish dark
 * grey). The original `30,30,30` (#1e1e1e) was invisible against VS
 * Code's integrated terminal default (also #1e1e1e) and barely
 * distinct from Windows Terminal's One Half Dark. #32323c is visibly
 * different from every common dark-terminal default (Campbell, One
 * Half Dark, Solarized Dark, Monokai, VS Code) while staying subtle
 * enough to read as "code chrome" rather than a jarring highlight.
 *
 * Used by BOTH the block path (fenced code blocks) and the inline
 * path (`` `code` `` spans) so the two affordances visually agree —
 * inline code reads as "this is code" via the same chrome as block
 * code, just shorter.
 *
 * NOTE: \x1b[49m is "default background", terminating the per-line
 * background scope cleanly. Each body line is wrapped individually
 * rather than wrapping the whole block, so the background doesn't
 * bleed across the closing horizontal rule (which already paints fg
 * muted with its own reset).
 */
const CODE_BG_ON  = '\x1b[48;2;50;50;60m';
const CODE_BG_OFF = '\x1b[49m';

function renderCodeBlock(code: string, lang: string | undefined): string {
  // v4.8.0 Slice 9 hotfix — top-divider asymmetric chrome.
  //
  //   ── python ─────────────────────────────────────────
  //     print("Hello, world!")
  //     greet("Aiden")
  //
  // The earlier Slice 9 version used `▎` left-rail on every line and
  // visually competed with the dark-bg syntax highlighting. This
  // revision drops the rail, keeps a single muted `──` top divider
  // with the language label in brand orange, indents body content,
  // and omits the bottom border (Slice 4 asymmetric signature).
  // CODE_BG_ON/OFF envelope preserved.
  const sk = getSkinEngine();
  const width = getBodyWidth();
  const langLabel = (lang ?? '').trim();
  const body = isSupportedLang(langLabel)
    ? highlightCode(code, langLabel)
    : code;
  const indent = '  ';
  const hLine = glyphs.chrome.hLine;
  // Top divider: `── <lang> ─────` (lang in brand) OR full-width
  // `────────────` when no language declared.
  const top = langLabel
    ? `${indent}${sk.applyColors(`${hLine.repeat(2)} `, 'muted')}` +
      `${sk.applyColors(langLabel, 'brand')}` +
      ` ${sk.applyColors(hLine.repeat(Math.max(1, width - langLabel.length - 4)), 'muted')}`
    : `${indent}${sk.applyColors(hLine.repeat(width), 'muted')}`;
  // Body content lands at col 4 (4-space indent inside the divider).
  // Width budget: leave room for body indent + CODE_BG envelope spaces.
  const bodyIndent = '    ';
  const contentBudget = Math.max(8, width - 6);
  const wrappedLines: string[] = [];
  for (const srcLine of body.split('\n')) {
    const wrapped = frameWrap(srcLine, contentBudget, { trim: false, hard: true });
    for (const visualLine of wrapped.split('\n')) {
      wrappedLines.push(`${bodyIndent}${CODE_BG_ON} ${visualLine} ${CODE_BG_OFF}`);
    }
  }
  return [top, ...wrappedLines].join('\n') + '\n';
}

/**
 * Render a block quote with a `┃` left rail in muted colour.
 * Multi-line quotes get the rail on every line.
 */
function renderBlockquote(quote: string): string {
  const rail = paint('muted')('┃ ');
  return quote
    .split('\n')
    .map((ln) => (ln.length === 0 ? rail.trimEnd() : `${rail}${ln}`))
    .join('\n') + '\n\n';  // v4.9.0 pre-ship UI: blank line after blockquote
}

/**
 * v4.1.3-essentials reply-polish: 4-tier heading hierarchy using the
 * existing palette colors so visual weight differs per level even
 * though we don't introduce a new ColorKind.
 *
 *   H1 — brand   + bold + UPPERCASE  (major section heading)
 *   H2 — brand   + bold                (subsection — same hue as H1
 *                                       but sentence-case + no caps)
 *   H3 — agent   + bold                (off-white, lighter weight
 *                                       than brand)
 *   H4+ — muted  + bold                (quietest — same grey as the
 *                                       reply container's chrome)
 *
 * v4.1.3-essentials reply-polish: spacing tightened from `\n\n` to
 * `\n` per level. marked-terminal contributes its own block
 * separator (one more newline) → total `\n\n` between heading and
 * next block = single blank line, matching paragraph rhythm.
 * Previously this emitted `\n\n\n\n` (three blank lines) which made
 * structured replies feel cramped at top and over-aired between
 * sections.
 */
// 4-tier hierarchy. Called by the prototype-level `heading` override
// in getReplyRenderer() which extracts depth from the token first.
// Plain `(text, depth)` signature; the marked v15 / v14 / positional
// translation happens in the override.
//
// Each tier ends with `\n\n` to fence the heading from the next block
// with a blank line. Earlier we tried `\n` (single trailing newline)
// assuming marked-terminal's `section()` wrapper added its own
// padding — but the prototype-level override bypasses section(), so
// we own the spacing end-to-end. Result with `\n\n`: heading visible
// on its own line, blank line separates it from the next paragraph /
// heading / list. Matches the paragraph rhythm (`text\n\n`).
function renderHeading(text: string, depth: number): string {
  if (depth <= 1) return paintBold('brand')(text.toUpperCase()) + '\n\n';
  if (depth === 2) return paintBold('brand')(text) + '\n\n';
  if (depth === 3) return paintBold('agent')(text) + '\n\n';
  return paintBold('muted')(text) + '\n\n';
}

/**
 * v4.1.3-essentials reply-polish: the `opts.listitem` callback used to
 * own bullet rendering but marked-terminal's outer `list` method
 * ALSO emits a `* ` prefix, producing visible double bullets
 * (`  *   ▸ item`). The fix is a prototype-level override on BOTH
 * `list` and `listitem` (mirrors the existing pattern for `code` and
 * `link`). See the override block in getReplyRenderer().
 *
 * This callback now just returns the inner text unchanged so the
 * prototype-level `list` override can do the bullet + indent work
 * with full nesting-depth context.
 */
function renderListItem(text: string): string {
  return text;
}

/**
 * v4.1.4 reply-quality polish — Fix C helper.
 *
 * Render a single list item's tokens correctly, expanding inline
 * emphasis (strong, em, codespan) that the prior `parser.parse` path
 * silently stranded as raw text.
 *
 * Marked v15 token shapes for list items:
 *
 *   Tight list (default — no blank lines between items):
 *     list_item.tokens = [
 *       { type: 'text', text: '**bold**',
 *         tokens: [ { type: 'strong', ... } ]   ← inline children
 *       }
 *     ]
 *
 *   Loose list (blank line between items, OR an item with multiple
 *   paragraphs):
 *     list_item.tokens = [
 *       { type: 'paragraph', tokens: [ inline children… ] },
 *       { type: 'paragraph', tokens: [ … ] },
 *     ]
 *
 *   Nested list (a list-token inside an item):
 *     list_item.tokens = [
 *       { type: 'text', tokens: [...] },   ← the item's own text first
 *       { type: 'list', items: [...] },    ← then the nested list
 *     ]
 *
 *   Item with fenced code block:
 *     list_item.tokens = [
 *       { type: 'text', ... },
 *       { type: 'code', text: '…', lang: '…' },
 *     ]
 *
 * Dispatch rules:
 *   - `text` with nested `.tokens`     → parseInline(tokens)
 *   - `text` with only `.text`          → fall through to raw text
 *   - `paragraph`                       → parseInline(paragraph.tokens) + '\n'
 *   - `list` / `code` / other block     → parser.parse([token]) (block path)
 *
 * Returns the joined rendered string. Pure-ish: depends on marked's
 * parser instance (closure-captured) but never mutates it.
 */
function renderListItemTokens(
  it: { tokens?: unknown[]; text?: string },
  parser: {
    parse?:       (t: unknown[]) => string;
    parseInline?: (t: unknown[]) => string;
  },
): string {
  const toks = Array.isArray(it.tokens) ? it.tokens : [];
  if (toks.length === 0) return it.text ?? '';

  const out: string[] = [];
  for (const raw of toks) {
    if (typeof raw !== 'object' || raw === null) continue;
    const tk = raw as {
      type?:   string;
      text?:   string;
      tokens?: unknown[];
    };
    const type = tk.type;

    // Inline-only wrapper (tight-list common case). The `text` outer
    // token holds inline children we want to expand into ANSI.
    if (type === 'text') {
      if (Array.isArray(tk.tokens) && tk.tokens.length > 0 && parser.parseInline) {
        out.push(parser.parseInline(tk.tokens));
      } else {
        out.push(tk.text ?? '');
      }
      continue;
    }

    // Paragraph block (loose-list case). Marked wraps each paragraph's
    // inline content in `.tokens`; render those inline + append a
    // newline so multi-paragraph items stack visually.
    if (type === 'paragraph') {
      if (Array.isArray(tk.tokens) && tk.tokens.length > 0 && parser.parseInline) {
        out.push(parser.parseInline(tk.tokens));
        out.push('\n');
      } else {
        out.push(tk.text ?? '');
      }
      continue;
    }

    // Nested list, fenced code, or any other block-level token. The
    // block parser handles these via the normal dispatch (which calls
    // back into our own `renderer.list` override for nested lists —
    // depth counter is already incremented before we got here).
    //
    // v4.8.0 Slice 8 hotfix — ensure inline text and following block
    // tokens are separated by a newline. Without this, a tight-list
    // item like `- Python` followed by a nested `- Django` collapses
    // to `● Python    ○ Django` on a single line because head/tail
    // split in renderer.list takes only the first line as `head`.
    if (parser.parse) {
      if (out.length > 0 && !out[out.length - 1].endsWith('\n')) {
        out.push('\n');
      }
      out.push(parser.parse([tk as unknown] as unknown[]));
      continue;
    }

    // Last-resort fallback: drop the token's text in raw.
    out.push(tk.text ?? '');
  }
  return out.join('');
}

/**
 * Singleton — caching is fine since options bind to the active skin
 * via paint callbacks (which read getSkinEngine() each call).
 */
let cachedRenderer: { render: (text: string) => string } | null = null;

export function getReplyRenderer(): { render: (text: string) => string } {
  if (cachedRenderer) return cachedRenderer;

  // marked-terminal's `opts.<X>` callbacks are invoked with ALREADY-
  // assembled strings, not raw token data — they're meant for ANSI
  // wrapping, not structural override. So `opts.code` for example is
  // never actually called for fenced blocks: marked-terminal's
  // prototype.code runs its own internal highlighter and skips opts.
  // To emit our structured code blocks (top divider + lang label +
  // syntax highlight + bottom divider) we override the prototype
  // method directly below.
  const opts = {
    blockquote:   renderBlockquote,
    // v4.1.3-essentials reply-polish: `opts.heading` and `opts.firstHeading`
    // both removed. marked-terminal calls `opts.heading(text)` with ONLY
    // text (audit-confirmed via toString), dropping the depth info we
    // need for the 4-tier hierarchy. The prototype-level `renderer.heading`
    // override below owns the depth extraction + tier selection end-to-end.
    // marked-terminal's stripped-args call path never reaches our callback.
    hr:           () => paint('muted')('─'.repeat(getBodyWidth())) + '\n',
    listitem:     renderListItem,
    paragraph:    (text: string) => `${text}\n\n`,
    // v4.1.3-essentials → v4.5 TUI polish: bold renders as plain ANSI
    // bold. Earlier iterations tried orange (collision with headings),
    // bright-white (low contrast), and bold+underline (made bulleted
    // **labels** look like clickable links — user feedback after v4.5
    // Phase 8 stabilisation). Weight alone carries emphasis.
    strong:       paintEmphasis,
    em:           paint('muted'),
    // v4.1.3-essentials reply-polish: inline `` `code` `` — strip
    // the literal backticks (used to leak into the visible output)
    // and wrap with the same dark background as fenced code blocks.
    // Visual consistency: inline code reads as "this is code" via the
    // same chrome as block code, just shorter. One leading + trailing
    // space inside the bg span gives the chrome a bit of padding so
    // letters don't sit flush against the bg edge.
    //
    // Trade-off (accepted): if an inline-code span breaks across a
    // line wrap, the bg painting may show a visual seam at the wrap
    // point. Acceptable for v4.1.3 — revertable to Path A (no bg) if
    // visual smoke surfaces a real problem.
    codespan:     (text: string) => `${CODE_BG_ON} ${paint('accent')(text)} ${CODE_BG_OFF}`,
    del:          paint('muted'),
    // marked-terminal calls opts.link with the ASSEMBLED visual
    // (already OSC8-wrapped when the host terminal supports it),
    // so we just paint it.
    link:         (assembled: string) => paint('accent')(assembled),
    href:         paint('accent'),
    text:         (text: string) => text,
    // v4.1.4 reply-quality polish: marked-terminal's `width` is the
    // *outer* canvas it formats into. Frame-aware body width keeps the
    // tables / hr / hard-wrap targets inside our gutter envelope.
    // `reflowText: false` (below) stays off — we own prose wrap via
    // frame.wrap() in the display layer, not here.
    width:        getBodyWidth(),
    showSectionPrefix: false,
    reflowText:   false,
    tab:          2,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderer = new TerminalRenderer(opts) as any;
  // Override the prototype `code` method on this instance so we get
  // structured code blocks (divider + lang label + syntax highlight
  // + divider) instead of marked-terminal's plain yellow-highlighted
  // output. Token-object signature handles marked v15.
  renderer.code = function (code: unknown, lang?: string, _escaped?: boolean): string {
    let text: string;
    let langOut: string | undefined;
    if (typeof code === 'object' && code !== null) {
      // marked v15 passes a token object: { text, lang, escaped }.
      const tok = code as { text?: string; lang?: string };
      text    = tok.text ?? '';
      langOut = tok.lang;
    } else {
      text    = String(code ?? '');
      langOut = lang;
    }
    return renderCodeBlock(text, langOut);
  };

  // Override `link` to ALWAYS emit OSC8 hyperlinks (marked-terminal's
  // default uses `supports-hyperlinks` which returns false on piped
  // stdout — but Aiden's REPL targets modern terminals that support
  // OSC8 universally). Visible label gets accent paint; href is the
  // OSC8 target. Token-object signature handles marked v15.
  renderer.link = function (href: unknown, _title?: string, text?: string): string {
    let url:   string;
    let label: string;
    if (typeof href === 'object' && href !== null) {
      const tok = href as { href?: string; tokens?: unknown[] };
      url   = tok.href ?? '';
      label = (this as { parser?: { parseInline?: (t: unknown[]) => string } })
        .parser?.parseInline?.(tok.tokens ?? []) ?? '';
    } else {
      url   = String(href ?? '');
      label = String(text ?? url);
    }
    if (!label) label = url;
    const painted = paint('accent')(label);
    return `\x1b]8;;${url}\x1b\\${painted}\x1b]8;;\x1b\\`;
  };

  // v4.1.3-essentials reply-polish: prototype-level `heading` override.
  //
  // Why: marked-terminal's internal `heading` method extracts the
  // token's depth, then calls `opts.heading(text)` with ONLY the
  // text — dropping the level info on the floor. Our 4-tier hierarchy
  // (H1 brand+caps, H2 brand, H3 agent, H4+ muted) needs level
  // context, so we must own the whole method.
  //
  // The override accepts marked v15's token-object shape and falls
  // through to v14 positional for unit tests that pass plain strings.
  renderer.heading = function (textOrToken: unknown, levelArg?: number, _raw?: string): string {
    let text:  string;
    let depth: number;
    if (typeof textOrToken === 'object' && textOrToken !== null) {
      const tok = textOrToken as { depth?: number; text?: string; tokens?: unknown[] };
      depth = typeof tok.depth === 'number' ? tok.depth : 1;
      // Prefer parseInline for rich heading content (e.g. `## H2 with **bold**`).
      // Falls through to tok.text for the common plain-text case.
      const parser = (this as { parser?: { parseInline?: (t: unknown[]) => string } }).parser;
      if (tok.tokens && parser?.parseInline) {
        text = parser.parseInline(tok.tokens);
      } else {
        text = String(tok.text ?? '');
      }
    } else {
      text  = String(textOrToken ?? '');
      depth = typeof levelArg === 'number' ? levelArg : 1;
    }
    return renderHeading(text, depth);
  };

  // v4.1.3-essentials reply-polish: prototype-level list overrides.
  //
  // Why two functions and a depth counter:
  //   - marked-terminal's default `list` injects a `* ` (or `N. `)
  //     prefix BEFORE calling our `opts.listitem` callback, producing
  //     visible double bullets — see audit. Owning `list` at the
  //     prototype level lets us suppress that and emit our own.
  //   - Nesting depth determines the bullet glyph: top-level gets `•`
  //     and any deeper level gets `▸`. marked doesn't pass depth to
  //     the renderer, so we track it on the renderer instance via a
  //     counter that increments on `list`-enter and decrements on
  //     exit. This works because marked walks the token tree
  //     synchronously: a nested list's `list` call always completes
  //     between its parent's `list`-enter and `list`-exit.
  //   - Items already had their child markdown rendered via the
  //     prototype's `listitem` (which we leave as a passthrough above
  //     in the opts block — it just returns the inner text). The
  //     body string we receive in `list` is the concatenated children;
  //     each child can itself be a nested list rendering, whose own
  //     `list` call already handled its bullets + indent.
  //
  // Numbered lists: `start` and `ordered` come from the token; we
  // emit `N.` prefix in muted to keep the visual rhythm consistent
  // with bulleted lists but preserve numeric semantics.
  //
  // Indent: 2 spaces per nesting level. Top-level items therefore
  // sit at column 2 (matching the rest of the reply container's
  // chrome); nested at column 4, 6, etc.
  const proto = renderer as { _listDepth?: number };
  proto._listDepth = 0;
  renderer.listitem = function (text: unknown, _task?: boolean, _checked?: boolean): string {
    // marked v15 may pass a token object; the assembled-text fallback
    // covers older signatures. Either way we want the inner text
    // unchanged here — bullet + indent is owned by `list` below.
    if (typeof text === 'object' && text !== null) {
      const tok = text as { text?: string; tokens?: unknown[] };
      if (typeof tok.text === 'string') return tok.text;
      const parser = (this as { parser?: { parseInline?: (t: unknown[]) => string } }).parser;
      return parser?.parseInline?.(tok.tokens ?? []) ?? '';
    }
    return String(text ?? '');
  };
  renderer.list = function (body: unknown, ordered?: boolean, start?: number): string {
    // marked v15 token shape: { ordered, start, items: [token, ...] }
    // Older positional shape: (body, ordered, start)
    let isOrdered = false;
    let startNum  = 1;
    let items:    string[];
    // v4.8.0 Slice 8 — task/checked flags collected alongside items so
    // the marker dispatch below can pick ✔ (checked) or ○ (unchecked).
    // Default false (not a task) so the bullet path stays unchanged.
    let itemTasks: Array<{ task: boolean; checked: boolean }> = [];
    // CRITICAL: increment depth BEFORE walking items. Item walking via
    // `parser.parse(it.tokens)` recurses into our own override for any
    // nested list tokens — those nested calls need to see the parent's
    // incremented depth so they pick the deeper bullet glyph (▸) and
    // indent. If we increment AFTER `parser.parse`, the nested call
    // sees depth=0, renders at top-level styling, and the visible
    // nesting collapses. Confirmed via runtime trace.
    proto._listDepth = (proto._listDepth ?? 0) + 1;
    const depth = proto._listDepth;

    if (typeof body === 'object' && body !== null) {
      const tok = body as {
        ordered?: boolean;
        start?:   number;
        items?:   Array<{ tokens?: unknown[]; text?: string }>;
      };
      isOrdered = tok.ordered === true;
      startNum  = typeof tok.start === 'number' ? tok.start : 1;
      // v4.1.4 reply-quality polish — Fix C (token-type dispatch).
      //
      // Prior implementation called `parser.parse(it.tokens)` and let
      // marked's block-parser dispatch each token. For tight-list items
      // marked v15 wraps the item's content in a `text`-type outer
      // token whose `.tokens` array holds the actual inline tokens
      // (strong, em, codespan…). `parser.parse` dispatched the outer
      // wrapper to `renderer.text` (our `opts.text` = identity), which
      // returned the RAW raw `**bold**` source string — never recursing
      // into the inline children. Result: literal asterisks in every
      // bullet that contained inline emphasis.
      //
      // Fix: walk each top-level token by type. Tight-list items have
      // a `text` wrapper → use `parseInline` on its nested tokens to
      // expand strong/em/codespan. Loose-list items have block-level
      // `paragraph`/`list`/`code` tokens → those need block-level
      // recursion (delegates back to our list override for nested
      // lists, preserving the depth counter).
      //
      // Confirmed against marked v15 token shapes from `marked.lexer`
      // (see scripts/smoke-issue-c-tokens.ts).
      const parser = (this as {
        parser?: {
          parse?: (t: unknown[]) => string;
          parseInline?: (t: unknown[]) => string;
        };
      }).parser;
      // v4.8.0 Slice 8 — capture GFM task/checked flags alongside the
      // rendered text so the marker dispatch below can pick the right
      // glyph (✔ checked / ○ unchecked) for task-list items.
      const rawItems = tok.items ?? [];
      items = rawItems.map((it) =>
        parser ? renderListItemTokens(it, parser) : (it.text ?? ''));
      itemTasks = rawItems.map((it) => {
        const itx = it as { task?: boolean; checked?: boolean };
        return { task: itx.task === true, checked: itx.checked === true };
      });
    } else {
      isOrdered = ordered === true;
      startNum  = typeof start === 'number' ? start : 1;
      // Positional `body` is the already-concatenated rendered items.
      // Split on newlines that introduce a fresh item; marked emits
      // each item as its own logical line. Best-effort — marked v15
      // path above is the production case.
      const raw = String(body ?? '');
      items = raw.split('\n').filter((ln) => ln.trim().length > 0);
    }
    const indent = '  '.repeat(depth);
    // v4.8.0 Slice 8 — token-sourced bullet glyphs. Top-level (depth 1)
    // uses filled `●`, nested (depth ≥ 2) uses hollow `○`. Both painted
    // brand orange to give lists visual identity (was `muted` grey).
    const bulletGlyph = depth === 1 ? glyphs.util.bullet : glyphs.util.bulletOpen;

    const lines: string[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const task = itemTasks[i] ?? { task: false, checked: false };
      // v4.8.0 Slice 8 — marker dispatch:
      //   • GFM checked task → ✔ in semantic success (green)
      //   • GFM unchecked task → ○ in tertiary dim (looks incomplete)
      //   • Ordered list → `N.` right-padded to 3 cols, brand orange
      //   • Bullet → ●/○ by depth, brand orange
      let marker: string;
      if (task.task && task.checked) {
        marker = paint('success')(glyphs.util.check);
      } else if (task.task) {
        marker = paint('tertiary')(glyphs.util.bulletOpen);
      } else if (isOrdered) {
        const numStr = `${startNum + i}.`.padStart(3);
        marker = paint('brand')(numStr);
      } else {
        marker = paint('brand')(bulletGlyph);
      }
      const itemLines = item.split('\n');
      const head = itemLines[0] ?? '';
      const tail = itemLines.slice(1);
      lines.push(`${indent}${marker} ${head}`);
      // Continuation lines: if they already have content, align them
      // under the bullet's text column (indent + marker-width + 1
      // space). marked-terminal's nested lists arrive pre-indented so
      // we pass them through.
      for (const tailLine of tail) {
        if (tailLine.length === 0) continue;
        lines.push(tailLine);
      }
    }

    proto._listDepth -= 1;

    // v4.9.0 pre-ship UI: top-level list closes with a BLANK LINE
    // (`\n\n`) so a following paragraph / heading / table reads with
    // breathing room. Nested lists stay tight (`\n`) so they nest
    // cleanly under their parent item.
    const out = lines.join('\n');
    return proto._listDepth === 0 ? out + '\n\n' : out + '\n';
  };

  // ── v4.8.1 Slice 2 — markdown table override ──────────────────────────
  //
  // Why: marked-terminal's default table renderer (cli-table3) auto-
  // wraps cells but doesn't keep wrap-continuation lines aligned to
  // the original row — wide tables with 5+ columns fragment into
  // vertical pipe rails that don't read as rows. The narrow 2-col
  // tables that smoke-tested fine were within the no-wrap budget.
  //
  // Strategy: own the entire render from the marked v15 token object.
  // Use `parser.parseInline(cell.tokens)` to get ANSI-painted cell
  // text, then proportionally distribute the terminal-width budget
  // across columns (clamping to natural max width), wrap each cell
  // to its column width, and render the box with the same row
  // height for every cell in the row so visual rows stay tight.
  //
  // Token-source the box chars from `glyphs.chrome.*` so a single
  // glyph swap propagates here automatically (consistent with the
  // rest of v4.8.x chrome).
  renderer.table = function (header: unknown, body?: unknown): string {
    // marked v15 token: { header: [cellTok], rows: [[cellTok]] }.
    // Older string-based API: (headerHtml, bodyHtml) — we fall back
    // to a naive concatenation so the reply isn't lost entirely.
    if (typeof header !== 'object' || header === null) {
      return String(header ?? '') + (body !== undefined ? String(body) : '') + '\n';
    }
    const tok = header as {
      header?: Array<{ text?: string; tokens?: unknown[] }>;
      rows?:   Array<Array<{ text?: string; tokens?: unknown[] }>>;
    };
    const parser = (this as { parser?: { parseInline?: (t: unknown[]) => string } }).parser;
    const renderCell = (c: { text?: string; tokens?: unknown[] }): string => {
      if (c.tokens && parser?.parseInline) {
        try { return parser.parseInline(c.tokens).trim(); }
        catch { return (c.text ?? '').trim(); }
      }
      return (c.text ?? '').trim();
    };
    const headers = (tok.header ?? []).map(renderCell);
    const rows    = (tok.rows ?? []).map((r) => r.map(renderCell));
    const cols    = headers.length;
    if (cols === 0) return '';

    // Layout budget. Reply chrome family lives at col 2.
    const indent = '  ';
    const termCols = process.stdout.columns ?? 100;
    const innerBudget = Math.max(40, Math.min(termCols, 110) - indent.length);
    // Chrome per row = `│ ` (2) per col + trailing `│` (1) + 1 trailing
    // space per cell already absorbed in the budget below.
    const chromeCost  = 3 * cols + 1;
    const contentBudget = Math.max(cols * 4, innerBudget - chromeCost);

    // Natural width = max(header, body) visible width per column.
    const naturalW: number[] = headers.map((h, i) => {
      const hw = visibleLength(h);
      const cw = rows.reduce((m, r) => Math.max(m, visibleLength(r[i] ?? '')), 0);
      return Math.max(hw, cw, 1);
    });
    // v4.8.1 Slice 2 hotfix #2 — header-floor + proportional allocation.
    //
    // Each column's minimum is `max(headerWidth, MIN_COL_W)` so column
    // headers NEVER wrap — they are the column identifier; wrapping
    // them ("Framework" → "Framew/ork") fragments scanability worse
    // than wrapping body cells. Body content above the header width
    // is what gets compressed under width pressure.
    //
    // Algorithm:
    //   1. Compute `minPerCol = max(headerW[i], MIN_COL_W)` per column.
    //   2. If sum(minPerCol) >= contentBudget (very narrow terminal),
    //      use minPerCol as-is — body cells will wrap to fit, headers
    //      stay intact.
    //   3. Else if sum(naturalW) <= contentBudget, use natural widths
    //      (no wrap needed anywhere).
    //   4. Else: floor at minPerCol, distribute remaining budget
    //      proportionally to each column's "extra need above min",
    //      then hand rounding leftover to widest-natural cols first.
    const MIN_COL_W = 4;
    const headerW: number[] = headers.map((h) => visibleLength(h));
    const minPerCol = naturalW.map((_, i) => Math.max(headerW[i], MIN_COL_W));
    const totalMin  = minPerCol.reduce((a, b) => a + b, 0);
    const totalNatW = naturalW.reduce((a, b) => a + b, 0);
    let colWidths: number[];
    if (totalMin >= contentBudget) {
      colWidths = minPerCol.slice();
    } else if (totalNatW <= contentBudget) {
      colWidths = naturalW.slice();
    } else {
      colWidths = minPerCol.slice();
      const extraNeed = naturalW.map((w, i) => Math.max(0, w - minPerCol[i]));
      const totalNeed = extraNeed.reduce((a, b) => a + b, 0);
      const pool      = contentBudget - totalMin;
      if (totalNeed > 0) {
        for (let i = 0; i < cols; i += 1) {
          colWidths[i] += Math.floor((extraNeed[i] * pool) / totalNeed);
        }
      }
      let leftover = contentBudget - colWidths.reduce((a, b) => a + b, 0);
      const order = naturalW.map((_, i) => i).sort((a, b) => naturalW[b] - naturalW[a]);
      for (let k = 0; leftover > 0 && k < cols * 2; k += 1) {
        const idx = order[k % cols];
        if (colWidths[idx] < naturalW[idx]) {
          colWidths[idx] += 1;
          leftover -= 1;
        }
      }
    }

    // ANSI-aware cell wrap. frameWrap handles colour-code-aware width.
    const wrapCell = (text: string, w: number): string[] =>
      w <= 0 ? [''] : frameWrap(text, w, { trim: false, hard: true }).split('\n');

    const sk = getSkinEngine();
    const ch = glyphs.chrome;
    const rule = (l: string, m: string, r: string): string =>
      indent + sk.applyColors(
        l + colWidths.map((w) => ch.hLine.repeat(w + 2)).join(m) + r,
        'muted',
      );
    const vBar = sk.applyColors(ch.vLine, 'muted');
    const renderRow = (cells: string[][]): string => {
      const height = Math.max(...cells.map((c) => c.length), 1);
      const out: string[] = [];
      for (let line = 0; line < height; line += 1) {
        const cellLines = cells.map((cellLines2, ci) => {
          const cellLine = cellLines2[line] ?? '';
          const pad = Math.max(0, colWidths[ci] - visibleLength(cellLine));
          return ' ' + cellLine + ' '.repeat(pad) + ' ';
        });
        out.push(indent + vBar + cellLines.join(vBar) + vBar);
      }
      return out.join('\n');
    };

    const wrappedHeader = headers.map((h, i) => wrapCell(h, colWidths[i]));
    const wrappedRows   = rows.map((r) => r.map((c, i) => wrapCell(c, colWidths[i])));
    const lines: string[] = [rule(ch.topLeft, ch.teeDown, ch.topRight)];
    if (headers.length > 0) {
      lines.push(renderRow(wrappedHeader));
      lines.push(rule(ch.teeRight, ch.cross, ch.teeLeft));
    }
    for (const row of wrappedRows) lines.push(renderRow(row));
    lines.push(rule(ch.botLeft, ch.teeUp, ch.botRight));
    return lines.join('\n') + '\n';
  };

  cachedRenderer = {
    render(text: string): string {
      try {
        // Bind the renderer globally before each parse — marked v15
        // applies the renderer at parse time, so re-setting before
        // each call is safe and ensures our custom options win even
        // if other code transiently swaps the renderer.
        marked.setOptions({ renderer: renderer as never });
        const out = marked.parse(text);
        const raw = typeof out === 'string' ? out : String(out);
        // v4.1.4 Part 1.6 Issue I — collapse excess vertical spacing.
        //
        // Our `opts.paragraph` callback emits `text\n\n`, our
        // `renderCodeBlock` ends with `\n\n`, and marked-terminal's
        // outer block dispatch ALSO emits `\n\n` between adjacent
        // blocks. Result: 4 newlines (3 visible blank lines) between
        // paragraphs, after code blocks, between paragraphs and lists.
        // Root-cause fix would require auditing marked-terminal's
        // between-block separator across every override (risk-prone).
        // Band-aid: collapse any run of 3+ newlines down to exactly 2
        // (= one blank line). Mechanically safe — can only REMOVE
        // excess whitespace, never add bad spacing. Existing single-
        // blank-line gaps pass through unchanged.
        return normalizeBlankLines(raw);
      } catch {
        return text;
      }
    },
  };
  return cachedRenderer;
}

/**
 * v4.1.4 Part 1.6 Issue I — collapse runs of 3+ consecutive newlines
 * down to exactly 2 (a single blank line). Exported for unit-test
 * access; pure with no side effects.
 *
 * Confirmed via `scripts/smoke-issue-i-spacing.ts`:
 *   - "A\n\n\n\nB"    → "A\n\nB"     (2 paras → 1 blank line)
 *   - "A\n\n\n\n\nB"  → "A\n\nB"     (3+ blanks all collapse)
 *   - "A\n\nB"        → "A\n\nB"     (already correct, unchanged)
 *   - "A\nB"          → "A\nB"       (single newline preserved)
 *   - "A\n"           → "A\n"        (trailing pass-through)
 *
 * Does NOT touch the list-under-padding case (lists ending with a
 * single `\n` before a paragraph) — that's a v4.1.5 follow-up.
 */
export function normalizeBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

/** Test reset — drops the cached renderer so a skin change picks up. */
export function _resetForTests(): void {
  cachedRenderer = null;
}
