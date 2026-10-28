ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS workflow jsonb;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS steps jsonb;
