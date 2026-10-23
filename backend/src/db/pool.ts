import pg from "pg";
import { readFileSync } from "node:fs";
import { config } from "../config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

const MIGRATIONS = ["001_init.sql", "002_changes.sql", "003_builds.sql"];

export async function migrate() {
  for (const f of MIGRATIONS) {
    const sql = readFileSync(new URL("./" + f, import.meta.url), "utf8");
    await pool.query(sql);
  }
}
