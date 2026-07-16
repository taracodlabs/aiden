/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/workbench/dashboardHtml.ts — the Workbench dashboard page (Phase 3).
 *
 * One self-contained dark page (inline CSS + JS, no framework). A single-column
 * shell: a left sidebar (recent sessions with readable labels + a "Live — all"
 * item + placeholder nav), a header (brand + selected view + live dot), and the
 * center live activity feed. Selecting a session swaps the feed's SSE stream;
 * the feed render (describe/addEvent) is unchanged from Phase 2. Read-only.
 */
export const WORKBENCH_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Aiden Workbench</title>
<style>
  :root{
    --bg:#0d0d0f; --panel:#141419; --line:#22222a; --line2:#1b1b21;
    --text:#e7e7ea; --muted:#8a8a93; --dim:#5b5b63;
    --accent:#FF6B35; --ok:#4ade80; --warn:#fbbf24; --err:#f87171;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{background:var(--bg);color:var(--text);
    font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .app{display:grid;grid-template-columns:266px 1fr;height:100vh;overflow:hidden}

  /* ── sidebar ── */
  .sidebar{background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;overflow:hidden}
  .side-brand{display:flex;align-items:center;gap:10px;padding:15px 16px;border-bottom:1px solid var(--line);font-weight:600}
  .side-brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px var(--accent)}
  .side-brand b{color:var(--accent)}
  .side-scroll{flex:1;overflow-y:auto;padding:6px 0 20px}
  .side-h{padding:13px 16px 5px;color:var(--dim);font-size:10.5px;letter-spacing:.7px;text-transform:uppercase}
  .nav,.sess-list{list-style:none;margin:0;padding:0}
  .nav-item{display:flex;align-items:center;gap:9px;padding:8px 16px;cursor:pointer;border-left:2px solid transparent}
  .nav-item:hover{background:#191920}
  .nav-item.active{background:#1c1c24;border-left-color:var(--accent)}
  .nav-item.disabled{color:var(--dim);cursor:default;opacity:.6}
  .nav-item.disabled:hover{background:none}
  .soon{margin-left:auto;font-size:10px;color:var(--dim)}
  .sess{display:flex;flex-direction:column;gap:2px;padding:8px 16px;cursor:pointer;border-left:2px solid transparent;position:relative}
  .sess:hover{background:#191920}
  .sess.active{background:#1c1c24;border-left-color:var(--accent)}
  .sess-label{color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;padding-right:14px}
  .sess-meta{color:var(--dim);font-size:11px}
  .sess.muted{color:var(--dim);cursor:default}
  .live-pulse{position:absolute;right:15px;top:12px;width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 7px var(--ok);animation:pulse 1.6s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

  /* ── main ── */
  .main{display:flex;flex-direction:column;min-width:0;overflow:hidden}
  header{display:flex;align-items:center;gap:11px;padding:14px 20px;border-bottom:1px solid var(--line);
    background:linear-gradient(180deg,#111114,rgba(13,13,15,.92))}
  .hamburger{display:none;background:none;border:1px solid var(--line);color:var(--text);border-radius:6px;padding:3px 9px;cursor:pointer;font-size:15px}
  .brand{font-weight:600}.brand b{color:var(--accent)}
  .view{color:var(--muted);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .status{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);white-space:nowrap}
  .status .pip{width:8px;height:8px;border-radius:50%;background:var(--dim);transition:.2s}
  .status.live .pip{background:var(--ok);box-shadow:0 0 8px var(--ok)}
  .feedwrap{flex:1;overflow-y:auto}
  #feed{list-style:none;margin:0;padding:6px 0 60px}
  .row{display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:11px;align-items:baseline;padding:6px 20px;border-bottom:1px solid var(--line2)}
  .row:hover{background:#131318}
  .glyph{text-align:center;font-weight:700}
  .glyph.ok{color:var(--ok)} .glyph.warn{color:var(--warn)}
  .glyph.err{color:var(--err)} .glyph.run{color:var(--accent)} .glyph.muted{color:var(--dim)}
  .mid{display:flex;gap:9px;min-width:0;align-items:baseline}
  .name{color:var(--text);flex:0 0 auto}
  .detail{color:var(--muted);font-size:12.5px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .time{color:var(--dim);font-size:11px;white-space:nowrap}
  .empty{padding:64px 20px;text-align:center;color:var(--muted)}
  .empty .k{color:var(--accent)}
  /* chat composer (write path) */
  .composer{display:flex;gap:9px;padding:12px 20px;border-top:1px solid var(--line);background:var(--panel)}
  .composer.hidden{display:none}
  .composer-input{flex:1;min-width:0;background:#0f0f13;border:1px solid var(--line);color:var(--text);
    border-radius:8px;padding:9px 12px;font:inherit;outline:none}
  .composer-input:focus{border-color:var(--accent)}
  .composer-send{background:var(--accent);color:#180a03;border:none;border-radius:8px;padding:9px 17px;
    font:inherit;font-weight:600;cursor:pointer}
  .composer-send:hover{filter:brightness(1.08)}
  .composer-send:disabled{opacity:.5;cursor:default}
  .composer-stop{background:transparent;color:var(--err);border:1px solid var(--err);border-radius:8px;
    padding:9px 15px;font:inherit;font-weight:600;cursor:pointer}
  .composer-stop:hover{background:rgba(248,113,113,.12)}
  .composer-stop:disabled{opacity:.5;cursor:default}
  .composer-stop[hidden]{display:none}

  /* ── responsive: sidebar becomes an off-canvas drawer ── */
  .backdrop{display:none}
  @media(max-width:720px){
    .app{grid-template-columns:1fr}
    .sidebar{position:fixed;z-index:10;top:0;left:0;bottom:0;width:82%;max-width:300px;
      transform:translateX(-100%);transition:transform .2s ease}
    .app.nav-open .sidebar{transform:translateX(0)}
    .backdrop{display:block;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9;
      opacity:0;pointer-events:none;transition:opacity .2s}
    .app.nav-open .backdrop{opacity:1;pointer-events:auto}
    .hamburger{display:inline-block}
  }
</style>
<script>window.__WB_TOKEN__ = '__WORKBENCH_TOKEN__';</script>
</head>
<body>
<div class="app" id="app">
  <aside class="sidebar">
    <div class="side-brand"><span class="dot"></span><span>Aiden <b>Workbench</b></span></div>
    <div class="side-scroll">
      <ul class="nav">
        <li class="nav-item active" id="live-all"><span>\\u25c9</span><span>Live — all activity</span></li>
      </ul>
      <div class="side-h">Recent sessions</div>
      <ul class="sess-list" id="sessions"></ul>
      <div class="side-h">More surfaces</div>
      <ul class="nav">
        <li class="nav-item disabled">Approvals<span class="soon">soon</span></li>
        <li class="nav-item disabled">History<span class="soon">soon</span></li>
        <li class="nav-item disabled">Skills<span class="soon">soon</span></li>
        <li class="nav-item disabled">Memory<span class="soon">soon</span></li>
        <li class="nav-item disabled">Settings<span class="soon">soon</span></li>
      </ul>
    </div>
  </aside>
  <div class="backdrop" id="backdrop"></div>
  <div class="main">
    <header>
      <button class="hamburger" id="hamburger" aria-label="Toggle sidebar">\\u2630</button>
      <span class="brand">Aiden <b>Workbench</b></span>
      <span class="view" id="view">Live — all activity</span>
      <span class="status" id="status"><span class="pip"></span><span class="txt">connecting…</span></span>
    </header>
    <div class="feedwrap" id="feedwrap">
      <div class="empty" id="empty">Waiting for activity — run a task in the <span class="k">aiden</span> CLI and it streams here live.</div>
      <ul id="feed"></ul>
    </div>
    <form class="composer" id="composer" autocomplete="off">
      <input class="composer-input" id="composer-input" type="text" placeholder="Send a task to Aiden…  (runs safely — risky actions are auto-denied from web)" />
      <button class="composer-stop" id="composer-stop" type="button" hidden>Stop</button>
      <button class="composer-send" id="composer-send" type="submit">Send</button>
    </form>
  </div>
</div>
<script>
(function(){
  var app = document.getElementById('app');
  var feed = document.getElementById('feed');
  var feedwrap = document.getElementById('feedwrap');
  var empty = document.getElementById('empty');
  var statusEl = document.getElementById('status');
  var viewEl = document.getElementById('view');
  var liveAll = document.getElementById('live-all');
  var sessionsHost = document.getElementById('sessions');
  // Steer state: the run id of the browser-sent job we can stop, and whether a
  // just-sent task is still waiting for its run to appear in the feed.
  var stopBtn = null, activeRunId = null, awaitingRun = false;
  function showStop(on){ if (stopBtn) stopBtn.hidden = !on; }

  function setStatus(txt, live){
    statusEl.className = 'status' + (live ? ' live' : '');
    statusEl.querySelector('.txt').textContent = txt;
  }
  function fmtTime(ts){ try { return new Date(ts).toLocaleTimeString(); } catch(e){ return ''; } }
  function fmtRel(ts){
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.floor(s/60) + 'm ago';
    if (s < 86400) return Math.floor(s/3600) + 'h ago';
    return Math.floor(s/86400) + 'd ago';
  }
  function pget(ev, k){ return ev && ev.payload && ev.payload[k]; }

  // ── the feed row renderer (unchanged from Phase 2) ──
  function describe(ev){
    var n = ev.name || ev.kind || '';
    if (n === 'artifact_verified'){
      var oc = pget(ev,'outcome') || {};
      var pr = pget(ev,'presentation') || {};
      var k = oc.kind || (pget(ev,'verified') ? 'verified' : 'unverifiable');
      var okv = k === 'verified';
      var lbl = pr.label || (k==='verified'?'verified':k==='no_evidence'?'no evidence':k==='failed'?'failed':'unverified');
      return { g:okv?'\\u2713':'\\u26a0', c:okv?'ok':'warn', label:lbl,
               detail:'verdict: ' + (pget(ev,'verdict')||'?') + ' \\u00b7 ' + (pget(ev,'handles')||0) + ' handle(s)' };
    }
    if (n === 'tool_call_started') return { g:'\\u26a1', c:'run', label:(pget(ev,'toolName')||'tool'), detail:'running…' };
    if (n === 'tool_call_completed'){
      var ok = ev.status !== 'failed';
      return { g:ok?'\\u2713':'\\u2717', c:ok?'ok':'err', label:(pget(ev,'toolName')||'tool'),
               detail:(ok?'done':'failed') + (ev.durationMs!=null ? ' \\u00b7 ' + ev.durationMs + 'ms' : '') };
    }
    if (n === 'ui_task_done')   return { g:'\\u2713', c:'ok',    label:'task done', detail:(pget(ev,'status')||'') };
    if (n === 'task_cancelled') return { g:'\\u25a0', c:'warn',  label:'job stopped', detail:(pget(ev,'reason')||'cancelled from dashboard') };
    if (n === 'ui_task_update') return { g:'\\u2022', c:'muted', label:'task', detail:(pget(ev,'text')||pget(ev,'step')||'') };
    if (n === 'cost_updated')   return { g:'\\u2211', c:'muted', label:'tokens', detail:((pget(ev,'totalTokens')||0)) + ' total' };
    if (n === 'needs_confirmation') return { g:'\\u23f8', c:'warn', label:'needs approval — not available from web yet', detail:((pget(ev,'tool')||'') + ' ' + (pget(ev,'reason')||'')).trim() };
    if (n === 'approval_decision'){
      if (ev.status === 'denied') return { g:'\\u2298', c:'err', label:'needs approval — auto-denied', detail:(pget(ev,'toolName')||'') + ' \\u00b7 safe mode (approvals not available from web yet)' };
      return { g:'\\u2713', c:'ok', label:'approval', detail:(pget(ev,'toolName')||'') + ' \\u2192 ' + (ev.status||'allowed') };
    }
    if (n.indexOf('ui_approval') === 0) return { g:'\\u23f8', c:'warn', label:'approval request', detail:(pget(ev,'tool')||'') };
    return { g:'\\u00b7', c:'muted', label:(n||'event'), detail:(ev.summary||'') };
  }
  // Bind the Stop button to the browser-sent job: once a task is sent we watch
  // the feed for its run to start (any event carrying a runId), then reveal Stop
  // for that run; a terminal event (done/cancelled) for it hides Stop again.
  function trackRun(ev){
    if (!stopBtn || ev.runId == null) return;
    var n = ev.name || ev.kind || '';
    if (n === 'ui_task_done' || n === 'task_cancelled'){
      if (ev.runId === activeRunId){ activeRunId = null; awaitingRun = false; showStop(false); }
      return;
    }
    if (awaitingRun){ activeRunId = ev.runId; showStop(true); }
  }
  function addEvent(ev){
    empty.style.display = 'none';
    trackRun(ev);
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
    var nearBottom = feedwrap.scrollTop + feedwrap.clientHeight >= feedwrap.scrollHeight - 140;
    if (nearBottom) feedwrap.scrollTop = feedwrap.scrollHeight;
  }

  // ── stream switching ──
  var es = null;
  function connect(url, viewLabel){
    if (es) { es.close(); es = null; }
    feed.innerHTML = '';
    empty.textContent = 'Waiting for activity in \\u201c' + viewLabel + '\\u201d…';
    empty.style.display = '';
    viewEl.textContent = viewLabel;
    setStatus('connecting…', false);
    es = new EventSource(url);
    es.onopen  = function(){ setStatus('live', true); };
    es.onerror = function(){ setStatus('reconnecting…', false); };
    es.onmessage = function(e){ try { addEvent(JSON.parse(e.data)); } catch(err){} };
  }
  function markActive(el){
    var prev = document.querySelectorAll('.sess.active, #live-all.active');
    for (var i = 0; i < prev.length; i++) prev[i].classList.remove('active');
    if (el) el.classList.add('active');
  }
  function closeDrawer(){ app.classList.remove('nav-open'); }

  liveAll.addEventListener('click', function(){ markActive(liveAll); connect('/api/events', 'Live — all activity'); closeDrawer(); });

  // ── recent sessions sidebar ──
  function loadSessions(){
    fetch('/api/sessions').then(function(r){ return r.json(); }).then(function(list){
      sessionsHost.innerHTML = '';
      if (!list || !list.length){
        var li0 = document.createElement('li'); li0.className = 'sess muted';
        var lab0 = document.createElement('span'); lab0.className = 'sess-label'; lab0.textContent = 'No sessions yet';
        li0.appendChild(lab0); sessionsHost.appendChild(li0); return;
      }
      list.forEach(function(s, i){
        var li = document.createElement('li'); li.className = 'sess';
        var lab = document.createElement('span'); lab.className = 'sess-label'; lab.textContent = s.label;
        var meta = document.createElement('span'); meta.className = 'sess-meta'; meta.textContent = fmtRel(s.lastActive);
        li.appendChild(lab); li.appendChild(meta);
        if (i === 0){ var p = document.createElement('span'); p.className = 'live-pulse'; li.appendChild(p); } // newest-active = live
        li.addEventListener('click', function(){
          markActive(li);
          connect('/api/sessions/' + encodeURIComponent(s.id) + '/events', s.label);
          closeDrawer();
        });
        sessionsHost.appendChild(li);
      });
    }).catch(function(){ /* keep whatever is shown */ });
  }

  // ── chat composer (the write path) ──
  function flashRow(g, c, label, detail){
    empty.style.display = 'none';
    var li = document.createElement('li'); li.className = 'row';
    var gi = document.createElement('span'); gi.className = 'glyph ' + c; gi.textContent = g;
    var mid = document.createElement('span'); mid.className = 'mid';
    var nm = document.createElement('span'); nm.className = 'name'; nm.textContent = label;
    var det = document.createElement('span'); det.className = 'detail'; det.textContent = detail || '';
    mid.appendChild(nm); mid.appendChild(det);
    var t = document.createElement('span'); t.className = 'time'; t.textContent = fmtTime(Date.now());
    li.appendChild(gi); li.appendChild(mid); li.appendChild(t);
    feed.appendChild(li);
    feedwrap.scrollTop = feedwrap.scrollHeight;
  }
  var token = window.__WB_TOKEN__ || '';
  var composer = document.getElementById('composer');
  var composerInput = document.getElementById('composer-input');
  var composerSend = document.getElementById('composer-send');
  stopBtn = document.getElementById('composer-stop');
  function readJson(r){ return r.json().then(function(j){ return { ok:r.ok, status:r.status, j:j }; }, function(){ return { ok:r.ok, status:r.status, j:{} }; }); }
  if (!token) {
    composer.classList.add('hidden');   // no token → read-only, no send box + no stop
  } else {
    composer.addEventListener('submit', function(e){
      e.preventDefault();
      var msg = composerInput.value.trim();
      if (!msg) return;
      composerInput.value = '';
      composerSend.disabled = true;
      fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-workbench-token': token },
        body: JSON.stringify({ message: msg }),
      }).then(readJson).then(function(res){
        composerSend.disabled = false;
        if (res.ok) { awaitingRun = true; flashRow('\\u2197', 'run', 'task sent', msg); }
        else flashRow('\\u2717', 'err', 'send rejected', (res.j && res.j.error) || ('HTTP ' + res.status));
      }).catch(function(){
        composerSend.disabled = false;
        flashRow('\\u2717', 'err', 'send failed', 'network error');
      });
    });
    // Stop the running browser job (token-gated). Minimal steer: one durable
    // cancel of the run currently attached to the composer.
    stopBtn.addEventListener('click', function(){
      if (activeRunId == null) return;
      var id = activeRunId;
      stopBtn.disabled = true;
      fetch('/api/tasks/' + encodeURIComponent(id) + '/cancel', {
        method: 'POST',
        headers: { 'x-workbench-token': token },
      }).then(readJson).then(function(res){
        stopBtn.disabled = false;
        if (res.ok) { showStop(false); activeRunId = null; awaitingRun = false; flashRow('\\u25a0', 'warn', 'stop requested', 'run #' + id); }
        else flashRow('\\u2717', 'err', 'stop rejected', (res.j && res.j.error) || ('HTTP ' + res.status));
      }).catch(function(){
        stopBtn.disabled = false;
        flashRow('\\u2717', 'err', 'stop failed', 'network error');
      });
    });
  }

  // ── responsive drawer ──
  document.getElementById('hamburger').addEventListener('click', function(){ app.classList.toggle('nav-open'); });
  document.getElementById('backdrop').addEventListener('click', closeDrawer);

  // Boot: live-all view + load sessions, refresh the list periodically.
  connect('/api/events', 'Live — all activity');
  loadSessions();
  setInterval(loadSessions, 10000);
})();
</script>
</body>
</html>`;
