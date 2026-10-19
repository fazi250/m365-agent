# Drives the Microsoft 365 Copilot desktop app through Windows UI Automation (no API, no settings changed).
# Every command prints one JSON line.
#
#   bridge.ps1 list                      -> {"ok":true,"chats":[{"id","title"}]}   newest first
#   bridge.ps1 read                      -> {"ok":true,"messages":[{"role":"user"|"copilot","text"}]}   (open chat)
#   bridge.ps1 open -Id <chat id>        -> same as read, after switching Copilot to that chat
#   bridge.ps1 ask [-New]                message on stdin -> {"ok":true,"text":"<reply>"}
#   bridge.ps1 delete -Id <chat id>      deletes that chat in Copilot (More > Delete > confirm) -> {"ok":true}
#   bridge.ps1 diag                      plain-text report on finding and starting the app (also saved in diag.txt),
#                                        for when it "did not open" on a PC: npm run diag
#   every command accepts -Prev <hwnd>: the user's window from an earlier call (see Restore-Focus)
#
# Behind the scenes: the Copilot window is kept minimized (still open in the taskbar). Keyboard input only reaches
# the active window, so to click a chat or paste a message the minimized window is activated, without being
# restored, for well under a second, and the window you were using gets focus straight back. Everything else is
# read from the accessibility tree, which needs no focus. (UIA Invoke and Copilot's "Copy Response" button both
# activate or restore the window, so neither is used.)
param([Parameter(Position = 0)][string]$Cmd = "ask", [switch]$New, [string]$Id = "", [long]$Prev = 0, [int]$TimeoutSec = 240,
      [switch]$NoLaunch,  # don't start the Copilot app if it is closed (background sync); answer {"ok":true,"closed":true}
      [switch]$DryRun)   # delete -DryRun: go all the way to the confirmation dialog, then answer Cancel
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int l, t, r, b; }
  [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO { public int cbSize; public uint flags; public IntPtr active, focus, capture, menuOwner, moveSize, caret; public RECT rc; }
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO info);
  // The window that gets the keys now (the foreground thread's keyboard focus); zero when none has it, as in a
  // freshly activated minimized window, where keys go to the bare window (and Enter there restores it).
  public static IntPtr FocusWindow() {
    var i = new GUITHREADINFO(); i.cbSize = Marshal.SizeOf(i);
    return GetGUIThreadInfo(0, ref i) ? i.focus : IntPtr.Zero;
  }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
  public static IntPtr FindChild(IntPtr top, string cls) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(top, (w, l) => {
      var sb = new System.Text.StringBuilder(64); GetClassName(w, sb, 64);
      if (sb.ToString() == cls && IsWindowVisible(w)) { found = w; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  // Windows' keyboard focus onto a child window of top (SetFocus works for windows sharing our input queue)
  public static void FocusChild(IntPtr top, IntPtr child) {
    uint t = GetWindowThreadProcessId(top, IntPtr.Zero), me = GetCurrentThreadId();
    bool attached = t != me && AttachThreadInput(me, t, true);
    SetFocus(child);
    if (attached) AttachThreadInput(me, t, false);
  }
  // The window Windows itself would activate next: topmost visible, titled, non-tool, non-cloaked, not minimized.
  public static IntPtr NextUserWindow(IntPtr skip) {
    for (IntPtr w = GetTopWindow(IntPtr.Zero); w != IntPtr.Zero; w = GetWindow(w, 2 /* GW_HWNDNEXT */)) {
      if (w == skip || !IsWindowVisible(w) || IsIconic(w) || GetWindowTextLength(w) == 0) continue;
      if ((GetWindowLong(w, -20 /* GWL_EXSTYLE */) & 0x80 /* WS_EX_TOOLWINDOW */) != 0) continue;
      int cloaked; if (DwmGetWindowAttribute(w, 14 /* DWMWA_CLOAKED */, out cloaked, 4) == 0 && cloaked != 0) continue;
      return w;
    }
    return IntPtr.Zero;
  }
  // Windows refuses focus changes from background processes; borrow the foreground thread's input queue.
  public static void Focus(IntPtr h) {
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero), me = GetCurrentThreadId();
    bool attached = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
    SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fg, false);
  }
  // Windows lets a process take the foreground right after an Alt key press. A bridge started by the server (not by
  // the window you are using) has no right of its own, so: Alt down, activate, Alt up (that one lands in Copilot).
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static void FocusAlt(IntPtr h) {
    keybd_event(0x12 /* VK_MENU */, 0, 0, UIntPtr.Zero);
    try { SetForegroundWindow(h); } finally { keybd_event(0x12, 0, 2 /* KEYEVENTF_KEYUP */, UIntPtr.Zero); }
  }
}
"@
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$APP_ID = "Microsoft.MicrosoftOfficeHub_8wekyb3d8bbwe!Microsoft.MicrosoftOfficeHub"
$SW_SHOWMINNOACTIVE = 7
$GUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

function Out-Json($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5)) }
function Cond($prop, $value) { New-Object System.Windows.Automation.PropertyCondition($prop, $value) }
function Find-ByName($root, $name, $type) {
  $root.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.AndCondition((Cond $AE::NameProperty $name), (Cond $AE::ControlTypeProperty $type))))
}

