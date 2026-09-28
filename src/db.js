import sql from "mssql";
import { config } from "./config.js";

let poolPromise = null;

/** Shared connection pool - call getPool() wherever a query is needed, don't open new connections per-call. */
export function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(config.db).then((pool) => {
      // A lost connection otherwise errors silently; drop the cached pool so the next cycle reconnects.
      pool.on("error", (err) => {
        console.error("[db] pool error", err.message);
        poolPromise = null;
      });
      return pool;
    }).catch((err) => {
      poolPromise = null; // allow retry on next call instead of caching a rejected promise forever
      throw err;
    });
  }
  return poolPromise;
}

export { sql };
