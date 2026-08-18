@echo off
REM Copy system node.exe as Tauri sidecar.
REM Filename must be node-<target triple>.exe (externalBin uses stem "binaries/node").
setlocal
set "SCRIPT_DIR=%~dp0"
set "DEST=%SCRIPT_DIR%..\src-tauri\binaries\node-x86_64-pc-windows-msvc.exe"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] node.exe not found in PATH
    exit /b 1
)
for /f "delims=" %%i in ('where node') do set "NODE_EXE=%%i"
if not exist "%NODE_EXE%" (
    echo [ERROR] node.exe missing: %NODE_EXE%
    exit /b 1
)
copy /y "%NODE_EXE%" "%DEST%" >nul
if errorlevel 1 (
    echo [ERROR] copy failed: %NODE_EXE% -^> %DEST%
    exit /b 1
)
echo copied: %NODE_EXE% -^> %DEST%
endlocal
