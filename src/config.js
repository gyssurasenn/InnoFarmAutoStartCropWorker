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
    // dropped connection hangs a query forever with nothing in the error log. GateCheck starts
    // flocks through set_production, which is slow on a big farm, so it gets a longer budget.
    requestTimeout: Number(process.env.DB_REQUEST_TIMEOUT_MS || 120000),
    connectionTimeout: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 15000),
    options: {
      encrypt: process.env.DB_ENCRYPT === "true",
      trustServerCertificate: process.env.DB_TRUST_SERVER_CERT !== "false",
      ...(dbInstanceName ? { instanceName: dbInstanceName } : {}),
    },
  },
  cycleIntervalMs: Number(process.env.CYCLE_INTERVAL_MS || 1800000),
  farmCode: process.env.FARM_CODE ? Number(process.env.FARM_CODE) : null,
};
