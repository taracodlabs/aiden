/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/workbench/dashboardHtml.ts — the Workbench dashboard page.
 *
 * A single self-contained dark page (inline CSS + JS, no framework, no external
 * assets). It opens an EventSource to /api/events and renders a live activity
 * feed: tool calls streaming in, task updates, cost, and the verified/unverified
 * marks from artifact_verified. Read-only — it only watches.
 */
export const WORKBENCH_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Aiden Workbench</title>
<style>
  :root{
    --bg:#0d0d0f; --panel:#15151a; --line:#22222a; --line2:#1b1b21;
    --text:#e7e7ea; --muted:#8a8a93; --dim:#5b5b63;
    --accent:#FF6B35; --ok:#4ade80; --warn:#fbbf24; --err:#f87171;
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{background:var(--bg);color:var(--text);
    font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:11px;
    padding:14px 20px;background:linear-gradient(180deg,#111114,rgba(13,13,15,.92));
    border-bottom:1px solid var(--line);backdrop-filter:blur(6px)}
  .dot{width:10px;height:10px;border-radius:50%;background:var(--accent);
    box-shadow:0 0 12px var(--accent)}
  .brand{font-weight:600;letter-spacing:.3px}
  .brand b{color:var(--accent)}
  .sub{color:var(--muted);font-size:12px}
  .status{margin-left:auto;display:flex;align-items:center;gap:7px;
    font-size:12px;color:var(--muted)}
  .status .pip{width:8px;height:8px;border-radius:50%;background:var(--dim);transition:.2s}
  .status.live .pip{background:var(--ok);box-shadow:0 0 8px var(--ok)}
  #feed{list-style:none;margin:0;padding:6px 0 60px}
  .row{display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:11px;
    align-items:baseline;padding:6px 20px;border-bottom:1px solid var(--line2)}
  .row:hover{background:#131318}
  .glyph{text-align:center;font-weight:700}
  .glyph.ok{color:var(--ok)} .glyph.warn{color:var(--warn)}
  .glyph.err{color:var(--err)} .glyph.run{color:var(--accent)} .glyph.muted{color:var(--dim)}
  .mid{display:flex;gap:9px;min-width:0;align-items:baseline}
  .name{color:var(--text);flex:0 0 auto}
  .detail{color:var(--muted);font-size:12.5px;min-width:0;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .time{color:var(--dim);font-size:11px;white-space:nowrap}
  .empty{padding:64px 20px;text-align:center;color:var(--muted)}
  .empty .k{color:var(--accent)}
</style>
</head>
<body>
<header>
  <span class="dot"></span>
  <span class="brand">Aiden <b>Workbench</b></span>
  <span class="sub">watch it work · read-only</span>
  <span class="status" id="status"><span class="pip"></span><span class="txt">connecting…</span></span>
</header>
<div class="empty" id="empty">Waiting for activity — run a task in the <span class="k">aiden</span> CLI and it streams here live.</div>
<ul id="feed"></ul>
<script>
(function(){
  var feed = document.getElementById('feed');
  var empty = document.getElementById('empty');
  var statusEl = document.getElementById('status');
  function setStatus(txt, live){
    statusEl.className = 'status' + (live ? ' live' : '');
    statusEl.querySelector('.txt').textContent = txt;
  }
  function fmtTime(ts){ try { return new Date(ts).toLocaleTimeString(); } catch(e){ return ''; } }
  function pget(ev, k){ return ev && ev.payload && ev.payload[k]; }
  function describe(ev){
    var n = ev.name || ev.kind || '';
    if (n === 'artifact_verified'){
      var v = pget(ev,'verified');
      return { g:v?'\\u2713':'\\u26a0', c:v?'ok':'warn', label:v?'verified':'unverified',
               detail:'verdict: ' + (pget(ev,'verdict')||'?') + ' \\u00b7 ' + (pget(ev,'handles')||0) + ' handle(s)' };
    }
    if (n === 'tool_call_started') return { g:'\\u26a1', c:'run', label:(pget(ev,'toolName')||'tool'), detail:'running…' };
    if (n === 'tool_call_completed'){
      var ok = ev.status !== 'failed';
      return { g:ok?'\\u2713':'\\u2717', c:ok?'ok':'err', label:(pget(ev,'toolName')||'tool'),
               detail:(ok?'done':'failed') + (ev.durationMs!=null ? ' \\u00b7 ' + ev.durationMs + 'ms' : '') };
    }
    if (n === 'ui_task_done')   return { g:'\\u2713', c:'ok',    label:'task done', detail:(pget(ev,'status')||'') };
    if (n === 'ui_task_update') return { g:'\\u2022', c:'muted', label:'task', detail:(pget(ev,'text')||pget(ev,'step')||'') };
    if (n === 'cost_updated')   return { g:'\\u2211', c:'muted', label:'tokens', detail:((pget(ev,'totalTokens')||0)) + ' total' };
    if (n === 'needs_confirmation') return { g:'\\u23f8', c:'warn', label:'needs approval', detail:((pget(ev,'tool')||'') + ' ' + (pget(ev,'reason')||'')).trim() };
    if (n === 'approval_decision'){
      var denied = ev.status === 'denied';
      return { g:denied?'\\u2298':'\\u2713', c:denied?'err':'ok', label:'approval', detail:(pget(ev,'toolName')||'') + ' \\u2192 ' + (ev.status||'') };
    }
    if (n.indexOf('ui_approval') === 0) return { g:'\\u23f8', c:'warn', label:'approval request', detail:(pget(ev,'tool')||'') };
    return { g:'\\u00b7', c:'muted', label:(n||'event'), detail:(ev.summary||'') };
  }
  function addEvent(ev){
    if (empty){ empty.remove(); empty = null; }
    var d = describe(ev);
    var li = document.createElement('li'); li.className = 'row';
    var g = document.createElement('span'); g.className = 'glyph ' + d.c; g.textContent = d.g;
    var mid = document.createElement('span'); mid.className = 'mid';
    var nm = document.createElement('span'); nm.className = 'name'; nm.textContent = d.label;
    var det = document.createElement('span'); det.className = 'detail'; det.textContent = d.detail || '';
    mid.appendChild(nm); mid.appendChild(det);
    var t = document.createElement('span'); t.className = 'time'; t.textContent = fmtTime(ev.ts);
    li.appendChild(g); li.appendChild(mid); li.appendChild(t);
    feed.appendChild(li);
    while (feed.children.length > 400) feed.removeChild(feed.firstChild);
    var nearBottom = (window.innerHeight + window.scrollY) >= (document.body.scrollHeight - 140);
    if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
  }
  var es = new EventSource('/api/events');
  es.onopen  = function(){ setStatus('live', true); };
  es.onerror = function(){ setStatus('reconnecting…', false); };
  es.onmessage = function(e){ try { addEvent(JSON.parse(e.data)); } catch(err){} };
})();
</script>
</body>
</html>`;
