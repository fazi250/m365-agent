# One-time setup: Node packages (browser tool) and a Python venv in .venv (DOCX / PPTX tools).
# Run from the project folder:  powershell -ExecutionPolicy Bypass -File setup.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "== npm install (playwright-core: drives your installed Chrome or Edge, downloads no browser)"
npm install --no-audit --no-fund
if ($LASTEXITCODE) { throw "npm install failed" }

Write-Host "== Python venv in .venv"
if (Get-Command uv -ErrorAction SilentlyContinue) {
  if (-not (Test-Path .venv)) { uv venv .venv }
  uv pip install --python .venv\Scripts\python.exe -r requirements.txt
} else {
  if (-not (Test-Path .venv)) { python -m venv .venv }
  .venv\Scripts\python.exe -m pip install -r requirements.txt
}
if ($LASTEXITCODE) { throw "installing the Python packages failed" }
.venv\Scripts\python.exe -c "import docx, pptx, PIL; print('python-docx, python-pptx, pillow: ok')"

if (-not (Test-Path config.json)) { Copy-Item config.example.json config.json; Write-Host "== created config.json" }
Write-Host "Done. Start with: npm start"
