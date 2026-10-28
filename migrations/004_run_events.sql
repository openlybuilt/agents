CREATE TABLE IF NOT EXISTS run_events (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  event jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_run_id_id ON run_events(run_id, id);
