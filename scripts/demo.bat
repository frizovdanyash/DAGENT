@echo off
REM  Try DAGENT with the built-in offline demo model (no API key needed).
REM  Creator: frizovdanya - https://t.me/frizovdanya
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

"%PY%" scripts\demo.py %*
endlocal
