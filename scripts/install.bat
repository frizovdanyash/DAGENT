@echo off
REM ============================================================
REM  DAGENT installer (Windows)
REM
REM    scripts\install.bat              virtual environment + dependencies
REM    scripts\install.bat --with-gguf  also build llama-cpp-python (local .gguf)
REM
REM  Creator: frizovdanya - https://t.me/frizovdanya
REM ============================================================
setlocal enabledelayedexpansion
chcp 65001 >nul

cd /d "%~dp0.."
set "ROOT=%CD%"
set "WITH_GGUF=0"
if /i "%~1"=="--with-gguf" set "WITH_GGUF=1"

where python >nul 2>&1
if errorlevel 1 (
  echo Python was not found. Install Python 3.10+ from https://python.org
  echo and tick "Add python.exe to PATH" during the installation.
  pause
  exit /b 1
)

python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"
if errorlevel 1 (
  echo DAGENT needs Python 3.10 or newer.
  python --version
  pause
  exit /b 1
)
echo DAGENT installer
for /f "delims=" %%v in ('python --version 2^>^&1') do echo   python : %%v
echo   folder : %ROOT%

if not exist ".venv\Scripts\python.exe" (
  echo   creating virtual environment in .venv ...
  python -m venv .venv
  if errorlevel 1 (
    echo Could not create a virtual environment. Run: python -m pip install -r requirements.txt
    pause
    exit /b 1
  )
)

set "PY=%ROOT%\.venv\Scripts\python.exe"

echo   installing dependencies ...
"%PY%" -m pip install --upgrade pip >nul
"%PY%" -m pip install -r "%ROOT%\requirements.txt"
if errorlevel 1 (
  echo Dependency installation failed. Check your network connection and retry.
  pause
  exit /b 1
)

if "%WITH_GGUF%"=="1" (
  echo   building llama-cpp-python ^(needs Visual Studio Build Tools + cmake^) ...
  "%PY%" -m pip install llama-cpp-python
  if errorlevel 1 (
    echo   llama-cpp-python did not build. You can still use LM Studio, Ollama or
    echo   llama.cpp server as an API model - no compiler needed.
  )
)

echo.
echo Done. Start DAGENT with:
echo   scripts\start.bat
echo.
echo Try the interface without any API key:
echo   .venv\Scripts\python.exe scripts\demo.py
echo.
pause
endlocal
