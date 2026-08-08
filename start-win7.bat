@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo Missing bundled Electron runtime.
  echo This ZIP must be built with scripts\build-win7.ps1 before use.
  pause
  exit /b 1
)

echo Starting Pancake Desktop AI Shortcut Bot - Windows 7 legacy build...
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" echo Application exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
