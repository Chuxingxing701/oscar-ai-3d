@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
  python server.py
  goto end
)
if exist "C:\Users\Redmi\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" (
  "C:\Users\Redmi\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" server.py
  goto end
)
echo Python was not found. Use the included Node server or serve this folder with any static HTTP server.
:end
pause
