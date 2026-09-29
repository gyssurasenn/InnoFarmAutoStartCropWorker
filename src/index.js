import { config } from "./config.js";
import { getPool } from "./db.js";
import { runCycle, logCycle } from "./cycle.js";

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const dryRun = args.has("--dry-run");

if (dryRun && !once) {
  console.error("--dry-run only makes sense with --once (npm run dry-run)");
  process.exit(1);
}

async function cycle() {
  try {
    const startedAt = Date.now();
    const result = await runCycle({
      farmCode: config.farmCode,
      dryRun,
      nextCheckMinutes: Math.round(config.cycleIntervalMs / 60000),
    });
    logCycle(result, { dryRun, elapsedMs: Date.now() - startedAt });
    return true;
  } catch (err) {
    console.error(`[cycle] ${new Date().toISOString()} failed:`, err.message);
    return false;
  }
}

async function main() {
  console.log(
    `[index] auto-start-crop worker starting db=${config.db.database} farm=${config.farmCode ?? "all"} ` +
    (once
      ? `mode=once${dryRun ? " dry-run" : ""}`
      : config.runAt
        ? `daily at ${config.runAt}`
        : `interval=${config.cycleIntervalMs / 60000}min`)
  );

  if (once) {
    const ok = await cycle();
    const pool = await getPool().catch(() => null);
    if (pool) await pool.close();
    process.exit(ok ? 0 : 1);
  }

  // setTimeout after each cycle finishes (not setInterval) so a slow GateCheck can never overlap the next one.
  // The wait is measured from the cycle's START, not its end: GateCheck stores dt_auto_start_next_check as
  // "its own start + interval" and the Manage Production card refetches at that time. Waiting a full interval
  // after the end made every cycle late by its own duration (seen as ~15 s on the card) and drift cycle by cycle.
  // RUN_AT mode: next run = next occurrence of HH:mm (server local time). The first run happens at startup so a
  // restart after a missed midnight catches up (GateCheck walks every waiting day that has already ended).
  const msUntilRunAt = () => {
    const [h, m] = config.runAt.split(":").map(Number);
    const now = new Date();
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  };

  let timer = null;
  const loop = async () => {
    const startedAt = Date.now();
    await cycle();
    timer = setTimeout(
      loop,
      config.runAt ? msUntilRunAt() : Math.max(config.cycleIntervalMs - (Date.now() - startedAt), 0)
    );
  };

  const shutdown = async (signal) => {
    console.log(`[index] ${signal} received, stopping`);
    clearTimeout(timer);
    const pool = await getPool().catch(() => null);
    if (pool) await pool.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await loop();
}

main();
