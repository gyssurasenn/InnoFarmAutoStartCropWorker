> **RETIRED 2026-09-29** — the team's exe now calls `EXEC dbo.AutoStartCrop_Run @n_farm` at each farm's midnight (frontend repo
> `CONTEXT2.md §61`). This worker still calls the old SPs (`CreatePending`/`GateCheck`) and must be uninstalled
> (`.\scripts\uninstall-service.ps1` + `schtasks /delete /tn InnoFarmAutoStartCropWatchdog /f`) before `AutoStartCrop_Run` goes live.

# InnoFarm Auto Start Crop Worker

Windows Service (Node.js + NSSM) that runs the **Auto start new crop** feature of SmartFarm Pro /
InnoFarmPro. Once a day (`RUN_AT`, default just after midnight) it calls two stored procedures and logs
what they did (design changed 2026-09-29, frontend repo `CONTEXT2.md §60`):

1. `dbo.AutoStartCrop_CreatePending` — for farms with *Enable auto start new crop* on, whose last crop
   has ended and whose rest days (`Farm_Option.n_auto_start_rest_days`) are over: create the next crop
   as **waiting** (`Crop_Main.n_active = 3`) together with its per-house flock plan
   (`dbo.AutoStartCrop_Plan`, copied from the last finished crop) so the Manage Production page shows it.
2. `dbo.AutoStartCrop_GateCheck` — for every waiting crop whose day has **ended**: if the farm's total
   CKALE sampling of that day (raw `ColSummary.n_num`) was > 100, start it on that day (`n_active 3 → 1`,
   flocks created from the plan). If not, the plan's start date moves to today (end/catch dates follow).
   Calling it more often is harmless — during the waiting day it only records today's sampling.

All logic is in the SPs, so the team's own exe can replace this worker by running the same two `EXEC`s
once after midnight. `RUN_AT` blank → runs every `CYCLE_INTERVAL_MS` instead (testing / demo).

`GateCheck` is called **once per farm** that has a waiting crop (not once for all farms): starting a
crop runs `set_production` for every house, so one call over many farms could hit `DB_REQUEST_TIMEOUT_MS`
and cancel every farm after the slow one. Per farm, a timeout/error only costs that farm one cycle, and
each log line shows how long that farm took (`…ms`) plus a `took=` total per cycle.

All rules live in the SPs, not here. Source + write-up are in the frontend repo:
`migrations/sql/V20260928_01..04` and `CONTEXT2.md §59`.

## Requirements (must be on the target DB before starting the service)

| What | Where (frontend repo) |
|---|---|
| Migrations `V20260916_02`, `V20260917_02`, `V20260928_01`–`_04` | `node migrations/cli.js migrate --env=<env> --confirm` |
| `Interface_Advanced` patch: SettingNewCrop replaces a waiting crop | `src/SP_auto_start_crop_setting_new_crop_pending.md` |
| `Interface_Advanced` patch: hide waiting crops from crop lists | `src/SP_auto_start_crop_hide_pending_pending.md` |
| Frontend that knows `StatusCrop = 3` | `Manage_productVersionThree.jsx`, `utils/cropStatus.js` |

Deploy order: migrations → SP patches (SSMS) → frontend → this worker. Without the frontend and the
"hide" patch, a waiting crop becomes the "current crop" everywhere in the app.

## Setup

```powershell
copy .env.example .env      # fill in DB_* (same DB as RESTAPI_TAT's Web.config)
npm install
npm run dry-run             # one cycle inside a transaction that is rolled back - writes nothing
npm run once                # one real cycle
```

Output per waiting crop: `status=waiting_online | waiting_sampling | started | failed | skipped`.
`failed` lines go to stderr (→ `logs/worker-error.log`), so the watchdog alerts on them.

`FARM_CODE=<n>` in `.env` limits the worker to one farm (useful for a pilot).

## Install as a Windows Service (PowerShell as Administrator)

```powershell
.\scripts\install-service.ps1 -NssmPath "C:\tools\nssm.exe"
# if "node.exe not found" although node -v works:
.\scripts\install-service.ps1 -NssmPath "C:\tools\nssm.exe" -NodeExe "C:\Program Files\nodejs\node.exe"
```

Service name `InnoFarmAutoStartCropWorker`. Logs: `logs\worker.log`, `logs\worker-error.log`.
Remove with `.\scripts\uninstall-service.ps1`.

## Watchdog (Task Scheduler, every 15 minutes)

```powershell
schtasks /create /tn "InnoFarmAutoStartCropWatchdog" /tr "\"C:\path\to\this\folder\run-watchdog.bat\"" /sc minute /mo 15 /ru SYSTEM
```

It alerts once (on the state change, and again when it recovers) to the LINE test channel through
`dbo.Log_Interfaces` when: the service isn't RUNNING, `worker.log` has had no cycle line for 3 cycles,
or `worker-error.log` grew (a DB error or a crop that failed to start).

## Notes

- Test database only for local runs — never point a local copy at production: two workers would both
  create/start crops.
- `npm run dry-run` caveat: if GateCheck rolls back a failed start itself, the dry run's transaction
  ends there and the remaining farms are not checked (still nothing is written).
- The SP's farm "today" follows `Farm.c_timezone`, the same formula `Interface_Advanced` uses.
# InnoFarmAutoStartCropWorker
