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
    const result = await runCycle({ farmCode: config.farmCode, dryRun });
    logCycle(result, { dryRun });
    return true;
  } catch (err) {
    console.error(`[cycle] ${new Date().toISOString()} failed:`, err.message);
    return false;
  }
}

async function main() {
  console.log(
    `[index] auto-start-crop worker starting db=${config.db.database} farm=${config.farmCode ?? "all"} ` +
    (once ? `mode=once${dryRun ? " dry-run" : ""}` : `interval=${config.cycleIntervalMs / 60000}min`)
  );

  if (once) {
    const ok = await cycle();
    const pool = await getPool().catch(() => null);
    if (pool) await pool.close();
    process.exit(ok ? 0 : 1);
  }

  // setTimeout after each cycle finishes (not setInterval) so a slow GateCheck can never overlap the next one.
  let timer = null;
  const loop = async () => {
    await cycle();
    timer = setTimeout(loop, config.cycleIntervalMs);
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
