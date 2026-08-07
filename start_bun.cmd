@echo off
setlocal EnableExtensions
REM Agent Society Server Startup Script (Windows)
REM Bun-only version. Use start.cmd for Node.js-first auto-detection.
REM
REM Usage:
REM   start.cmd [data_dir] [options]
REM
REM Options:
REM   --port, -p <port>  HTTP server port (default: 3000)
REM   --no-browser       Do not open browser automatically
REM
REM Examples:
REM   start.cmd                           # Use default configuration
REM   start.cmd ./my-data                 # Custom data directory
REM   start.cmd --port 3001               # Custom port
REM   start.cmd ./my-data -p 3001 --no-browser

REM Switch to script directory.
REM Cache the directory first so paths with parentheses do not break later parsing.
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

REM ============================================================
REM Memory limit configuration (prevent process exit caused by oversized RSS)
REM ============================================================
REM Set V8 heap memory limit to 4GB
set "NODE_OPTIONS=--max-old-space-size=4096 --expose-gc"

REM Bun-specific memory limit (via JSC engine parameter)
REM 4GB = 4294967296 bytes
set "BUN_JSC_forceRAMSize=4294967296"

REM Enable forced GC interval (every 5 minutes)
set "AGENT_SOCIETY_GC_INTERVAL_MS=300000"

echo.
echo [INFO] Memory limits configured:
echo        - V8 heap memory limit: 4GB
echo        - Bun JSC memory limit: 4GB
echo        - Forced GC interval: 5 minutes
echo.

echo.
echo ============================================================
echo           Agent Society Startup Script
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
goto :detect_bun

:skip_code_update
echo [0/3] Skipping code update ^(distribution package mode^)
echo.

REM ============================================================
REM Step 1: Detect bun runtime
REM ============================================================
:detect_bun
echo [1/3] Detecting bun runtime...

REM First check local runtime directory (distribution package mode)
if exist "%SCRIPT_DIR%runtime\bun\bin\bun.exe" goto :use_local_bun

REM Check bun in system PATH
where bun >nul 2>nul
if %ERRORLEVEL% EQU 0 goto :use_system_bun

REM bun is not installed, ask whether to install
echo      bun is not installed
echo.
echo bun is a fallback JavaScript runtime for this project (Node.js is recommended).
echo Install bun automatically? (source: https://bun.sh)
echo.
set /p INSTALL_BUN="Enter Y to install, N to exit [Y/N]: "

if /i "%INSTALL_BUN%"=="Y" goto :install_bun
if /i "%INSTALL_BUN%"=="y" goto :install_bun

REM User declined installation
echo.
echo You chose not to install bun.
echo Please install bun manually, then rerun this script.
echo Installation guide: https://bun.sh
exit /b 0

:use_local_bun
echo      Using local bun: %SCRIPT_DIR%runtime\bun\bin\bun.exe
set "BUN_CMD=%SCRIPT_DIR%runtime\bun\bin\bun.exe"
set "LOCAL_BUN=true"
goto :install_deps

:use_system_bun
echo      Using system bun
set "BUN_CMD=bun"
goto :install_deps

:install_bun
REM Install bun
echo.
echo [1/3] Installing bun...
echo      Running: powershell -c "irm bun.sh/install.ps1 | iex"
echo.
powershell -c "irm bun.sh/install.ps1 | iex"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Error: bun installation failed
    echo Solution: install bun manually
    echo Installation guide: https://bun.sh
    exit /b 1
)

REM Refresh PATH environment variable (read user PATH from registry)
echo.
echo      Refreshing environment variables...
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%b"
set "PATH=%USER_PATH%;%PATH%"

REM Verify bun installation
where bun >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Error: bun not found after installation
    echo Solution: close this window, reopen terminal, then rerun this script
    echo Or install bun manually: https://bun.sh
    exit /b 1
)
echo      bun installed successfully
set "BUN_CMD=bun"

:install_deps
REM Install dependencies
echo.
echo [2/3] Installing project dependencies...
echo      Running: bun install
echo.
call "%BUN_CMD%" install --registry https://registry.npmmirror.com

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Error: dependency installation failed
    echo Solution: check network connection, or verify package.json
    exit /b 1
)

REM Start server
echo.
echo [3/3] Starting server...
echo      Memory limit: 2GB
echo      Forced GC: Enabled (every 5 minutes)
echo.
call "%BUN_CMD%" run start-wrapper.mjs %*
