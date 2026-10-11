@echo off
title ComfyUI Server
cd /d "%~dp0..\..\.."
rem Fallback: run ComfyUI directly in a console window (normally use launch.vbs / the launcher instead)
start "" /b venv\Scripts\pythonw.exe custom_nodes\ComfyUI-Yomu\tools\open_browser.py
venv\Scripts\python.exe -u main.py --preview-method auto --use-pytorch-cross-attention --enable-manager --listen 127.0.0.1 --port 8188
pause
