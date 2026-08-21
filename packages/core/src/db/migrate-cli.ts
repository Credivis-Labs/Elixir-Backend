import { createDb } from "./index.js";
import { migrate } from "./migrate.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const sql = createDb(url, 1);
try {
  const ran = await migrate(sql);
  console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
} finally {
  await sql.end();
}
