import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { createPresenceAuthority } from '../../../core/v4/presence/presenceAuthority';
import { projectDurablePresenceObservations, reconcileDurablePresence } from '../../../core/v4/presence/sourceProjection';

describe('durable Presence source projection', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });
  afterEach(() => db.close());

  it('is a bounded projection over empty canonical stores, not a second event log', () => {
    expect(projectDurablePresenceObservations(db)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM presence_item_events').get()).toEqual({ count: 0 });
  });

  it('projects budget and connected-account truth and resolves them when the source recovers', () => {
    db.prepare(
      `INSERT INTO tasks (id,title,goal,status,created_at,updated_at,channel_id,session_id,trace_ids,artifact_ids,workspace_id)
       VALUES ('job_1','Job','Inspect repository','running',1,1,'workbench','session_1','[]','[]','workspace_1')`,
    ).run();
    db.prepare(
      `INSERT INTO job_budgets (job_id,kind,limit_value,used_value,has_unknown_usage,state_version,updated_at)
       VALUES ('job_1','model_calls',10,9,0,1,2)`,
    ).run();
    db.prepare(
      `INSERT INTO connected_accounts (
         account_id,provider_id,toolkit_id,owner_id,workspace_id,label,provider_account_ref,status,health,created_at,updated_at
       ) VALUES ('account_1','composio','slack','owner_1','workspace_1','Slack','provider-ref','degraded','expired',1,2)`,
    ).run();
    const authority = createPresenceAuthority({ db, enabled: true, now: () => 10 });
    expect(reconcileDurablePresence({ db, authority })).toMatchObject({ failed: 0 });
    expect(authority.list().map((item) => item.category)).toEqual(expect.arrayContaining(['budget_attention', 'connection_blocker']));

    db.prepare(`UPDATE job_budgets SET used_value=1,updated_at=11 WHERE job_id='job_1' AND kind='model_calls'`).run();
    db.prepare(`UPDATE connected_accounts SET status='active',health='healthy',updated_at=11 WHERE account_id='account_1'`).run();
    reconcileDurablePresence({ db, authority });
    expect(authority.list().filter((item) => ['budget_attention', 'connection_blocker'].includes(item.category)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ state: 'resolved' }), expect.objectContaining({ state: 'resolved' })]));
  });
});
