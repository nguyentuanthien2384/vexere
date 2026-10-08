@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Vui long cai Node.js 24 LTS truoc khi chay.
  pause
  exit /b 1
)
if not exist node_modules call npm install
call npm start
pause
