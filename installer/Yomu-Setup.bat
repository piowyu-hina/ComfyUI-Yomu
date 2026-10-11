@echo off
chcp 65001 >nul
title Yomu Setup
cd /d "%~dp0"
set "PY="
for %%C in ("py -3.12" "py -3" "python") do (
  if not defined PY (
    %%~C -c "import sys;sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1 && set "PY=%%~C"
  )
)
if not defined PY (
  echo 找不到 Python，用 winget 安裝 Python 3.12 ...
  winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
  set "PY=%LocalAppData%\Programs\Python\Python312\python.exe"
)
%PY% installer.py
pause
