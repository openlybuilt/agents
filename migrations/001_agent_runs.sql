CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY,
  instruction text NOT NULL,
  max_steps integer NOT NULL,
  timeout_ms integer NOT NULL,
  status text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
