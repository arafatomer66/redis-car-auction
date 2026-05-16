import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "../config/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function run() {
  const dir = join(__dirname, "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const sql = await readFile(join(dir, file), "utf8");
    console.log(`[migrate] applying ${file}`);
    await pool.query(sql);
  }
  console.log("[migrate] done");
  await pool.end();
}

run().catch((err) => {
  console.error("[migrate] failed", err);
  process.exit(1);
});
