# The PowerShell shape of a fake Copilot (config "bridgeScript" ending in .ps1): one call per command, the message on
# stdin, one JSON line back. The Node one (fake-bridge.mjs) is the one the tests use; this keeps the PowerShell path alive.
param([string]$Cmd, [switch]$New, [string]$Id, [switch]$NoLaunch)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
switch ($Cmd) {
  "list" { '{"ok":true,"chats":[]}' }
  "read" { '{"ok":true,"messages":[]}' }
  "open" { '{"ok":true,"messages":[]}' }
  "delete" { '{"ok":true}' }
  "ask" {
    $msg = [Console]::In.ReadToEnd()
    $reply = '{"tool": "done", "args": {"answer": "ps fake: ' + $msg.Length + ' characters received", "checks": []}}'
    $out = @{ ok = $true; text = $reply }
    if ($New) { $out.chatId = [guid]::NewGuid().ToString() }
    $out | ConvertTo-Json -Compress
  }
  default { '{"ok":false,"error":"unknown command"}' }
}
