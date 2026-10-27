#!/usr/bin/env bash
#
# DAGENT installer (Linux / macOS).
#
#   bash scripts/install.sh              # virtual environment + dependencies
#   bash scripts/install.sh --with-gguf  # also compile llama-cpp-python (local .gguf)
#
# Creator: frizovdanya - https://t.me/frizovdanya

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

PYTHON="${PYTHON:-}"
if [ -z "$PYTHON" ]; then
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then PYTHON="$candidate"; break; fi
  done
fi
if [ -z "$PYTHON" ]; then
  echo "Python 3 was not found. Install Python 3.10+ and run this script again." >&2
  exit 1
fi

VERSION_OK="$("$PYTHON" -c 'import sys; print(1 if sys.version_info >= (3, 10) else 0)')"
if [ "$VERSION_OK" != "1" ]; then
  echo "DAGENT needs Python 3.10 or newer ($("$PYTHON" --version 2>&1) found)." >&2
  exit 1
fi

WITH_GGUF=0
for arg in "$@"; do
  case "$arg" in
    --with-gguf) WITH_GGUF=1 ;;
    --system)    VENV="" ;;
    -h|--help)
      echo "Usage: bash scripts/install.sh [--with-gguf] [--system]"
      echo "  --with-gguf  compile llama-cpp-python for local .gguf inference"
      echo "  --system     install into the system Python instead of .venv"
      exit 0 ;;
  esac
done

VENV="${VENV-$ROOT/.venv}"

echo "DAGENT installer"
echo "  python : $PYTHON ($("$PYTHON" --version 2>&1))"
echo "  folder : $ROOT"

if [ -n "$VENV" ]; then
  if [ ! -x "$VENV/bin/python" ]; then
    echo "  creating virtual environment in .venv ..."
    "$PYTHON" -m venv "$VENV"
  fi
  PY="$VENV/bin/python"
else
  PY="$PYTHON"
fi

echo "  installing dependencies ..."
"$PY" -m pip install --upgrade pip >/dev/null
"$PY" -m pip install -r "$ROOT/requirements.txt"

if [ "$WITH_GGUF" = "1" ]; then
  echo "  compiling llama-cpp-python (this can take several minutes) ..."
  if ! "$PY" -m pip install llama-cpp-python; then
    echo ""
    echo "  llama-cpp-python did not compile. You need a C++ compiler and cmake:"
    echo "    Debian/Ubuntu : sudo apt install build-essential cmake"
    echo "    macOS         : xcode-select --install && brew install cmake"
    echo "  You can still use local GGUF servers (LM Studio, Ollama, llama.cpp server)"
    echo "  through the OpenAI-compatible provider - no compiler needed."
  fi
fi

echo ""
echo "Done. Start DAGENT with:"
if [ -n "$VENV" ]; then
  echo "  bash scripts/start.sh"
  echo "  # or: .venv/bin/python run.py"
else
  echo "  python3 run.py"
fi
echo ""
echo "Try the interface without any API key:"
echo "  $([ -n "$VENV" ] && echo ".venv/bin/python" || echo python3) scripts/demo.py"
echo ""