# ── window and focus ──
# The app's main window. Its program is M365Copilot.exe (Store build, in WindowsApps). Newer builds, seen on work
# PCs, are named just "Copilot" in the Start menu and run copilotapp.exe from Program Files\Microsoft\Copilot (the
# OfficeHub app id starts it). In case a build names it differently again, any program with a window from the
# Microsoft.MicrosoftOfficeHub package counts too.
function Get-MainHandle {
  $p = Get-Process M365Copilot -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
  if (-not $p) {
    $p = Get-Process copilotapp -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like "*\Microsoft\Copilot\Application\copilotapp.exe" } | Select-Object -First 1
  }
  if (-not $p) {
    $p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like "*\WindowsApps\Microsoft.MicrosoftOfficeHub_*" } | Select-Object -First 1
  }
  if ($p) { $p.MainWindowHandle } else { [IntPtr]::Zero }
}

$LAYOUT_ID = "m365-copilot-app-layout-main"   # the chat screen; missing on sign-in and first-run screens
$DIAG_HINT = "For details run in the m365-agent folder: npm run diag"

# Not running: start it and wait for its real window. While starting, the app swaps a first window for the final
# one, so the handle is looked up again until the chat layout is there. The error says which part failed.
function Get-CopilotWindow {
  $h = Get-MainHandle
  if ($h -ne [IntPtr]::Zero) { return $h }
  Start-Process "shell:AppsFolder\$APP_ID"
  $deadline = (Get-Date).AddSeconds(45)
  $sawWindow = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $h = Get-MainHandle
    if ($h -eq [IntPtr]::Zero) { continue }
    $sawWindow = $true
    if ($AE::FromHandle($h).FindFirst($TS::Descendants, (Cond $AE::AutomationIdProperty $LAYOUT_ID))) {
      Start-Sleep -Milliseconds 500
      return (Get-MainHandle)
    }
  }
  if ($sawWindow) {
    throw "Microsoft 365 Copilot app opened, but its chat screen did not appear within 45 s (signed out, a sign-in or first-run screen, or a different layout). Open the app once yourself, sign in and close it. $DIAG_HINT"
  }
  if (-not (Get-StartApps | Where-Object AppID -eq $APP_ID)) {
    throw "Microsoft 365 Copilot app is not installed for this Windows user (no app $APP_ID). Install 'Microsoft 365 Copilot' from the Microsoft Store or Company Portal. $DIAG_HINT"
  }
  throw "Microsoft 365 Copilot app did not open a window within 45 s. $DIAG_HINT"
}

# ── diag: what this PC has and does when the app is started, as plain text (and diag.txt) ──
function Diagnose {
  $lines = New-Object System.Collections.Generic.List[string]
  function Say([string]$s) { $lines.Add($s); [Console]::Out.WriteLine($s) }
  function Windowed {
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.MainWindowHandle -ne 0 -and ($_.ProcessName -match 'copilot|officehub|m365' -or $_.MainWindowTitle -match 'copilot|microsoft 365' -or
        $_.Path -like '*\WindowsApps\Microsoft.MicrosoftOfficeHub_*')
    } | ForEach-Object { Say "  $($_.ProcessName) (pid $($_.Id)) window '$($_.MainWindowTitle)'  $($_.Path)" }
  }
  Say "== M365 Agent diag, $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  Say "Windows $([Environment]::OSVersion.Version), PowerShell $($PSVersionTable.PSVersion), user $env:USERNAME"
  Say "== Start-menu apps named like Copilot / Microsoft 365 / Office (the bridge starts AppID $APP_ID)"
  $apps = @(Get-StartApps | Where-Object { $_.Name -match 'copilot|microsoft 365|office' })
  if ($apps) { $apps | ForEach-Object { Say "  $($_.Name)  ->  $($_.AppID)$(if ($_.AppID -eq $APP_ID) { '   <== the one the bridge uses' })" } } else { Say "  (none)" }
  Say "== Installed app packages"
  $pk = @(Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'OfficeHub|Copilot' })
  if ($pk) { $pk | ForEach-Object { Say "  $($_.Name) $($_.Version) ($($_.Status))" } } else { Say "  (none)" }
  Say "== Programs with a window, before starting"
  Windowed
  $h = Get-MainHandle
  if ($h -eq [IntPtr]::Zero) {
    Say "== No Copilot window: starting shell:AppsFolder\$APP_ID and waiting up to 40 s"
    try { Start-Process "shell:AppsFolder\$APP_ID" } catch { Say "  start failed: $($_.Exception.Message)" }
    for ($i = 0; $i -lt 80 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 500; $h = Get-MainHandle }
    Start-Sleep -Seconds 5   # let it draw its first screen
    $h = Get-MainHandle
    Say "== Programs with a window, after starting"
    Windowed
  }
  if ($h -eq [IntPtr]::Zero) {
    Say "== RESULT: no window from M365Copilot.exe, copilotapp.exe or the Microsoft.MicrosoftOfficeHub package"
  } else {
    $root = $AE::FromHandle($h)
    Say "== Copilot window: '$($root.Current.Name)', class $($root.Current.ClassName), minimized: $([W]::IsIconic($h))"
    $layout = $null
    for ($i = 0; $i -lt 40 -and -not $layout; $i++) {   # the chat screen can take a while after the window shows
      $layout = $root.FindFirst($TS::Descendants, (Cond $AE::AutomationIdProperty $LAYOUT_ID))
      if (-not $layout) { Start-Sleep -Milliseconds 500 }
    }
    $web = $root.FindFirst($TS::Descendants, (Cond $AE::AutomationIdProperty "RootWebArea"))
    Say "  chat screen ($LAYOUT_ID): $(if ($layout) { 'found' } else { 'NOT found within 20 s' })"
    Say "  web page (RootWebArea): $(if ($web) { "found, '$($web.Current.Name)'" } else { 'NOT found' })"
    Say "  chat links in the sidebar: $(@(Get-Chats $root).Count)"
    Say "== Controls with an id (first 60; chat ids left out)"
    $n = 0
    foreach ($e in $root.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
      $aid = $e.Current.AutomationId
      if (-not $aid -or $aid -match $GUID -or $aid -match '^\d+$') { continue }
      $name = ($e.Current.Name -replace '\s+', ' '); if ($name.Length -gt 50) { $name = $name.Substring(0, 50) + "..." }
      Say "  $($e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', '') id=$aid '$name'"
      if (++$n -ge 60) { break }
    }
    Say "== Texts that look like a sign-in or start screen"
    $hits = 0
    foreach ($e in $root.FindAll($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::Text))) {
      if ($e.Current.Name -match 'sign in|sign-in|log in|welcome|get started|account|license|licence|not available|admin') {
        Say "  '$($e.Current.Name)'"; if (++$hits -ge 15) { break }
      }
    }
    if (-not $hits) { Say "  (none)" }
  }
  $file = Join-Path $PSScriptRoot "diag.txt"
  [IO.File]::WriteAllLines($file, $lines)
  Say "== saved in $file"
}

