@echo off
cd /d "%~dp0"
echo Installing dependencies if needed...
if not exist node_modules npm install
echo Starting Pancake Desktop AI Shortcut Bot v3...
npm start
pause
