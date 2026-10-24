# Parses a PowerShell file without running it (tools/_check.ts): prints OK, or SYNTAX ERROR followed by up to three
# "line:col message" lines.
param([Parameter(Mandatory = $true)][string]$Path)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
if (-not $errors -or $errors.Count -eq 0) { Write-Output "OK"; exit 0 }
Write-Output "SYNTAX ERROR"
$errors | Select-Object -First 3 | ForEach-Object { Write-Output ("line {0}:{1} {2}" -f $_.Extent.StartLineNumber, $_.Extent.StartColumnNumber, $_.Message) }
exit 0
