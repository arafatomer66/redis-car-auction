import { redis, redisBlocking } from "../config/redis.js";
import { keys } from "../redis/keys.js";

// Phase 15 concept: Stream consumer groups.
//  - XGROUP CREATE   → create the group exactly once per stream
//  - XREADGROUP      → fetch unacked messages addressed to "this group, any consumer"
//  - XACK            → mark message processed; safe to forget
//  - Crashed workers' messages can be reclaimed via XAUTOCLAIM (not shown).
//
// We materialize per-hour stats (count + sum) into a hash for fast dashboard reads.

const STREAM = keys.auditStream();
const GROUP = "analytics";
const CONSUMER = `analytics-${process.pid}`;
const STATS_HASH = "stats:bids:hourly";

export function startAnalyticsWorker() {
  ensureGroup()
    .then(() => loop())
    .catch((err) => console.error("[analytics] init failed", err));
  console.log(`[analytics] started consumer ${CONSUMER} on group ${GROUP}`);
}

async function ensureGroup() {
  try {
    await redis.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM");
    console.log(`[analytics] created group ${GROUP}`);
  } catch (err: any) {
    if (!String(err?.message ?? "").includes("BUSYGROUP")) throw err;
  }
}

async function loop() {
  while (true) {
    try {
      // BLOCK 5000 = wait up to 5s for new events; ">" means "new to this consumer".
      // Uses the dedicated blocking client so the main one stays free.
      const res = (await redisBlocking.xreadgroup(
        "GROUP",
        GROUP,
        CONSUMER,
        "COUNT",
        100,
        "BLOCK",
        5000,
        "STREAMS",
        STREAM,
        ">",
      )) as null | [string, [string, string[]][]][];

      if (!res) continue;
      for (const [, entries] of res) {
        const pipe = redis.pipeline();
        const ids: string[] = [];
        for (const [id, fields] of entries) {
          ids.push(id);
          const m = fieldsToMap(fields);
          const hour = hourBucket(Number(id.split("-")[0]));
          pipe.hincrby(STATS_HASH, `count:${hour}`, 1);
          pipe.hincrbyfloat(STATS_HASH, `sum:${hour}`, Number(m.amount ?? 0));
        }
        pipe.xack(STREAM, GROUP, ...ids);
        await pipe.exec();
      }
    } catch (err) {
      console.error("[analytics] loop error", err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function fieldsToMap(fields: string[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) m[fields[i]] = fields[i + 1];
  return m;
}

function hourBucket(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

export async function recentHourlyStats(): Promise<Record<string, string>> {
  return redis.hgetall(STATS_HASH);
}
