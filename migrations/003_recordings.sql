CREATE TABLE IF NOT EXISTS run_recordings (
  run_id uuid PRIMARY KEY REFERENCES agent_runs(id),
  video bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