# Copilot sometimes restores its own window while it is used in the background (seen right after a message is
# typed into it): put it straight back down, without activating it.
function Hide-Copilot {
  if ($h -and -not [W]::IsIconic($h)) { [W]::ShowWindow($h, $SW_SHOWMINNOACTIVE) | Out-Null; return $true }
  return $false
}

# Hand focus back to the user's window, and keep it there (and Copilot minimized) while Copilot's own late focus
# calls arrive.
function Restore-Focus($h, $prev, [int]$guardMs) {
  $null = Hide-Copilot
  if ($prev -eq [IntPtr]::Zero -or $prev -eq $h -or -not [W]::IsWindow($prev)) { return }
  $until = (Get-Date).AddMilliseconds($guardMs)
  do {
    $null = Hide-Copilot
    if ([W]::GetForegroundWindow() -eq $h) {
      [W]::Focus($prev)
      if ([W]::GetForegroundWindow() -eq $h) { [W]::FocusAlt($prev) }   # Windows' foreground lock: see FocusAlt
    }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $until)
}

# Copilot's status bar under the chat, e.g. "You've reached your daily limit ..." (the chat box is gone then)
function Get-StatusText($root) {
  $bars = $root.FindAll($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::StatusBar))
  (@(foreach ($b in $bars) { foreach ($t in $b.FindAll($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::Text))) { $t.Current.Name } }) -join " ").Trim()
}

function Find-Editor($root) {
  for ($i = 0; $i -lt 40; $i++) {   # web content's accessibility tree can take a moment to appear
    $e = $root.FindFirst($TS::Descendants, (Cond $AE::AutomationIdProperty "m365-chat-editor-target-element"))
    if ($e) { return $e }
    if ($i -ge 4) { $s = Get-StatusText $root; if ($s) { throw "Copilot: $s" } }
    Start-Sleep -Milliseconds 500
  }
  throw "chat box not found (is the Copilot app signed in?)"
}

# ── chats in the sidebar: hyperlinks whose automation id is the conversation id ──
# Newest first, as the sidebar lists them. (Which one is open is tracked by the server: .NET UIA has no aria-current.)
function Get-Chats($root) {
  $chats = @()
  foreach ($l in $root.FindAll($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::Hyperlink))) {
    $c = $l.Current
    if ($c.AutomationId -match $GUID) { $chats += @{ id = $c.AutomationId; title = $c.Name } }
  }
  return $chats
}

# ── messages of the open chat ──
function Get-Headings($root, $pattern) {
  $out = @()
  foreach ($t in $root.FindAll($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::Text))) {
    if ($t.Current.AutomationId -like $pattern) { $out += $t }
  }
  return $out
}

# The page's TextPattern returns a message as rendered text (list numbers, line breaks). The range of the whole
# message also holds the "You said:/Copilot said:" heading and the labels of its buttons (Copy Response, More
# options, ...), so those lines are trimmed off both ends. (A range taken from an inner part can come back as a
# single U+FFFC "embedded object", which is why the whole message is read.)
$script:DocText = $null
$OBJ = [string][char]0xFFFC

