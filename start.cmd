@echo off
rem Starts M365 Agent on http://127.0.0.1:4317 and opens it in your browser (runs the one-time setup first if needed).
rem Company Python index (Artifactory ...): start.cmd --index-url https://artifactory.example.com/api/pypi/pypi/simple
cd /d "%~dp0"
if not exist node_modules\playwright-core powershell -ExecutionPolicy Bypass -File setup.ps1 %*
if not exist .venv\Scripts\python.exe powershell -ExecutionPolicy Bypass -File setup.ps1 %*
start "" http://127.0.0.1:4317
node server.ts %*
