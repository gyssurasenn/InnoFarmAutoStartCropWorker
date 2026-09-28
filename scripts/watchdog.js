// Health-check for the InnoFarmAutoStartCropWorker Windows Service - run periodically via Windows
// Task Scheduler (run-watchdog.bat + the schtasks command in README.md), NOT as a long-running process.
// Same design as the climate-alarm worker's watchdog: check service status, heartbeat freshness,
// and error-log growth; alert through dbo.Log_Interfaces (the already-working LINE dispatcher) only
// on state transitions, tracked in logs/watchdog-state.json.
//
// Error-log growth also covers crops GateCheck reports as "failed" - cycle.js writes those to stderr.

import { execSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "../src/config.js";
import { getPool, sql } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");

const SERVICE_NAME = "InnoFarmAutoStartCropWorker";
const LOG_PATH = path.join(PROJECT_DIR, "logs", "worker.log");
const ERROR_LOG_PATH = path.join(PROJECT_DIR, "logs", "worker-error.log");
const STATE_PATH = path.join(PROJECT_DIR, "logs", "watchdog-state.json");

// cycle.js logs a summary line every cycle (default 30 min). 3x the interval = a missed cycle is
// tolerated, two in a row is treated as a hang.
const STALE_MS = config.cycleIntervalMs * 3;

// The team's own test channel for infra alerts (same target the climate-alarm watchdog uses).
const LINE_TARGET = "Yo#TestSendNotify";

function getServiceStatus() {
  try {
    const out = execSync(`sc query "${SERVICE_NAME}"`, { encoding: "utf8" });
    const match = out.match(/STATE\s*:\s*\d+\s+(\w+)/);
    return match ? match[1] : "UNKNOWN";
  } catch {
    return "NOT_INSTALLED";
  }
}

function getLogAgeMs() {
  if (!existsSync(LOG_PATH)) return Infinity;
  return Date.now() - statSync(LOG_PATH).mtimeMs;
}

function getErrorLogSize() {
  if (!existsSync(ERROR_LOG_PATH)) return 0;
  return statSync(ERROR_LOG_PATH).size;
}

function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function formatThaiDateTime(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function sendAlert(message) {
  const pool = await getPool();
  await pool
    .request()
    .input("msg", sql.NVarChar(1000), message)
    .input("target", sql.NVarChar(255), LINE_TARGET)
    .query(`
      INSERT INTO dbo.Log_Interfaces
        (dt_insert, c_interfaces, c_line, c_line_new, c_function, dt_time, c_msg, c_path)
      VALUES
        (GETDATE(), NULL, NULL, @target, N'Auto Start Crop Worker Watchdog', GETDATE(), @msg, NULL)
    `);
}

async function main() {
  const status = getServiceStatus();
  const logAgeMs = getLogAgeMs();
  const errorLogSize = getErrorLogSize();
  const state = loadState();
  const isFirstRun = state === null;
  // First run baselines to the current size so old error content doesn't read as new.
  const prevErrorSize = isFirstRun ? errorLogSize : state.lastErrorSize;
  const wasAlerting = isFirstRun ? false : state.alerting;

  const problems = [];
  if (status !== "RUNNING") problems.push(`Service สถานะ : ${status} (ต้องเป็น RUNNING)`);
  if (logAgeMs > STALE_MS) problems.push(`worker.log ไม่มีอะไรใหม่มา ${Math.round(logAgeMs / 60000)} นาทีแล้ว (อาจค้าง)`);
  if (errorLogSize > prevErrorSize) problems.push(`worker-error.log มีข้อมูลใหม่ (${prevErrorSize} -> ${errorLogSize} bytes) — อาจมี crop ที่เริ่มไม่สำเร็จ`);

  const isProblem = problems.length > 0;
  const when = formatThaiDateTime(new Date());

  if (isProblem && !wasAlerting) {
    await sendAlert(
      `🚨 InnoFarmAutoStartCropWorker แจ้งเตือน\n` +
      `พบปัญหา :\n- ${problems.join("\n- ")}\n` +
      `เวลา : ${when}`
    );
    console.log(`[watchdog] alerted: ${problems.join("; ")}`);
  } else if (!isProblem && wasAlerting) {
    await sendAlert(`✅ InnoFarmAutoStartCropWorker กลับมาทำงานปกติแล้ว\nเวลา : ${when}`);
    console.log("[watchdog] recovered, sent all-clear");
  } else {
    console.log(
      `[watchdog] status=${status} logAgeSec=${Math.round(logAgeMs / 1000)} errorLogSize=${errorLogSize} - ` +
      (isProblem ? "still a problem, already alerted" : "healthy")
    );
  }

  saveState({ alerting: isProblem, lastErrorSize: errorLogSize });
  process.exit(0);
}

main().catch((err) => {
  // Can't alert about the DB being down through that same DB - log to Task Scheduler history instead.
  console.error("[watchdog] fatal error running watchdog itself:", err);
  process.exit(1);
});
