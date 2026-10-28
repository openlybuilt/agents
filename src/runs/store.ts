import { isDeepStrictEqual } from "node:util";
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
    const workflowMigration = await readFile(
      new URL("../../migrations/002_workflow_runs.sql", import.meta.url),
      "utf8",
    );
    await this.pool.query(workflowMigration);
    await this.pool.query(
      "UPDATE agent_runs SET status = 'interrupted', updated_at = now() WHERE status IN ('provisioning', 'running', 'cleaning_up', 'cancelling')",
    );
  }
  async create(
    request: RunRequest,
  ): Promise<{ record: RunRecord; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        "INSERT INTO agent_runs (id, instruction, max_steps, timeout_ms, status, workflow) VALUES ($1,$2,$3,$4,'provisioning',$5::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id",
        [
          request.id,
          request.instruction,
          request.maxSteps,
          request.timeoutMs,
          request.workflow ? JSON.stringify(request.workflow) : null,
        ],
      );
      const fetched = await client.query(
        'SELECT id, instruction, max_steps AS "maxSteps", timeout_ms AS "timeoutMs", status, result, workflow, steps, created_at AS "createdAt", updated_at AS "updatedAt" FROM agent_runs WHERE id=$1',
        [request.id],
      );
      const record = fetched.rows[0] as RunRecord | undefined;
      if (!record) throw new Error("Run insert failed");
      if (
        record.instruction !== request.instruction ||
        record.maxSteps !== request.maxSteps ||
        record.timeoutMs !== request.timeoutMs ||
        !isDeepStrictEqual(record.workflow ?? null, request.workflow ?? null)
      )
        throw new Error("Run ID already has different inputs");
      await client.query("COMMIT");
      return { record, created: (inserted.rowCount ?? 0) > 0 };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(id: string): Promise<RunRecord | undefined> {
    const result = await this.pool.query(
      'SELECT id, instruction, max_steps AS "maxSteps", timeout_ms AS "timeoutMs", status, result, workflow, steps, created_at AS "createdAt", updated_at AS "updatedAt" FROM agent_runs WHERE id = $1',
      [id],
    );
    return result.rows[0] as RunRecord | undefined;
  }
  async status(id: string, status: string, result?: unknown): Promise<void> {
    await this.pool.query(
      "UPDATE agent_runs SET status=$2, result=COALESCE($3::jsonb,result), steps=COALESCE($4::jsonb,steps), updated_at=now() WHERE id=$1 AND (status <> 'cancelling' OR $2 NOT IN ('running', 'cleaning_up')) AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')",
      [
        id,
        status,
        result === undefined ? null : JSON.stringify(result),
        result && typeof result === "object" && "steps" in result
          ? JSON.stringify(result.steps)
          : null,
      ],
    );
  }
  async progress(id: string, steps: unknown): Promise<void> {
    await this.pool.query(
      "UPDATE agent_runs SET steps=$2::jsonb, updated_at=now() WHERE id=$1 AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')",
      [id, JSON.stringify(steps)],
    );
  }
  async close(): Promise<void> {
    await this.pool.end();
    await this.lock.end();
  }
}
