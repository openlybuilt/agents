import { readFile } from "node:fs/promises";
import pg from "pg";
import type { RunRecord, RunRequest } from "./contracts.js";

export class RunStore {
  readonly pool: pg.Pool;
  private readonly lock: pg.Client;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url });
    this.lock = new pg.Client({ connectionString: url });
    this.lock.on("error", () => {
      console.error("Database ownership connection lost");
      process.exit(1);
    });
  }
  async initialize(): Promise<void> {
    await this.lock.connect();
    const lock = await this.lock.query(
      "SELECT pg_try_advisory_lock(78422116) AS acquired",
    );
    if (!lock.rows[0].acquired)
      throw new Error("Another agents service owns this database");
    const migration = await readFile(
      new URL("../../migrations/001_agent_runs.sql", import.meta.url),
      "utf8",
    );
    await this.pool.query(migration);
    await this.pool.query(
      "UPDATE agent_runs SET status = 'interrupted', updated_at = now() WHERE status IN ('provisioning', 'running', 'cleaning_up', 'cancelling')",
    );
  }
  async create(
    request: RunRequest,
  ): Promise<{ record: RunRecord; created: boolean }> {
    const inserted = await this.pool.query(
      "INSERT INTO agent_runs (id, instruction, max_steps, timeout_ms, status) VALUES ($1,$2,$3,$4,'provisioning') ON CONFLICT (id) DO NOTHING RETURNING id",
      [request.id, request.instruction, request.maxSteps, request.timeoutMs],
    );
    const record = await this.get(request.id);
    if (!record) throw new Error("Run insert failed");
    if (
      record.instruction !== request.instruction ||
      record.maxSteps !== request.maxSteps ||
      record.timeoutMs !== request.timeoutMs
    )
      throw new Error("Run ID already has different inputs");
    return { record, created: (inserted.rowCount ?? 0) > 0 };
  }
  async get(id: string): Promise<RunRecord | undefined> {
    const result = await this.pool.query(
      'SELECT id, instruction, max_steps AS "maxSteps", timeout_ms AS "timeoutMs", status, result, created_at AS "createdAt", updated_at AS "updatedAt" FROM agent_runs WHERE id = $1',
      [id],
    );
    return result.rows[0] as RunRecord | undefined;
  }
  async status(id: string, status: string, result?: unknown): Promise<void> {
    await this.pool.query(
      "UPDATE agent_runs SET status=$2, result=COALESCE($3::jsonb,result), updated_at=now() WHERE id=$1 AND (status <> 'cancelling' OR $2 NOT IN ('running', 'cleaning_up')) AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')",
      [id, status, result === undefined ? null : JSON.stringify(result)],
    );
  }
  async close(): Promise<void> {
    await this.pool.end();
    await this.lock.end();
  }
}
