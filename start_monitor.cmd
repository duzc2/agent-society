@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "PROCDUMP_PATH=procdump64.exe"
set "DRY_RUN=0"
set "INCLUDE_TERMINATE=0"
set "FORWARD_ARGS="

:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="--procdump-path" (
  if "%~2"=="" (
    echo [ERROR] Missing value for --procdump-path
    exit /b 1
  )
  set "PROCDUMP_PATH=%~2"
  shift
  shift
  goto parse_args
)
if /I "%~1"=="--dry-run" (
  set "DRY_RUN=1"
  shift
  goto parse_args
)
if /I "%~1"=="--include-terminate" (
  set "INCLUDE_TERMINATE=1"
  shift
  goto parse_args
)
set "FORWARD_ARGS=!FORWARD_ARGS! %1"
shift
goto parse_args

:args_done

set "CRASH_ROOT=%~dp0agent-society-data\crash"
set "TMP_DIR=%CRASH_ROOT%\tmp"
if not exist "%CRASH_ROOT%" mkdir "%CRASH_ROOT%"
if not exist "%TMP_DIR%" mkdir "%TMP_DIR%"

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "Get-Date -Format \"yyyy-MM-dd HH:mm:ss\""`) do set "MONITOR_START=%%i"
set "SESSION_JSON=%TMP_DIR%\procdump-session-%RANDOM%%RANDOM%.json"
set "WER_JSON=%TMP_DIR%\wer-enable-%RANDOM%%RANDOM%.json"
set "EVENT_JSON=%TMP_DIR%\events-%RANDOM%%RANDOM%.json"
set "SESSION_TXT=%TMP_DIR%\session-dir-%RANDOM%%RANDOM%.txt"
set "EVENT_TXT=%TMP_DIR%\event-dir-%RANDOM%%RANDOM%.txt"

echo.
echo ============================================================
echo                 Agent Society Monitor Start
echo ============================================================
echo [INFO] Start Time: %MONITOR_START%
echo [INFO] ProcDump Path: %PROCDUMP_PATH%
echo [INFO] Include Terminate Dumps: %INCLUDE_TERMINATE%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\win\enable-wer-dumps.ps1" > "%WER_JSON%" 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo [WARN] enable-wer-dumps.ps1 failed, continue anyway.
  type "%WER_JSON%"
  echo.
) else (
  echo [OK] WER LocalDumps configured.
)

set "PROCDUMP_TERMINATE_ARG="
if "%INCLUDE_TERMINATE%"=="1" set "PROCDUMP_TERMINATE_ARG=-IncludeTerminate"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\win\start-procdump-monitor.ps1" -ProcDumpPath "%PROCDUMP_PATH%" -TargetProcessNames bun.exe,node.exe -OutputDir "..\..\agent-society-data\crash\procdump" %PROCDUMP_TERMINATE_ARG% > "%SESSION_JSON%" 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo [ERROR] start-procdump-monitor.ps1 failed.
  type "%SESSION_JSON%"
  exit /b 1
)

set "SESSION_DIR="
powershell -NoProfile -Command "$j=Get-Content -LiteralPath '%SESSION_JSON%' -Raw | ConvertFrom-Json; if($j.outputDir){Set-Content -LiteralPath '%SESSION_TXT%' -Value $j.outputDir -Encoding ASCII}" >nul 2>&1
if exist "%SESSION_TXT%" set /p SESSION_DIR=<"%SESSION_TXT%"
if not defined SESSION_DIR (
  powershell -NoProfile -Command "$d=Get-ChildItem -LiteralPath '%CRASH_ROOT%\procdump' -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if($d){Set-Content -LiteralPath '%SESSION_TXT%' -Value $d.FullName -Encoding ASCII}" >nul 2>&1
  if exist "%SESSION_TXT%" set /p SESSION_DIR=<"%SESSION_TXT%"
)
if not defined SESSION_DIR (
  echo [ERROR] Cannot parse ProcDump session output.
  type "%SESSION_JSON%"
  exit /b 1
)
echo [OK] ProcDump session: %SESSION_DIR%
echo.
echo [INFO] Running start.cmd, waiting for server process to exit...
echo.

if "%DRY_RUN%"=="1" (
  echo [DRYRUN] call ".\start.cmd"!FORWARD_ARGS!
  set "START_EXIT_CODE=0"
) else (
  call ".\start.cmd" !FORWARD_ARGS!
  set "START_EXIT_CODE=%ERRORLEVEL%"
)

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "Get-Date -Format \"yyyy-MM-dd HH:mm:ss\""`) do set "MONITOR_END=%%i"
echo.
echo [INFO] Server process exited with code: %START_EXIT_CODE%
echo [INFO] End Time: %MONITOR_END%

powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\win\export-crash-events.ps1" -StartTime "%MONITOR_START%" -EndTime "%MONITOR_END%" > "%EVENT_JSON%" 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo [WARN] export-crash-events.ps1 failed.
  type "%EVENT_JSON%"
) else (
  powershell -NoProfile -Command "$j=Get-Content -LiteralPath '%EVENT_JSON%' -Raw | ConvertFrom-Json; if($j.outputDir){Set-Content -LiteralPath '%EVENT_TXT%' -Value $j.outputDir -Encoding ASCII}" >nul 2>&1
  if exist "%EVENT_TXT%" set /p EVENT_DIR=<"%EVENT_TXT%"
  if not defined EVENT_DIR (
    powershell -NoProfile -Command "$d=Get-ChildItem -LiteralPath '%CRASH_ROOT%\events' -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if($d){Set-Content -LiteralPath '%EVENT_TXT%' -Value $d.FullName -Encoding ASCII}" >nul 2>&1
    if exist "%EVENT_TXT%" set /p EVENT_DIR=<"%EVENT_TXT%"
  )
  if defined EVENT_DIR (
    echo [OK] Event logs exported: !EVENT_DIR!
  ) else (
    echo [OK] Event logs exported.
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\win\stop-procdump-monitor.ps1" -SessionDir "%SESSION_DIR%" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo [WARN] stop-procdump-monitor.ps1 failed.
) else (
  echo [OK] ProcDump monitor stopped.
)

echo.
echo [SUMMARY] ProcDump session: %SESSION_DIR%
if defined EVENT_DIR echo [SUMMARY] Event logs: %EVENT_DIR%
echo [SUMMARY] Exit code: %START_EXIT_CODE%
echo.
exit /b %START_EXIT_CODE%
