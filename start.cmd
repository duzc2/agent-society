@echo off
setlocal EnableExtensions
REM Agent Society Startup Script (Windows)
REM Auto-detects Node.js first; falls back to Bun if Node.js is unavailable.
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
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

echo.
echo ============================================================
echo           Agent Society Startup Script
echo ============================================================
echo.

REM ============================================================
REM Memory limit configuration
REM ============================================================
set "NODE_OPTIONS=--max-old-space-size=4096 --expose-gc"
set "AGENT_SOCIETY_GC_INTERVAL_MS=300000"

echo [INFO] Memory limits configured:
echo        - V8 heap memory limit: 4GB
echo        - Forced GC interval: 5 minutes
echo.

REM ============================================================
REM Step 0: Git pull
REM ============================================================
if not exist ".git" goto :skip_git
echo [0/3] Trying to update code...
git pull 2>nul
if errorlevel 1 echo      git pull skipped (git may be missing or network issue)
echo.
goto :detect_runtime

:skip_git
echo [0/3] Skipping code update (distribution package mode)
echo.

REM ============================================================
REM Detect runtime: Node.js first, fallback to Bun
REM ============================================================
:detect_runtime
echo [1/3] Detecting runtime...

where node >nul 2>nul
if not errorlevel 1 goto :use_node

REM Node.js not found, try Bun
echo      Node.js not found, trying Bun...
goto :use_bun

REM ============================================================
REM Node.js path
REM ============================================================
:use_node
for /f "tokens=*" %%i in ('node -v 2^>nul') do echo      Using Node.js: %%i
echo.
echo [2/3] Installing dependencies (npm)...
call npm install --registry https://registry.npmmirror.com
if errorlevel 1 (
    echo.
    echo Error: npm install failed
    echo Solution: check network connection, or verify package.json
    exit /b 1
)
echo.
echo [3/3] Starting server with Node.js...
echo      Memory limit: 4GB
echo      Forced GC: Enabled (every 5 minutes)
echo.
node start-wrapper.mjs %*
exit /b %ERRORLEVEL%

REM ============================================================
REM Bun path
REM ============================================================
:use_bun
echo [1/3] Detecting bun runtime...

REM Check local runtime directory
if exist "%SCRIPT_DIR%runtime\bun\bin\bun.exe" (
    set "BUN_CMD=%SCRIPT_DIR%runtime\bun\bin\bun.exe"
    echo      Using local bun: %SCRIPT_DIR%runtime\bun\bin\bun.exe
    goto :install_bun_deps
)

REM Check system bun
where bun >nul 2>nul
if not errorlevel 1 (
    set "BUN_CMD=bun"
    echo      Using system bun
    goto :install_bun_deps
)

REM bun not found, offer to install
echo      bun is not installed
echo.
echo bun is a fallback JavaScript runtime for this project (Node.js is recommended).
echo Install bun automatically? (source: https://bun.sh)
echo.
set /p INSTALL_BUN="Enter Y to install, N to exit [Y/N]: "

if /i "%INSTALL_BUN%"=="Y" goto :install_bun
if /i "%INSTALL_BUN%"=="y" goto :install_bun

echo.
echo You chose not to install bun.
echo Please install bun manually, then rerun this script.
echo Installation guide: https://bun.sh
exit /b 0

:install_bun
echo.
echo [1/3] Installing bun...
echo      Running: powershell -c "irm bun.sh/install.ps1 | iex"
echo.
powershell -c "irm bun.sh/install.ps1 | iex"
if errorlevel 1 (
    echo.
    echo Error: bun installation failed
    echo Solution: install bun manually
    echo Installation guide: https://bun.sh
    exit /b 1
)

REM Refresh PATH from registry
echo.
echo      Refreshing environment variables...
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%b"
set "PATH=%USER_PATH%;%PATH%"

where bun >nul 2>nul
if errorlevel 1 (
    echo.
    echo Error: bun not found after installation
    echo Solution: close this window, reopen terminal, then rerun this script
    echo Or install bun manually: https://bun.sh
    exit /b 1
)
echo      bun installed successfully
set "BUN_CMD=bun"

:install_bun_deps
echo.
echo [2/3] Installing dependencies (bun)...
echo      Running: bun install
echo.
set "BUN_JSC_forceRAMSize=4294967296"
"%BUN_CMD%" install --registry https://registry.npmmirror.com
if errorlevel 1 (
    echo.
    echo Error: dependency installation failed
    echo Solution: check network connection, or verify package.json
    exit /b 1
)

echo.
echo [3/3] Starting server with Bun...
echo      Memory limit: 4GB (JSC)
echo      Forced GC: Enabled (every 5 minutes)
echo.
"%BUN_CMD%" run start-wrapper.mjs %*
exit /b %ERRORLEVEL%
