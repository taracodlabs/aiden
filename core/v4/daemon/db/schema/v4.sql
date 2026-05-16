-- v4.5 Phase 4a — email_seen.
-- Per-email forensic record. The in-memory _seenUids set is the
-- hot-path dedup; this table is the cross-restart authority + audit
-- trail. UNIQUE(route_id, uid_validity, uid) defends against IMAP
-- mailbox UIDVALIDITY reset (UIDs can be reused when the server
-- bumps UIDVALIDITY).

CREATE TABLE IF NOT EXISTS email_seen (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id            TEXT    NOT NULL,
  mailbox             TEXT    NOT NULL,
  uid_validity        INTEGER NOT NULL,
  uid                 INTEGER NOT NULL,
  message_id          TEXT,
  from_address        TEXT,
  subject             TEXT,
  received_at         INTEGER NOT NULL,
  processed_at        INTEGER,
  trigger_event_id    INTEGER,
  status              TEXT    NOT NULL,
  FOREIGN KEY (route_id)         REFERENCES triggers(id)        ON DELETE CASCADE,
  FOREIGN KEY (trigger_event_id) REFERENCES trigger_events(id)  ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_seen_route_uid
  ON email_seen(route_id, uid_validity, uid);
CREATE INDEX IF NOT EXISTS idx_email_seen_received
  ON email_seen(received_at);
CREATE INDEX IF NOT EXISTS idx_email_seen_message_id
  ON email_seen(message_id) WHERE message_id IS NOT NULL;
