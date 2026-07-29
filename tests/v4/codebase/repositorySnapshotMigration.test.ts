import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { LATEST_SCHEMA_VERSION, MIGRATIONS_FOR_TESTS, runMigrations } from '../../../core/v4/daemon/db/migrations';

let db: Database.Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

function migrateThrough31(database: Database.Database): void {
  for (const migration of MIGRATIONS_FOR_TESTS.filter((item) => item.version <= 31)) {
    database.transaction(() => {
      if (migration.apply) migration.apply(database);
      else database.exec(migration.sql ?? '');
      database.prepare('INSERT OR REPLACE INTO schema_version (id,version,applied_at) VALUES (1,?,?)').run(migration.version, Date.now());
    }).immediate();
  }
}

describe('repository snapshot migration v32', () => {
  it('migrates v31 additively while preserving existing Job and Attempt rows', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrateThrough31(db);
    const now = Date.now();
    db.prepare('INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version) VALUES (?,?,?,?,?,?)').run('instance',1,'host',now,now,'4.17.0');
    db.prepare(`INSERT INTO tasks (id,title,goal,status,created_at,updated_at,session_id,trace_ids,artifact_ids,root_job_id,next_event_sequence) VALUES ('job','job','goal','queued',?,?, 'session','[]','[]','job',1)`).run(now,now);
    db.prepare(`INSERT INTO runs (session_id,instance_id,status,started_at,task_id,attempt_id,attempt_number,generation,state_version,next_event_sequence) VALUES ('session','instance','queued',?,'job','attempt',1,1,0,1)`).run(now);

    const migration = MIGRATIONS_FOR_TESTS.find((item) => item.version === 32)!;
    db.transaction(() => {
      migration.apply!(db!);
      db!.prepare('INSERT OR REPLACE INTO schema_version (id,version,applied_at) VALUES (1,32,?)').run(Date.now());
    }).immediate();
    expect(LATEST_SCHEMA_VERSION).toBe(35);
    expect(db.prepare('SELECT id,status,repository_snapshot_id FROM tasks WHERE id=?').get('job')).toEqual({ id: 'job', status: 'queued', repository_snapshot_id: null });
    expect(db.prepare('SELECT attempt_id,status,repository_snapshot_id FROM runs WHERE attempt_id=?').get('attempt')).toEqual({ attempt_id: 'attempt', status: 'queued', repository_snapshot_id: null });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'repository_%' ORDER BY name").all()).toEqual([
      { name: 'repository_snapshot_entries' }, { name: 'repository_snapshots' },
    ]);
    expect(runMigrations(db)).toEqual({ from: 32, to: 35 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'repository_change_%' ORDER BY name").all()).toEqual([
      { name: 'repository_change_intents' }, { name: 'repository_change_records' },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'validation_%' ORDER BY name").all()).toEqual([
      { name: 'validation_artifacts' }, { name: 'validation_diagnostics' }, { name: 'validation_runs' },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='git_effect_operations'").get())
      .toEqual({ name: 'git_effect_operations' });
    expect(runMigrations(db)).toEqual({ from: 35, to: 35 });
  });

  it('adds validation records to a v33 database without changing repository history', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const migration of MIGRATIONS_FOR_TESTS.filter((item) => item.version <= 33)) {
      db.transaction(() => {
        if (migration.apply) migration.apply(db!);
        else db!.exec(migration.sql ?? '');
        db!.prepare('INSERT OR REPLACE INTO schema_version (id,version,applied_at) VALUES (1,?,?)')
          .run(migration.version, Date.now());
      }).immediate();
    }
    const now = Date.now();
    db.prepare('INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version) VALUES (?,?,?,?,?,?)')
      .run('instance', 1, 'host', now, now, '4.17.0');
    db.prepare(`INSERT INTO tasks
      (id,title,goal,status,created_at,updated_at,session_id,trace_ids,artifact_ids,root_job_id,next_event_sequence)
      VALUES ('job','job','goal','queued',?,?,'session','[]','[]','job',1)`).run(now, now);
    db.prepare(`INSERT INTO runs
      (session_id,instance_id,status,started_at,task_id,attempt_id,attempt_number,generation,state_version,next_event_sequence)
      VALUES ('session','instance','queued',?,'job','attempt',1,1,0,1)`).run(now);

    expect(runMigrations(db)).toEqual({ from: 33, to: 35 });
    expect(db.prepare('SELECT id,status FROM tasks WHERE id=?').get('job')).toEqual({ id: 'job', status: 'queued' });
    expect(db.prepare('SELECT attempt_id,status FROM runs WHERE attempt_id=?').get('attempt'))
      .toEqual({ attempt_id: 'attempt', status: 'queued' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('validation_runs','test_run_details','build_run_details','validation_artifacts','validation_diagnostics') ORDER BY name").all())
      .toEqual([
        { name: 'build_run_details' }, { name: 'test_run_details' }, { name: 'validation_artifacts' },
        { name: 'validation_diagnostics' }, { name: 'validation_runs' },
      ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='git_effect_operations'").get())
      .toEqual({ name: 'git_effect_operations' });
  });
});
