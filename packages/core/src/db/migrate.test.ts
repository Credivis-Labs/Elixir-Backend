import { afterAll, describe, expect, it } from "vitest";
import { testDb } from "./test-db.js";

const sql = await testDb();

describe.skipIf(!sql)("migrate", () => {
  afterAll(async () => sql?.end());

  it("is idempotent and creates core tables", async () => {
    const rows = await sql!<{ tableName: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name in ('accounts', 'account_signers')`;
    expect(rows).toHaveLength(2);
  });
});
