import { createDb, type Sql } from "./index.js";
import { migrate } from "./migrate.js";

/**
 * Test helper: returns a migrated connection when DATABASE_URL is set, else null
 * so DB-backed suites can `describe.skipIf(!sql)`.
 */
export async function testDb(): Promise<Sql | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const sql = createDb(url, 2);
  await migrate(sql);
  return sql;
}
