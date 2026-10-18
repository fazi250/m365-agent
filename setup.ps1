# One-time setup: Node packages (browser tool) and a Python venv in .venv (DOCX / PPTX tools).
# Run from the project folder:  powershell -ExecutionPolicy Bypass -File setup.ps1
# Behind a company proxy with its own Python package index (Artifactory, Nexus ...), give it once:
#   npm run setup -- --index-url https://artifactory.example.com/api/pypi/pypi/simple
# (or npm run setup --index-url=<url>, or "pythonIndexUrl" in config.json). It is saved in config.json.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# the package index: --index-url <url> / --index-url=<url> / -IndexUrl <url>, npm's --index-url=<url>, config.json
$IndexUrl = ""
for ($i = 0; $i -lt $args.Count; $i++) {
  if ("$($args[$i])" -match '^-{1,2}index-?url(=(.+))?$') { $IndexUrl = if ($Matches[2]) { $Matches[2] } else { "$($args[$i + 1])" }; break }
}
if (-not $IndexUrl -and $env:npm_config_index_url) {
  $IndexUrl = if ($env:npm_config_index_url -ne "true") { $env:npm_config_index_url } else { "$($args | Where-Object { "$_" -match '^https?://' } | Select-Object -First 1)" }
}
$fromConfig = $false
if (-not $IndexUrl -and (Test-Path config.json)) {
  $IndexUrl = "$((Get-Content config.json -Raw | ConvertFrom-Json).pythonIndexUrl)"
  $fromConfig = [bool]$IndexUrl
}
$indexArgs = @()
if ($IndexUrl) {
  $indexArgs = @("--index-url", $IndexUrl)
  Write-Host "== Python packages from $($IndexUrl -replace '//([^/@:]+):[^/@]+@', '//$1:***@')"
}

Write-Host "== npm install (playwright-core: drives your installed Edge or Chrome, downloads no browser)"
npm install --no-audit --no-fund
if ($LASTEXITCODE) { throw "npm install failed" }

Write-Host "== Python venv in .venv"
if (Get-Command uv -ErrorAction SilentlyContinue) {
  if (-not (Test-Path .venv)) { uv venv .venv }
  uv pip install --python .venv\Scripts\python.exe @indexArgs -r requirements.txt
} else {
  if (-not (Test-Path .venv)) { python -m venv .venv }
  .venv\Scripts\python.exe -m pip install @indexArgs -r requirements.txt
}
if ($LASTEXITCODE) { throw "installing the Python packages failed" }
.venv\Scripts\python.exe -c "import docx, pptx, PIL; print('python-docx, python-pptx, pillow: ok')"

if (-not (Test-Path config.json)) { Copy-Item config.example.json config.json; Write-Host "== created config.json" }
if ($IndexUrl -and -not $fromConfig) {
  # keep it for install_package and later setups (node writes the JSON in the same layout as the rest of the file)
  node -e "const fs = require('fs'); const c = JSON.parse(fs.readFileSync('config.json', 'utf8')); c.pythonIndexUrl = process.argv[1]; fs.writeFileSync('config.json', JSON.stringify(c, null, 2) + '\n')" $IndexUrl
  if ($LASTEXITCODE) { throw "could not save pythonIndexUrl in config.json" }
  Write-Host "== saved pythonIndexUrl in config.json"
}
Write-Host "Done. Start with: npm start"
