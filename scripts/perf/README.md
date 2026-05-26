# scripts/perf/

Diagnostic + smoke utilities accumulated during the v4.10 sprint.
Kept for future regression triage; not run as part of CI or
`npm test`. Each script targets a specific slice or symptom.

| Script | Slice / target | What it does |
|---|---|---|
| `perf-diag.mjs` | 10.6c perf diagnosis | Row counts, hot-path query timings (5-sample best-of), index coverage check (EXPLAIN QUERY PLAN), INSERT timing on a fresh tmp DB |
| `smoke-slice10.2b.mjs` | 10.2b initial verify | Reads production daemon.db post-migration: schema_version, run_events shape, index count |
| `smoke-slice10.2b-simple.mjs` | 10.2b daemon-emission verify | Confirms REPL vs daemon emission shapes in production rows |
| `smoke-slice10.2b-pty.mjs` | 10.2b PTY-driven (deferred) | Attempted PTY-driven D.2 smoke; defer per Slice 10.4 limitations |
| `smoke-slice10.2c-diagnose.mjs` | 10.2c between-turns bug | Read latest REPL run, dump events for `/trace recent` regression hunt |
| `smoke-slice10.2c.mjs` | 10.2c fix verification | Exercises the `chatSessionId` long-lived ref path against an isolated DB |
| `smoke-slice10.6-diagnose.mjs` | 10.6 approval-not-firing report | Pulls approval rows from the latest REPL run to diagnose smart-mode auto-allow |

Run from repo root, e.g. `node scripts/perf/perf-diag.mjs`.