# Code blocks render as an "Code editor" box whose children alternate line number / line text ("1", "{", "2",
# "  \"name\": ..."), indentation intact. Rebuild each block's exact text from them.
function Get-CodeBlocks($msg) {
  # Markdown / HTML blocks open as a rendered preview, which loses the raw text: switch them to their code view
  # (the block's "Code" toggle, pressed with the keyboard in a short focus blip)
  $toggle = New-Object System.Windows.Automation.AndCondition((Cond $AE::AutomationIdProperty "preview-toggle-button"), (Cond $AE::NameProperty "Code"))
  $toggles = @($msg.FindAll($TS::Descendants, $toggle))
  if ($toggles.Count) {
    try {
      if (Ensure-Active) {
        foreach ($t in $toggles) { Press $t; Start-Sleep -Milliseconds 300 }
      }
    } catch { <# focus went elsewhere: the block is read from its preview #> } finally { Restore-Focus $h $prev 1500 }
  }
  $editor = New-Object System.Windows.Automation.AndCondition((Cond $AE::ControlTypeProperty $CT::Edit), (Cond $AE::NameProperty "Code editor"))
  $blocks = @()
  foreach ($ed in $msg.FindAll($TS::Descendants, $editor)) {
    $lines = New-Object System.Collections.Generic.List[string]
    $next = 1; $cur = $null
    foreach ($t in $ed.FindAll($TS::Children, (Cond $AE::ControlTypeProperty $CT::Text))) {
      $n = $t.Current.Name
      if ($n -match '^\d+$' -and [int]$n -eq $next) {   # the next line number starts a line (an empty line has no text node)
        if ($null -ne $cur) { $lines.Add($cur) }
        $cur = ""; $next++; continue
      }
      if ($null -eq $cur) { $cur = "" }
      if ($n -eq [string][char]0x00A0) { continue }   # an empty line is drawn as a lone no-break space
      $cur += $n.Replace([string][char]0x00A0, " ")
    }
    if ($null -ne $cur) { $lines.Add($cur) }
    $blocks += , @{ code = ($lines -join "`n"); box = $Walker.GetParent($ed) }
  }
  return $blocks
}

function Get-MessageText($msg) {
  $text = ""
  $codeBlocks = @(Get-CodeBlocks $msg)
  if ($script:DocText) {
    # labels that are not part of the answer: buttons ("Copy Response", "Coding and executing" ...), status lines
    # ("Reasoned for 1s") and the code boxes' own labels ("JSON", "Code Preview"); the code itself is added below
    $chrome = @{ "?" = 1; "Code Preview" = 1 }
    foreach ($cb in $codeBlocks) {
      foreach ($t in $cb.box.FindAll($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::Text))) { $chrome[$t.Current.Name.Trim()] = 1 }
    }
    foreach ($b in $msg.FindAll($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::Button))) { $chrome[$b.Current.Name] = 1 }
    foreach ($s in $msg.FindAll($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::StatusBar))) {
      foreach ($t in $s.FindAll($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::Text))) { $chrome[$t.Current.Name] = 1 }
    }
    $lines = [System.Collections.Generic.List[string]](
      @($script:DocText.RangeFromChild($msg).GetText(-1) -split "\r?\n" | Where-Object { $_.Replace($OBJ, "").Trim() -ne "" -or $_.Trim() -eq "" }))
    while ($lines.Count -and ($lines[0].Trim() -match '^((You|Copilot) said:)?$' -or $chrome.ContainsKey($lines[0].Trim()))) { $lines.RemoveAt(0) }
    while ($lines.Count -and ($lines[$lines.Count - 1].Trim() -eq "" -or $chrome.ContainsKey($lines[$lines.Count - 1].Trim()))) { $lines.RemoveAt($lines.Count - 1) }
    $lines = @($lines | Where-Object { -not $chrome.ContainsKey($_.Trim()) })
    $text = ($lines -join "`n").Replace($OBJ, "").Trim()   # embedded objects (cards, code panes) have no text of their own
  }
  foreach ($cb in $codeBlocks) {   # code blocks, verbatim, as markdown fences longer than any backtick run inside
    $fence = '```'
    while ($cb.code.Contains($fence)) { $fence += '`' }
    $text += "`n" + $fence + "`n" + $cb.code + "`n" + $fence
  }
  if (-not $text) {   # fallback: the text nodes, joined
    $text = (@(foreach ($t in $msg.FindAll($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::Text))) {
      if ($t.Current.AutomationId -notlike "*-message-*-title") { $t.Current.Name } }) -join "")
  }
  return $text.Trim()
}

function Get-VisibleMessages($root) {
  $list = @()
  foreach ($head in (Get-Headings $root "*-message-*-title")) {
    $role = if ($head.Current.AutomationId -like "user-message-*") { "user" } else { "copilot" }
    $list += @{ role = $role; text = (Get-MessageText $Walker.GetParent($head)) }
  }
  return $list
}

# Long chats are virtualized (only messages near the viewport exist), so scroll from the top and stitch the pages.
function Get-AllMessages($root) {
  $conv = Find-ByName $root "Chat conversation" $CT::Group
  if (-not $conv) { return @() }
  $scroller = $null; $el = $conv
  for ($i = 0; $i -lt 6 -and $el -and -not $scroller; $i++) {
    if ($el.GetCurrentPropertyValue($AE::IsScrollPatternAvailableProperty)) { $scroller = $el.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern) }
    $el = $Walker.GetParent($el)
  }
  if (-not $scroller -or -not $scroller.Current.VerticallyScrollable) { return Get-VisibleMessages $root }

  $all = New-Object System.Collections.ArrayList
  $NoScroll = [System.Windows.Automation.ScrollPattern]::NoScroll
  for ($pct = 0; $pct -le 100; $pct += 20) {
    $scroller.SetScrollPercent($NoScroll, [double]$pct)
    Start-Sleep -Milliseconds 400
    $page = @(Get-VisibleMessages $root)
    # append only what is new: the longest overlap between the end of $all and the start of $page
    $k = [Math]::Min($all.Count, $page.Count)
    while ($k -gt 0) {
      $same = $true
      for ($j = 0; $j -lt $k; $j++) {
        $a = $all[$all.Count - $k + $j]; $b = $page[$j]
        if ($a.role -ne $b.role -or $a.text -ne $b.text) { $same = $false; break }
      }
      if ($same) { break }
      $k--
    }
    for ($j = $k; $j -lt $page.Count; $j++) { [void]$all.Add($page[$j]) }
  }
  $scroller.SetScrollPercent($NoScroll, 100.0)   # leave it at the newest message
  return @($all)
}

