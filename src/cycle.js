import { getPool, sql } from "./db.js";

// One cycle = create waiting crops whose rest days are over, then check every waiting crop's gate.
// All business rules live in the two SPs (frontend repo: migrations/sql/V20260928_02 and _04,
// write-up in CONTEXT2.md §59) - this file only calls them and logs what they return.
//
// dryRun wraps both calls in one transaction and rolls it back, so the first run on a new database
// shows what WOULD happen without writing anything. Caveat: if GateCheck hits its own "no flock
// could be created" path it issues ROLLBACK itself, which ends the outer transaction too - the
// cycle then reports that crop as failed and the rest of the dry run stops (nothing is written).
export async function runCycle({ farmCode = null, dryRun = false } = {}) {
  const pool = await getPool();
  const tx = dryRun ? new sql.Transaction(pool) : null;
  if (tx) await tx.begin();
  const request = () => (tx ? new sql.Request(tx) : pool.request());

  try {
    const created = (
      await request().input("n_farm", sql.Numeric(18, 0), farmCode).execute("dbo.AutoStartCrop_CreatePending")
    ).recordset || [];

    const gate = (
      await request().input("n_farm", sql.Numeric(18, 0), farmCode).execute("dbo.AutoStartCrop_GateCheck")
    ).recordset || [];

    return { created, gate };
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

export function logCycle({ created, gate }, { dryRun }) {
  const tag = dryRun ? "[cycle][dry-run]" : "[cycle]";
  for (const row of created) {
    console.log(`${tag} created waiting crop farm=${row.FarmCode} crop=${row.CropCode} main=${row.MainCrop} candidate=${day(row.CandidateDate)}`);
  }

  const counts = {};
  for (const row of gate) {
    counts[row.Status] = (counts[row.Status] || 0) + 1;
    const line =
      `${tag} farm=${row.FarmCode} crop=${row.CropCode} status=${row.Status} candidate=${day(row.CandidateDate)} ` +
      `sampling=${row.Sampling ?? "-"} started=${row.HousesStarted} skipped=${row.HousesSkipped}` +
      (row.Message ? ` msg="${row.Message}"` : "");
    // failed goes to stderr on purpose: watchdog.js alerts on worker-error.log growth
    if (row.Status === "failed") console.error(line);
    else console.log(line);
  }

  const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ") || "no waiting crops";
  // Logged every cycle unconditionally - this is the heartbeat watchdog.js checks for.
  console.log(`${tag} ${new Date().toISOString()} created=${created.length} ${summary}`);
}
