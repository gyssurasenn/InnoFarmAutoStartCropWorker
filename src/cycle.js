import { getPool, sql } from "./db.js";

// One cycle = create waiting crops whose rest days are over, then check every waiting crop's gate.
// All business rules live in the two SPs (frontend repo: migrations/sql/V20260928_02 and _06,
// write-up in CONTEXT2.md §59) - this file only calls them and logs what they return.
//
// GateCheck is called ONCE PER FARM, not once for all farms: starting a crop runs set_production
// for every house (slow), so a single call over many farms could exceed requestTimeout and cancel
// the farms after the slow one. Per farm, a timeout/error only costs that farm this cycle.
//
// dryRun wraps everything in one transaction and rolls it back, so the first run on a new database
// shows what WOULD happen without writing anything. Caveat: if GateCheck hits its own "no flock
// could be created" path it issues ROLLBACK itself, which ends the outer transaction too - that
// farm reports failed and the dry run stops there (nothing is written).
export async function runCycle({ farmCode = null, dryRun = false, nextCheckMinutes = 30 } = {}) {
  const pool = await getPool();
  const tx = dryRun ? new sql.Transaction(pool) : null;
  if (tx) await tx.begin();
  const request = () => (tx ? new sql.Request(tx) : pool.request());

  try {
    const created = (
      await request().input("n_farm", sql.Numeric(18, 0), farmCode).execute("dbo.AutoStartCrop_CreatePending")
    ).recordset || [];

    const farms = (
      await request()
        .input("n_farm", sql.Numeric(18, 0), farmCode)
        .query("SELECT DISTINCT n_farm FROM dbo.Crop_Main WHERE n_active = 3 AND (@n_farm IS NULL OR n_farm = @n_farm) ORDER BY n_farm")
    ).recordset.map((r) => r.n_farm);

    const gate = [];
    for (const farm of farms) {
      const startedAt = Date.now();
      try {
        // nextCheckMinutes → dt_auto_start_next_check that the Manage Production card shows (needs V20260928_06)
        const rows = (
          await request()
            .input("n_farm", sql.Numeric(18, 0), farm)
            .input("n_next_check_minutes", sql.Int, nextCheckMinutes)
            .execute("dbo.AutoStartCrop_GateCheck")
        ).recordset || [];
        const ms = Date.now() - startedAt;
        gate.push(...rows.map((row) => ({ ...row, ms })));
      } catch (err) {
        gate.push({ FarmCode: farm, Status: "failed", Message: `worker: ${err.message}`, ms: Date.now() - startedAt });
        if (tx) break; // the dry-run transaction is gone after an error - nothing more can run in it
      }
    }

    return { created, gate, farms: farms.length };
  } finally {
    if (tx) {
      try {
        await tx.rollback();
      } catch {
        // already rolled back inside GateCheck (see caveat above)
      }
    }
  }
}

const day = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? ""));

export function logCycle({ created, gate, farms }, { dryRun, elapsedMs }) {
  const tag = dryRun ? "[cycle][dry-run]" : "[cycle]";
  for (const row of created) {
    console.log(`${tag} created waiting crop farm=${row.FarmCode} crop=${row.CropCode} main=${row.MainCrop} candidate=${day(row.CandidateDate)}`);
  }

  const counts = {};
  for (const row of gate) {
    counts[row.Status] = (counts[row.Status] || 0) + 1;
    const line =
      `${tag} farm=${row.FarmCode} crop=${row.CropCode ?? "-"} status=${row.Status} candidate=${day(row.CandidateDate)} ` +
      `sampling=${row.Sampling ?? "-"} started=${row.HousesStarted ?? 0} skipped=${row.HousesSkipped ?? 0} ${row.ms}ms` +
      (row.Message ? ` msg="${row.Message}"` : "");
    // failed goes to stderr on purpose: watchdog.js alerts on worker-error.log growth
    if (row.Status === "failed") console.error(line);
    else console.log(line);
  }

  const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ") || "no waiting crops";
  // Logged every cycle unconditionally - this is the heartbeat watchdog.js checks for.
  console.log(`${tag} ${new Date().toISOString()} created=${created.length} farms=${farms} ${summary} took=${elapsedMs}ms`);
}