# Keyboard input only reaches the active window, and another window (e.g. the browser right after you click OK in its
# confirm box) can take focus back at any moment: make sure Copilot is active before each keystroke.
function Ensure-Active {
  for ($i = 0; $i -lt 10; $i++) {
    if ([W]::GetForegroundWindow() -eq $h) { return $true }
    if ($i -eq 0) { [W]::Focus($h) } else { [W]::FocusAlt($h) }   # Windows' foreground lock: see FocusAlt
    Start-Sleep -Milliseconds 120
  }
  return ([W]::GetForegroundWindow() -eq $h)
}

# Copilot must really be the active window before one of its controls gets focus or a key is sent: a key sent too
# early lands in your window, and focusing a control of an inactive Copilot makes it activate (and restore) itself.
function Activate-Copilot {
  if (-not (Ensure-Active)) { throw "could not make the Copilot window active, so nothing was typed (try again)" }
}

# Keys only go to the control they are meant for, and only once Windows' keyboard focus is inside Copilot's page.
# Right after activation a minimized Copilot has no focus window at all: keys then go to the bare window, and an
# Enter there RESTORES it (that was Copilot popping up maximized, with the message not sent). Focusing the chat box
# moves Windows' focus into the page a moment later. Copilot's title-bar buttons (Minimize, Maximize, Close) are web
# buttons too and can hold the page's focus. So before every key: Copilot active, a focus window inside it, and the
# control's own HasKeyboardFocus (UIA's FocusedElement only sees the WebView pane). Nothing is sent otherwise.
function Has-Focus($el) {
  try {
    if ([W]::GetForegroundWindow() -ne $h) { return $false }
    $fw = [W]::FocusWindow()
    if ($fw -eq [IntPtr]::Zero -or -not [W]::IsChild($h, $fw)) { return $false }
    return [bool]$el.Current.HasKeyboardFocus
  } catch { return $false }
}
# Windows' keyboard focus into Copilot's page (its WebView window) when the activated window has none
function Focus-Page {
  $fw = [W]::FocusWindow()
  if ($fw -ne [IntPtr]::Zero -and [W]::IsChild($h, $fw)) { return }
  $page = [W]::FindChild($h, "Chrome_RenderWidgetHostHWND")
  if ($page -ne [IntPtr]::Zero) { [W]::FocusChild($h, $page); Start-Sleep -Milliseconds 50 }
}
# Returns the control that got focus. $refind looks the control up again on each try: Copilot re-creates some of
# them (the chat box after "New chat" re-renders a moment later), and a replaced one can never take focus.
function Focus-Element($el, [string]$what, [scriptblock]$refind) {
  for ($k = 0; $k -lt 5; $k++) {
    if ($k -gt 0 -and $refind) { try { $found = & $refind; if ($found) { $el = $found } } catch { } }
    Activate-Copilot
    Focus-Page
    try { $el.SetFocus() } catch { }
    for ($j = 0; $j -lt 8; $j++) { if (Has-Focus $el) { return $el }; Start-Sleep -Milliseconds 80 }
  }
  # which part failed, for agent.log
  $fw = [W]::FocusWindow()
  $boxFocus = try { [bool]$el.Current.HasKeyboardFocus } catch { "gone" }
  throw ("could not put keyboard focus on $what in Copilot, so nothing was typed (try again)" +
    " [active=$([W]::GetForegroundWindow() -eq $h) pageFocus=$($fw -ne [IntPtr]::Zero -and [W]::IsChild($h, $fw)) controlFocus=$boxFocus]")
}
# For the dialog buttons, where a wrong Enter matters most: Copilot active and either UIA's focused element is that
# button or the button itself reports keyboard focus.
function Is-FocusedButton($el, [string]$name) {
  if ([W]::GetForegroundWindow() -ne $h) { return $false }
  $fw = [W]::FocusWindow()
  if ($fw -eq [IntPtr]::Zero -or -not [W]::IsChild($h, $fw)) { return $false }
  try { $f = $AE::FocusedElement.Current; if ($f.ControlType -eq $CT::Button -and $f.Name -eq $name) { return $true } } catch { }
  return (Has-Focus $el)
}
# Returns the control the keys went to (looked up again with $refind if it had to be focused again).
function Send-KeysTo($el, [string]$keys, [string]$what, [scriptblock]$refind) {
  if (-not (Has-Focus $el)) { $el = Focus-Element $el $what $refind }
  [System.Windows.Forms.SendKeys]::SendWait($keys)
  return $el
}

# Press a control with the keyboard (focus + Enter): UIA Invoke would restore the minimized window.
function Press($el) { $what = "'" + $el.Current.Name + "'"; $el = Focus-Element $el $what; $null = Send-KeysTo $el "{ENTER}" $what }

