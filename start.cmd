@echo off
setlocal
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Microsoft\VisualStudio\NodeJs\node.exe"
if not exist "%NODE%" if not "%NODE%"=="node" (
  echo Install Node.js 22 or newer from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:4317 after the server starts.
echo Keep this window open. Press Ctrl+C to stop.
"%NODE%" "%~dp0server.mjs"
pause
