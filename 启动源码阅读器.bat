@echo off
rem HAJI code-viewer launcher: start local server (with AI proxy) and open browser
cd /d "%~dp0"
start "HAJI Code Viewer Server" cmd /k "node tools\code-viewer\serve.mjs"
timeout /t 1 >nul
start "" "http://127.0.0.1:8642/code-viewer.html"
echo Server window opened. Close that window (or Ctrl+C) to stop the viewer service.
