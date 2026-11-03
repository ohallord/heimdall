import { afterEach, describe, expect, it } from "vitest";
import { getDb, resetDbForTests } from "./client";

describe("getDb recovers after a failed first connect", () => {
  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.HEIMDALL_DB_DRIVER;
    resetDbForTests();
  });

  it("does not cache a rejected connection promise", async () => {
    resetDbForTests();
    delete process.env.HEIMDALL_DB_DRIVER;
    process.env.DATABASE_URL = "postgres://heimdall:x@127.0.0.1:1/heimdall";
    await expect(getDb()).rejects.toBeTruthy();

    // Database "comes back" (here: switch to in-memory pglite).
    delete process.env.DATABASE_URL;
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    const db = await getDb();
    const r = await db.query<{ n: number }>("select 1 as n");
    expect(r.rows[0].n).toBe(1);
  });
});
