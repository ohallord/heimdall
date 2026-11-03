import { migrateSecrets } from "./secrets";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SqlClient } from "./types";

let clientPromise: Promise<SqlClient> | null = null;
let schemaApplied = false;

function schemaPath(): string {
  return path.join(process.cwd(), "db", "schema.sql");
}

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
}

async function applySchema(client: SqlClient): Promise<void> {
  if (schemaApplied) return;
  const sql = readFileSync(schemaPath(), "utf8");
  for (const statement of splitSqlStatements(sql)) {
    await client.query(statement);
  }
  schemaApplied = true;
}

async function createPgliteClient(): Promise<SqlClient> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  return {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      const result = await db.query<T>(text, params);
      return { rows: result.rows ?? [], rowCount: result.rows?.length ?? 0 };
    },
    async end() {
      await db.close();
    },
  };
}

async function createPgClient(databaseUrl: string): Promise<SqlClient> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      const result = await pool.query(text, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
    async end() {
      await pool.end();
    },
  };
}

export function resetDbForTests(): void {
  clientPromise = null;
  schemaApplied = false;
}

export async function getDb(): Promise<SqlClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const url = process.env.DATABASE_URL?.trim() ?? "";
      const useMemory =
        !url ||
        url === "pglite" ||
        url.startsWith("pglite:") ||
        process.env.HEIMDALL_DB_DRIVER === "pglite";

      const client = useMemory
        ? await createPgliteClient()
        : await createPgClient(url);

      await applySchema(client);
      await migrateSecrets(client);
      return client;
    })();
    // Never cache a failure: if the DB was down at first use, retry on the next call
    // instead of serving the same rejected promise until the process restarts.
    const attempt = clientPromise;
    attempt.catch(() => {
      if (clientPromise === attempt) clientPromise = null;
    });
  }
  return clientPromise;
}

export async function withDb<T>(fn: (db: SqlClient) => Promise<T>): Promise<T> {
  const db = await getDb();
  return fn(db);
}
