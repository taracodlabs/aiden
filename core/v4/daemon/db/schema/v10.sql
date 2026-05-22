-- v4.9.0 Slice 7 — external trace adoption.
-- Aiden keeps its typed `trc_<uuidv7>` ID as the primary trace_id; the
-- W3C `traceparent` 32-hex traceId is stored alongside in this column
-- so an external caller correlating across services can match either.
ALTER TABLE spans ADD COLUMN external_trace_id TEXT;
ALTER TABLE runs  ADD COLUMN external_trace_id TEXT;
CREATE INDEX IF NOT EXISTS idx_spans_external_trace
  ON spans(external_trace_id) WHERE external_trace_id IS NOT NULL;
