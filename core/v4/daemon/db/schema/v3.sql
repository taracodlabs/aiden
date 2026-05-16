-- v4.5 Phase 3 — webhook_deliveries.
-- Forensic record of every webhook POST. Kept for AIDEN_DAEMON_WEBHOOK_RETENTION_DAYS
-- (default 7 days), swept on boot + every 24h.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id            TEXT    NOT NULL,
  delivery_id         TEXT,
  signature_verified  INTEGER NOT NULL,
  status_code         INTEGER NOT NULL,
  response_body       TEXT,
  client_ip           TEXT,
  headers_json        TEXT,
  body_hash           TEXT    NOT NULL,
  received_at         INTEGER NOT NULL,
  processed_at        INTEGER,
  trigger_event_id    INTEGER,
  FOREIGN KEY (route_id)         REFERENCES triggers(id)        ON DELETE CASCADE,
  FOREIGN KEY (trigger_event_id) REFERENCES trigger_events(id)  ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_route_time
  ON webhook_deliveries(route_id, received_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_deliveries_delivery
  ON webhook_deliveries(route_id, delivery_id) WHERE delivery_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_received
  ON webhook_deliveries(received_at);
