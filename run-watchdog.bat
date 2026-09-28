@echo off
REM Wrapper so Task Scheduler always runs watchdog.js with this project folder as the working
REM directory (schtasks /create has no direct "start in" switch) - config.js's dotenv/config load
REM depends on process.cwd() finding .env here.
cd /d "%~dp0"
node scripts\watchdog.js >> logs\watchdog.log 2>&1
