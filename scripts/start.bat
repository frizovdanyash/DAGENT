@echo off
REM ============================================================
REM  Start DAGENT (Windows)
REM
REM    scripts\start.bat
REM    scripts\start.bat --port 9000
REM    scripts\start.bat --workspace "D:\Projects\my-app"
REM    scripts\start.bat --no-browser
REM
REM  Creator: frizovdanya - https://t.me/frizovdanya
REM ============================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0.."

set "PY=%CD%\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

"%PY%" -c "import fastapi, uvicorn" >nul 2>&1
if errorlevel 1 (
  echo DAGENT dependencies are missing. Install them first:
  echo   scripts\install.bat
  pause
  exit /b 1
)

"%PY%" run.py %*
endlocal