function Wait-For($root, $name, $type, [int]$ms) {
  for ($t = 0; $t -lt $ms; $t += 200) {
    $e = Find-ByName $root $name $type
    if ($e) { return $e }
    Start-Sleep -Milliseconds 200
  }
  return $null
}

# Answers a dialog with Cancel. Copilot's "Delete chat?" is an alert dialog that ignores Esc, so Cancel is pressed
# with Enter, but only once keyboard focus is verified to be on "Cancel": a stray Enter on "Delete" must never happen.
# If focus can't be confirmed, nothing is pressed and the dialog stays open (harmless).
function Dismiss-Dialog($dialog) {
  if (-not $dialog) { return $false }
  $cancel = Find-ByName $dialog "Cancel" $CT::Button
  if (-not $cancel) { return $false }
  $delete = Find-ByName $dialog "Delete" $CT::Button
  for ($k = 0; $k -lt 5; $k++) {
    if (Ensure-Active) { Focus-Page }
    try { $cancel.SetFocus() } catch { }
    Start-Sleep -Milliseconds 200
    if ((Is-FocusedButton $cancel "Cancel") -and -not ($delete -and (Has-Focus $delete)) -and (Ensure-Active)) {
      [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
      Start-Sleep -Milliseconds 500
      return $true
    }
  }
  return $false
}

# A Copilot dialog left open (e.g. "Delete chat?") blocks everything behind it: dismiss it (Esc = Cancel).
function Close-Dialogs($root) {
  $closed = 0
  foreach ($w in @($root.FindAll($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::Window)))) {
    if ($w.Current.ClassName -notlike "fui-DialogSurface*") { continue }
    try { if (Dismiss-Dialog $w) { $closed++ } } finally { Restore-Focus $h $prev 600 }   # Dismiss-Dialog activates Copilot itself
  }
  return $closed
}

# Esc from inside any popup menu or dialog left open (Esc only reaches it while it has focus).
function Close-Popups($root) {
  for ($i = 0; $i -lt 4; $i++) {
    $item = $root.FindFirst($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::MenuItem))
    if (-not $item -or -not (Ensure-Active)) { return }
    $item.SetFocus(); [System.Windows.Forms.SendKeys]::SendWait("{ESC}"); Start-Sleep -Milliseconds 300
  }
}

