@echo off
REM Agent Society Windows 打包入口。
REM 职责：
REM 1. 统一从 CMD 调用 PowerShell 打包脚本。
REM 2. 保持 package.json 中的 npm/bun script 入口稳定。
REM 3. 将错误码透传给上层调用方，便于自动化脚本判断成功或失败。

setlocal
chcp 65001 >nul 2>nul

cd /d "%~dp0\..\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\win\pack.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

endlocal & exit /b %EXIT_CODE%
