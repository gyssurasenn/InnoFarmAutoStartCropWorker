import "dotenv/config";

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name} (copy .env.example to .env and fill it in)`);
  return val;
}

// "MYPC\SQLEXPRESS" (named instance) needs server + options.instanceName - passing port too is
// ambiguous and tedious rejects it, so port is only used for a plain host with no instance name.
const rawServer = process.env.DB_SERVER || "localhost";
const [dbServer, dbInstanceName] = rawServer.split("\\");

export const config = {
  db: {
    server: dbServer,
    ...(dbInstanceName ? {} : { port: Number(process.env.DB_PORT || 1433) }),
    database: required("DB_NAME"),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    // Same lesson as the climate-alarm worker (2026-07-18): without explicit timeouts a silently
    // dropped connection hangs a query forever with nothing in the error log. This budget is per
    // call and cycle.js calls GateCheck once per farm, so it only has to cover starting ONE farm
    // (set_production for each of its houses).
    requestTimeout: Number(process.env.DB_REQUEST_TIMEOUT_MS || 120000),
    connectionTimeout: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 15000),
    options: {
      encrypt: process.env.DB_ENCRYPT === "true",
      trustServerCertificate: process.env.DB_TRUST_SERVER_CERT !== "false",
      ...(dbInstanceName ? { instanceName: dbInstanceName } : {}),
    },
  },
  cycleIntervalMs: Number(process.env.CYCLE_INTERVAL_MS || 1800000),
  // "HH:mm" (server local time) = run once a day at that time + once at startup; blank = every CYCLE_INTERVAL_MS.
  // GateCheck only decides a waiting crop after its day has ended, so one run just after midnight is enough.
  runAt: /^\d{1,2}:\d{2}$/.test((process.env.RUN_AT || "").trim()) ? process.env.RUN_AT.trim() : null,
  farmCode: process.env.FARM_CODE ? Number(process.env.FARM_CODE) : null,
};