# ── main ──
if ($Cmd -eq "diag") {
  try { Diagnose } catch { [Console]::Out.WriteLine("diag stopped: $($_.Exception.Message)") }
  exit 0
}
try {
  if ($NoLaunch -and (Get-MainHandle) -eq [IntPtr]::Zero) { Out-Json @{ ok = $true; closed = $true; chats = @() }; exit 0 }
  $h = Get-CopilotWindow
  # the window to give focus back to: what you are using now, or the one from an earlier call when a previous
  # step left focus on the hidden Copilot window
  $fg = [W]::GetForegroundWindow()
  $prev = if ($fg -ne $h) { $fg } elseif ($Prev -and [W]::IsWindow([IntPtr]$Prev)) { [IntPtr]$Prev } else { [W]::NextUserWindow($h) }
  if (-not [W]::IsIconic($h)) { [W]::ShowWindow($h, $SW_SHOWMINNOACTIVE) | Out-Null; Restore-Focus $h $prev 400 }
  elseif ($fg -eq $h) { Restore-Focus $h $prev 0 }   # focus was left on the hidden window: hand it back now
  $root = $AE::FromHandle($h)
  for ($i = 0; $i -lt 40; $i++) {   # wait until the web content's accessibility tree is there
    if ($root.FindFirst($TS::Descendants, (Cond $AE::AutomationIdProperty "m365-copilot-app-layout-main"))) { break }
    Start-Sleep -Milliseconds 500
  }
  $doc = $root.FindFirst($TS::Descendants, (Cond $AE::AutomationIdProperty "RootWebArea"))
  if ($doc -and $doc.GetCurrentPropertyValue($AE::IsTextPatternAvailableProperty)) {
    $script:DocText = $doc.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
  }
  $null = Close-Dialogs $root   # a dialog left open by an earlier step would block this one

  switch ($Cmd) {
    "list" {
      # the sidebar fills in a moment after the app starts: wait for a chat or for "No chats yet"
      $chats = @()
      for ($i = 0; $i -lt 25; $i++) {
        $chats = @(Get-Chats $root)
        if ($chats.Count) { break }
        $none = $root.FindAll($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::Text)) | Where-Object { $_.Current.Name -like "No chats yet*" }
        if ($none) { break }
        Start-Sleep -Milliseconds 400
      }
      Out-Json @{ ok = $true; chats = $chats; prev = [long]$prev }
    }
    "read" {
      Out-Json @{ ok = $true; messages = @(Get-AllMessages $root); prev = [long]$prev }
    }
    "open" {
      $link = $root.FindFirst($TS::Descendants, (Cond $AE::AutomationIdProperty $Id))
      if (-not $link) { throw "chat $Id is not in the Copilot sidebar" }
      try {
        Press $link                                       # keyboard, not InvokePattern (that restores the window)
        Start-Sleep -Milliseconds 200
      } finally { Restore-Focus $h $prev 1500 }
      Start-Sleep -Milliseconds 1200                      # let the conversation load
      Out-Json @{ ok = $true; messages = @(Get-AllMessages $root); prev = [long]$prev }
    }
    "ask" {
      $message = [Console]::In.ReadToEnd()
      if (-not $message.Trim()) { throw "empty message" }
      $null = Find-Editor $root   # fails early, with Copilot's own notice, when chatting is not possible right now
      $link = $null
      if ($New) {
        $link = Find-ByName $root "New chat" $CT::Hyperlink
        if (-not $link) { throw "New chat button not found (expand the Copilot sidebar once)" }
      }
      function Last-Id($pattern) { $x = @(Get-Headings $root $pattern); if ($x.Count) { $x[-1].Current.AutomationId } else { "" } }
      $saved = Get-Clipboard -Raw -ErrorAction SilentlyContinue
      try {
        Set-Clipboard -Value $message
        if ($link) {
          # press "New chat" and make sure the conversation really is empty before pasting, so the message can
          # never land in the previous chat
          $fresh = $false
          for ($try = 1; $try -le 2 -and -not $fresh; $try++) {
            Press $link                                   # the minimized window becomes active without being restored
            for ($i = 0; $i -lt 15 -and -not $fresh; $i++) {
              Start-Sleep -Milliseconds 200
              $fresh = @(Get-Headings $root "*-message-*-title").Count -eq 0
            }
          }
          if (-not $fresh) { Restore-Focus $h $prev 0; throw "could not start a new chat in Copilot" }
          Start-Sleep -Milliseconds 400
        }
        $beforeId = Last-Id "copilot-message-*-title"
        $userBefore = Last-Id "user-message-*-title"
        # Ctrl+A, paste, Enter, then check the message really shows up in the chat; one retry
        for ($try = 1; $try -le 2; $try++) {
          $editor = Find-Editor $root                     # the chat box is re-created by "New chat"
          $findBox = { Find-Editor $root }
          $editor = Focus-Element $editor "the chat box" $findBox
          $editor = Send-KeysTo $editor "^a" "the chat box" $findBox   # replace anything already in the box (a stray keystroke, a draft)
          $editor = Send-KeysTo $editor "^v" "the chat box" $findBox
          Start-Sleep -Milliseconds 250
          $null = Send-KeysTo $editor "{ENTER}" "the chat box" $findBox
          Start-Sleep -Milliseconds 150
          Restore-Focus $h $prev 0
          $sent = $false
          for ($i = 0; $i -lt 20 -and -not $sent; $i++) { Start-Sleep -Milliseconds 200; $sent = (Last-Id "user-message-*-title") -ne $userBefore }
          if ($sent) { break }
        }
        if (-not $sent) { throw "the message did not reach Copilot (is a dialog open in the Copilot app?)" }
      } finally {
        Restore-Focus $h $prev 1500
        if ($saved) { Set-Clipboard -Value $saved }      # give the user's clipboard text back
      }
      # done = the reply has its "Copy Response" button (only looked up, never pressed) and its text stopped changing.
      # A notice that never gets that button is taken once unchanged for 30 s, unless it is a progress line such as
      # "Lining things up..." (Copilot shows those while it thinks).
      $deadline = (Get-Date).AddSeconds($TimeoutSec)
      $reply = $null; $lastSeen = $null; $stable = 0
      while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 1000
        # Copilot can bring its own window up after a message, and a minimized window holding focus is never something
        # you chose: put it back down and hand focus back
        $null = Hide-Copilot
        if ([W]::GetForegroundWindow() -eq $h) { Restore-Focus $h $prev 0 }
        $status = Get-StatusText $root
        if ($status -match 'limit') { throw "Copilot: $status" }
        $heads = @(Get-Headings $root "copilot-message-*-title")
        if (-not $heads.Count -or $heads[-1].Current.AutomationId -eq $beforeId) { continue }
        $msg = $Walker.GetParent($heads[-1])
        $text = Get-MessageText $msg
        if ($text -and $text -eq $lastSeen) { $stable++ } else { $stable = 0 }
        $lastSeen = $text
        $finished = [bool](Find-ByName $msg "Copy Response" $CT::Button)
        # a progress line ("Lining things up...") can show up with the reply's buttons already there: keep waiting
        $progress = $text -match '(\.\.\.|…)\s*$'
        if ($progress -and $stable -lt 60) { continue }
        if (($finished -and $stable -ge 1) -or $stable -ge 30) { $reply = $text; break }
      }
      Restore-Focus $h $prev 300
      if (-not $reply) { throw "no reply from Copilot within $TimeoutSec s" }
      Out-Json @{ ok = $true; text = $reply; prev = [long]$prev }
    }
    "delete" {
      $link = $root.FindFirst($TS::Descendants, (Cond $AE::AutomationIdProperty $Id))
      if (-not $link) { Out-Json @{ ok = $true; gone = $true; prev = [long]$prev }; break }
      # the chat's own "More" button sits right after its link (and its Pin button) in the sidebar
      $more = $Walker.GetNextSibling($link)
      while ($more -and -not ($more.Current.ControlType -eq $CT::Button -and $more.Current.Name -eq "More")) {
        if ($more.Current.ControlType -eq $CT::Hyperlink) { $more = $null; break }
        $more = $Walker.GetNextSibling($more)
      }
      if (-not $more) { throw "no More button next to chat $Id" }
      $problem = $null
      try {
        # "…" menu > Delete > the "Delete chat? <title>" dialog. Right after an earlier delete Copilot is still
        # re-rendering (the sidebar, a navigation), and a keystroke can get lost: the whole step is tried up to 3 times.
        $item = $null; $dialog = $null
        for ($attempt = 1; $attempt -le 3 -and -not $dialog; $attempt++) {
          if ($attempt -gt 1) {
            Close-Popups $root; Start-Sleep -Milliseconds 800
            $link = $root.FindFirst($TS::Descendants, (Cond $AE::AutomationIdProperty $Id))   # the sidebar may have re-rendered
            if (-not $link) { break }
            $more = $Walker.GetNextSibling($link)
            while ($more -and -not ($more.Current.ControlType -eq $CT::Button -and $more.Current.Name -eq "More")) { $more = $Walker.GetNextSibling($more) }
            if (-not $more) { break }
          }
          Press $more
          $item = Wait-For $root "Delete" $CT::MenuItem 2500
          if (-not $item) { continue }
          Press $item
          for ($t = 0; $t -lt 3000 -and -not $dialog; $t += 200) {
            Start-Sleep -Milliseconds 200
            foreach ($w in $root.FindAll($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::Window))) {
              if ($w.Current.Name -like "Delete chat?*") { $dialog = $w; break }
            }
          }
        }
        if (-not $item -and -not $dialog) { $problem = "the chat menu has no Delete item" }
        else {
          $confirm = if ($dialog) { Find-ByName $dialog "Delete" $CT::Button } else { $null }
          $cancel = if ($dialog) { Find-ByName $dialog "Cancel" $CT::Button } else { $null }
          if (-not $confirm) {
            $names = if ($dialog) { @(foreach ($b in $dialog.FindAll($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::Button))) { $b.Current.Name }) -join ', ' } else { "no dialog" }
            $problem = "no Delete button in the confirmation ($names)"
            $null = Dismiss-Dialog $dialog
          } else {
            # the dialog moves focus to its first button a moment after it opens: wait, then make sure Enter
            # lands on Delete and not on Cancel
            Start-Sleep -Milliseconds 700
            # Copilot active and keyboard focus on "Delete" (re-checked right before each Enter)
            $focusDelete = {
              for ($k = 0; $k -lt 6; $k++) {
                if (Ensure-Active) { Focus-Page }
                try { $confirm.SetFocus() } catch { }
                Start-Sleep -Milliseconds 150
                if ((Is-FocusedButton $confirm "Delete") -and -not ($cancel -and (Has-Focus $cancel))) { return $true }
              }
              return $false
            }
            $onDelete = & $focusDelete
            if (-not $onDelete) { $problem = "could not put focus on the Delete button"; $null = Dismiss-Dialog $dialog }
            elseif ($DryRun) { $null = Dismiss-Dialog $dialog }   # everything checked; answer Cancel
            else {
              # press Delete and wait for the dialog to close. It can stay open (a keystroke lost while it animates,
              # or Copilot's server turning down a delete that came too soon): try again, waiting longer each time.
              $closed = $false
              for ($try = 1; $try -le 3 -and -not $closed; $try++) {
                if ($try -gt 1 -and -not (& $focusDelete)) { break }
                [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
                for ($i = 0; $i -lt (10 * $try) -and -not $closed; $i++) {
                  Start-Sleep -Milliseconds 300
                  $closed = -not (@($root.FindAll($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::Window))) | Where-Object { $_.Current.Name -like "Delete chat?*" })
                }
              }
              if (-not $closed) { $problem = "Copilot kept its Delete dialog open (it may be refusing deletes right now; wait a minute and try again)"; $null = Dismiss-Dialog $dialog }
            }
          }
        }
      } finally {
        Close-Popups $root
        Restore-Focus $h $prev 1000
      }
      if ($problem) { throw $problem }
      if ($DryRun) { Out-Json @{ ok = $true; dryRun = $true; checked = "More > Delete > dialog > focus on Delete > Cancel"; prev = [long]$prev }; break }
      $gone = $false
      for ($i = 0; $i -lt 50 -and -not $gone; $i++) {
        Start-Sleep -Milliseconds 200
        $gone = -not $root.FindFirst($TS::Descendants, (Cond $AE::AutomationIdProperty $Id))
      }
      if (-not $gone) { throw "chat $Id is still in the sidebar after Delete" }
      # Copilot removes the chat from the sidebar at once and puts it back if its server refuses the delete
      Start-Sleep -Milliseconds 2500
      if ($root.FindFirst($TS::Descendants, (Cond $AE::AutomationIdProperty $Id))) { throw "Copilot put chat $Id back: its server did not accept the delete" }
      # deleting the open chat makes Copilot navigate, and it can bring its window up: put it back down quietly
      if (Hide-Copilot) { Restore-Focus $h $prev 500 }
      Out-Json @{ ok = $true; prev = [long]$prev }
    }
    default { throw "unknown command $Cmd" }
  }
} catch {
  Out-Json @{ ok = $false; error = $_.Exception.Message }
  exit 1
} finally {
  # whatever happened, never leave the Copilot window up or keyboard focus on it
  if ($h) {
    $null = Hide-Copilot
    if ($prev -and [W]::GetForegroundWindow() -eq $h) { Restore-Focus $h $prev 300 }
  }
}
