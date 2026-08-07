@echo off
setlocal EnableExtensions
REM Agent Society Server Startup Script (Windows) - Node.js Edition
REM
REM Usage:
REM   start_node.cmd [data_dir] [options]
REM
REM Options:
REM   --port, -p <port>  HTTP server port (default: 3000)
REM   --no-browser       Do not open browser automatically
REM
REM Examples:
REM   start_node.cmd                           # Use default configuration
REM   start_node.cmd ./my-data                 # Custom data directory
REM   start_node.cmd --port 3001               # Custom port
REM   start_node.cmd ./my-data -p 3001 --no-browser

REM Switch to script directory.
REM Cache the directory first so paths with parentheses do not break later parsing.
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

REM ============================================================
REM Memory limit configuration (prevent process exit caused by oversized RSS)
REM ============================================================
REM Set V8 heap memory limit to 4GB
set "NODE_OPTIONS=--max-old-space-size=4096 --expose-gc"

REM Enable forced GC interval (every 5 minutes)
set "AGENT_SOCIETY_GC_INTERVAL_MS=300000"

echo.
echo [INFO] Memory limits configured:
echo        - V8 heap memory limit: 4GB
echo        - Forced GC interval: 5 minutes
echo.

echo.
echo ============================================================
echo           Agent Society Startup Script (Node.js)
echo ============================================================
echo.

REM ============================================================
REM Step 0: Check whether code update is needed
REM ============================================================
if not exist ".git" goto :skip_code_update
echo [0/3] Trying to update code...
git pull 2>nul
if %ERRORLEVEL% NEQ 0 echo      git pull skipped ^(git may be missing or network issue^)
echo.
goto :detect_node

:skip_code_update
echo [0/3] Skipping code update ^(distribution package mode^)
echo.

REM ============================================================
REM Step 1: Detect Node.js runtime
REM ============================================================
:detect_node
echo [1/3] Detecting Node.js runtime...

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 goto :use_system_node

REM Node.js is not installed
echo.
echo      Node.js is not installed or not found in PATH.
echo      This script requires Node.js to run.
echo      Please install Node.js from https://nodejs.org, then rerun this script.
echo.
exit /b 1

:use_system_node
REM Display Node.js version
for /f "tokens=*" %%i in ('node -v 2^>nul') do set "NODE_VERSION=%%i"
echo      Using system Node.js: %NODE_VERSION%
set "NODE_CMD=node"

:install_deps
REM Install dependencies
echo.
echo [2/3] Installing project dependencies...
echo      Running: npm install
echo.
call npm install --registry https://registry.npmmirror.com

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Error: dependency installation failed
    echo Solution: check network connection, or verify package.json
    exit /b 1
)

REM Start server
echo.
echo [3/3] Starting server...
echo      Memory limit: 4GB
echo      Forced GC: Enabled (every 5 minutes)
echo.
"%NODE_CMD%" start-wrapper.mjs %*
