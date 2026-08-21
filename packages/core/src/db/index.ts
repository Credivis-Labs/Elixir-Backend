import postgres from "postgres";

export type Sql = postgres.Sql;
export type TransactionSql = postgres.TransactionSql;

export function createDb(url: string, max = 10): Sql {
  return postgres(url, {
    max,
    transform: postgres.camel,
  });
}

export { migrate } from "./migrate.js";
