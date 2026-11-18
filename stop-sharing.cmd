@echo off
setlocal
set "NODE=C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Microsoft\VisualStudio\NodeJs\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0stop-sharing.mjs"
pause
