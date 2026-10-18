# Driver for tools/screen.ts: lists the open windows, starts an installed app (Start menu) after you allowed it, and
# takes full-screen snaps for test evidence. It brings the chosen app's window to the front (restored or maximized)
# and captures the whole monitor at its own resolution, taskbar included. Red boxes on a snap are found by reading
# the captured picture with Windows' own OCR engine. It never clicks or types inside an app.
# Reads one JSON request on stdin and prints one JSON result.
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class S {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT v, int size);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO i);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }

  public static string Title(IntPtr h) { int n = GetWindowTextLength(h); var sb = new StringBuilder(n + 1); GetWindowText(h, sb, n + 1); return sb.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  // the windows you see in the taskbar / Alt+Tab, front to back
  public static List<IntPtr> AppWindows() {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || GetWindowTextLength(h) == 0) return true;
      if ((GetWindowLong(h, -20 /* GWL_EXSTYLE */) & 0x80 /* WS_EX_TOOLWINDOW */) != 0) return true;
      if (GetWindow(h, 4 /* GW_OWNER */) != IntPtr.Zero) return true;
      int cloaked; if (DwmGetWindowAttribute(h, 14 /* DWMWA_CLOAKED */, out cloaked, 4) == 0 && cloaked != 0) return true;
      list.Add(h); return true;
    }, IntPtr.Zero);
    return list;
  }
  // Put a window on top of the others without taking keyboard focus (needs no foreground rights): briefly topmost,
  // then back to a normal window that stays in front.
  public static void Raise(IntPtr h) {
    const uint NOMOVE_NOSIZE_NOACTIVATE = 0x0002 | 0x0001 | 0x0010;
    SetWindowPos(h, new IntPtr(-1) /* HWND_TOPMOST */, 0, 0, 0, 0, NOMOVE_NOSIZE_NOACTIVATE);
    SetWindowPos(h, new IntPtr(-2) /* HWND_NOTOPMOST */, 0, 0, 0, 0, NOMOVE_NOSIZE_NOACTIVATE);
  }
  // the whole monitor the window is on, taskbar included
  public static RECT Monitor(IntPtr h) { var i = new MONITORINFO(); i.cbSize = Marshal.SizeOf(i); GetMonitorInfo(MonitorFromWindow(h, 2), ref i); return i.rcMonitor; }
  // the window as you see it (without the invisible resize border)
  public static RECT Frame(IntPtr h) { RECT r; if (DwmGetWindowAttribute(h, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r); return r; }
}
"@
# real pixels (the screen's own resolution), also with display scaling
try { if (-not [S]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [void][S]::SetProcessDPIAware() } } catch { try { [void][S]::SetProcessDPIAware() } catch { } }

function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)) }
function Proc-Name([IntPtr]$h) { try { (Get-Process -Id ([S]::Pid($h))).ProcessName } catch { "" } }
function Describe([IntPtr]$h) {
  $t = [S]::Title($h); if ($t.Length -gt 90) { $t = $t.Substring(0, 90) + "..." }
  $s = if ([S]::IsIconic($h)) { " (minimized)" } elseif ([S]::IsZoomed($h)) { " (maximized)" } else { "" }
  "`"$t`" - $(Proc-Name $h)$s"
}

# by process name or (part of) the window title; the front-most match wins
function Find-Window([string]$spec) {
  $best = [IntPtr]::Zero; $score = 0
  foreach ($w in [S]::AppWindows()) {
    $t = [S]::Title($w); $p = Proc-Name $w
    $s = if ($p -ieq $spec -or $t -ieq $spec) { 3 } elseif ($t -like "*$spec*") { 2 } elseif ($p -like "*$spec*") { 1 } else { 0 }
    if ($s -gt $score) { $best = $w; $score = $s }
  }
  if ($best -eq [IntPtr]::Zero) {
    $names = @(foreach ($w in [S]::AppWindows() | Select-Object -First 15) { Describe $w }) -join "; "
    throw "no window matching '$spec'. Open windows: $names"
  }
  return $best
}

# The agent's own browser window: the front-most window of a browser started with that profile folder
# (--user-data-dir=... on its command line), so your own Edge or Chrome windows are never picked
function Find-ProfileWindow([string]$profile) {
  $pids = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($profile, [StringComparison]::OrdinalIgnoreCase) -ge 0
  } | ForEach-Object { [uint32]$_.ProcessId })
  foreach ($w in [S]::AppWindows()) { if ($pids -contains [S]::Pid($w)) { return $w } }
  throw "the agent's browser window is not open"
}

# Bring a window to the front, restored or maximized, and give it a moment to repaint
function Show-Window([IntPtr]$h, [bool]$maximize, [int]$waitMs) {
  if ($maximize) { [void][S]::ShowWindow($h, 3) } elseif ([S]::IsIconic($h)) { [void][S]::ShowWindow($h, 9) }
  [S]::Raise($h)
  Start-Sleep -Milliseconds $waitMs
}

# An installed app by its Start-menu name: exact name first, then names containing it, then a name it contains
function Find-App([string]$app) {
  $all = @(Get-StartApps)
  $exact = @($all | Where-Object { $_.Name -ieq $app })
  if ($exact) { return $exact[0] }
  $part = @($all | Where-Object { $_.Name -like "*$app*" } | Sort-Object { $_.Name.Length })
  if ($part) { return $part[0] }
  $inside = @($all | Where-Object { $_.Name.Length -ge 3 -and $app -like "*$($_.Name)*" } | Sort-Object { - $_.Name.Length })
  if ($inside) { return $inside[0] }
  throw "no installed app named like '$app' in the Start menu"
}

# The whole monitor the window is on, as a bitmap, plus the window's own area inside it (all of it without a window)
function Capture([IntPtr]$h, [bool]$useWindow) {
  $m = [S]::Monitor($h)
  $bmp = New-Object System.Drawing.Bitmap(($m.Right - $m.Left), ($m.Bottom - $m.Top))
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try { $g.CopyFromScreen($m.Left, $m.Top, 0, 0, $bmp.Size) } finally { $g.Dispose() }
  $area = New-Object System.Drawing.Rectangle 0, 0, $bmp.Width, $bmp.Height
  if ($useWindow) {
    $f = [S]::Frame($h)
    $win = New-Object System.Drawing.Rectangle ($f.Left - $m.Left), ($f.Top - $m.Top), ($f.Right - $f.Left), ($f.Bottom - $f.Top)
    $area.Intersect($win)
    if ($area.Width -lt 20 -or $area.Height -lt 20) { $area = New-Object System.Drawing.Rectangle 0, 0, $bmp.Width, $bmp.Height }
  }
  return @{ bmp = $bmp; area = $area }
}

# ── reading the text in a captured picture with Windows' OCR engine (only pixels: nothing in the app is touched) ──
$script:asTask = $null
function Await($op, [Type]$type) {
  $t = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$t.Wait(-1)
  $t.Result
}

# The text in one area of the bitmap as segments: runs of words on one line, each word with its box in the bitmap's
# pixels. A wide gap starts a new segment (the OCR sometimes joins a sidebar item with the text beside it).
function Read-Words([System.Drawing.Bitmap]$bmp, [System.Drawing.Rectangle]$area) {
  if (-not $script:asTask) {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
    $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
  }
  $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language "en-US"))
  if (-not $eng) { $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $eng) { throw "Windows has no OCR language (Settings > Time & language > Language & region: add English)" }
  # app text is small: it reads much better enlarged
  $k = [Math]::Min(2.0, ([Windows.Media.Ocr.OcrEngine]::MaxImageDimension - 1) / [Math]::Max($area.Width, $area.Height))
  $big = New-Object System.Drawing.Bitmap ([int]($area.Width * $k)), ([int]($area.Height * $k))
  $g = [System.Drawing.Graphics]::FromImage($big)
  $ms = New-Object System.IO.MemoryStream
  try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($bmp, (New-Object System.Drawing.Rectangle 0, 0, $big.Width, $big.Height), $area, [System.Drawing.GraphicsUnit]::Pixel)
    $big.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $ms.Position = 0
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync([System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms))) ([Windows.Graphics.Imaging.BitmapDecoder])
    $soft = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($eng.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
  } finally { $g.Dispose(); $big.Dispose(); $ms.Dispose() }
  $segs = New-Object System.Collections.ArrayList
  foreach ($line in $res.Lines) {
    $cur = $null
    foreach ($w in $line.Words) {
      $r = $w.BoundingRect
      $o = [pscustomobject]@{ t = $w.Text; x = $area.X + $r.X / $k; y = $area.Y + $r.Y / $k; w = $r.Width / $k; h = $r.Height / $k }
      if ($null -ne $cur) {
        $last = $cur[$cur.Count - 1]
        if ($o.x - ($last.x + $last.w) -gt [Math]::Max(30, 3 * $o.h)) { [void]$segs.Add($cur); $cur = $null }
      }
      if ($null -eq $cur) { $cur = New-Object System.Collections.ArrayList }
      [void]$cur.Add($o)
    }
    if ($null -ne $cur) { [void]$segs.Add($cur) }
  }
  return ,$segs
}

# letters and digits only, lower case; loose also folds the usual OCR mix-ups (0/o, 1/i/l, 5/s)
function Norm([string]$s, [bool]$loose) {
  $t = $s.ToLowerInvariant() -replace '[^\p{L}\p{N}]', ''
  if ($loose) { $t = $t -replace '0', 'o' -replace '[1i]', 'l' -replace '5', 's' }
  $t
}

function Box($words) {
  $l = [double]::MaxValue; $t = [double]::MaxValue; $r = 0; $b = 0
  foreach ($w in $words) { $l = [Math]::Min($l, $w.x); $t = [Math]::Min($t, $w.y); $r = [Math]::Max($r, $w.x + $w.w); $b = [Math]::Max($b, $w.y + $w.h) }
  [pscustomobject]@{ x = $l; y = $t; w = $r - $l; h = $b - $t }
}

# Every place a one-line text shows up, top to bottom. Case, spaces and punctuation don't count (OCR splits and joins
# words around quotes and colons), but a match must start and end at a word edge ("POST" is not the start of
# "Postman"). Then the loose form is tried, and for long texts a match inside a word. whole = the match is all the
# text of its segment (a button or a label on its own, rather than a word in a sentence).
function Find-Line($segs, [string]$text) {
  $passes = @(@{ loose = $false; edges = $true }, @{ loose = $true; edges = $true })
  if ((Norm $text $false).Length -ge 8) { $passes += @{ loose = $false; edges = $false }, @{ loose = $true; edges = $false } }
  foreach ($p in $passes) {
    $needle = Norm $text $p.loose
    $hits = New-Object System.Collections.ArrayList
    foreach ($seg in $segs) {
      $sb = New-Object System.Text.StringBuilder
      $owner = New-Object System.Collections.Generic.List[int]
      $edge = New-Object System.Collections.Generic.List[int] # 1 = a word starts here, 2 = a word ends here
      for ($i = 0; $i -lt $seg.Count; $i++) {
        foreach ($m in [regex]::Matches($seg[$i].t, '[\p{L}\p{N}]+')) {
          $n = Norm $m.Value $p.loose
          for ($c = 0; $c -lt $n.Length; $c++) {
            $owner.Add($i); $edge.Add($(if ($c -eq 0) { 1 } else { 0 }) -bor $(if ($c -eq $n.Length - 1) { 2 } else { 0 }))
          }
          [void]$sb.Append($n)
        }
      }
      $hay = $sb.ToString()
      $at = $hay.IndexOf($needle, [StringComparison]::Ordinal)
      while ($at -ge 0) {
        $end = $at + $needle.Length - 1
        if (-not $p.edges -or (($edge[$at] -band 1) -and ($edge[$end] -band 2))) {
          $b = Box $seg.GetRange($owner[$at], $owner[$end] - $owner[$at] + 1)
          [void]$hits.Add(($b | Add-Member -NotePropertyName whole -NotePropertyValue ($at -eq 0 -and $end -eq $hay.Length - 1) -PassThru))
          $at = $hay.IndexOf($needle, $end + 1, [StringComparison]::Ordinal)
        } else {
          $at = $hay.IndexOf($needle, $at + 1, [StringComparison]::Ordinal)
        }
      }
    }
    if ($hits.Count) { return ,@($hits | Sort-Object { [int]($_.y / 8) }, x) }
  }
  return ,@()
}

# A text of several lines (a JSON payload): its lines found one under the other in the same column, as one box.
# Returns the box and how many of the lines were found (OCR may miss one); null when fewer than half were.
function Find-Block($segs, [string[]]$lines) {
  $hits = @(foreach ($l in $lines) { ,(Find-Line $segs $l) })
  $best = $null
  for ($j = 0; $j -lt $lines.Count; $j++) {
    foreach ($start in $hits[$j]) {
      $chain = New-Object System.Collections.ArrayList
      [void]$chain.Add($start); $prev = $start; $missed = 0
      for ($k = $j + 1; $k -lt $lines.Count; $k++) {
        $limit = $prev.y + $prev.h + ($missed + 1) * 2.5 * $prev.h + 6
        $next = @($hits[$k] | Where-Object { $_.y -gt $prev.y + $prev.h / 2 -and $_.y -lt $limit -and [Math]::Abs($_.x - $start.x) -lt 400 } | Sort-Object y)
        if ($next.Count) { [void]$chain.Add($next[0]); $prev = $next[0]; $missed = 0 } else { $missed++ }
      }
      if (-not $best -or $chain.Count -gt $best.Count) { $best = $chain }
    }
  }
  if (-not $best -or $best.Count -lt [Math]::Ceiling($lines.Count / 2)) { return $null }
  return @{ box = (Box $best); found = $best.Count }
}

# where a box is inside the window, in words, plus its position in the picture
function Place($b, [System.Drawing.Rectangle]$area) {
  $cx = ($b.x + $b.w / 2 - $area.X) / $area.Width; $cy = ($b.y + $b.h / 2 - $area.Y) / $area.Height
  $col = if ($cx -lt 0.33) { "left" } elseif ($cx -lt 0.67) { "centre" } else { "right" }
  $row = if ($cy -lt 0.33) { "top" } elseif ($cy -lt 0.67) { "middle" } else { "bottom" }
  "$col $row at $([int]$b.x),$([int]$b.y)"
}

# Red boxes around the given texts on the bitmap, like a tester marking a screenshot by hand. An item is a text or
# {text, pick}: a text that shows up in several places gets a box on each (6 at most) unless pick names one (1 = the
# top one). Returns one line per item for the result, so it is clear what was and wasn't boxed.
function Highlight([System.Drawing.Bitmap]$bmp, [System.Drawing.Rectangle]$area, $items) {
  $segs = Read-Words $bmp $area
  $boxes = New-Object System.Collections.ArrayList
  $report = foreach ($item in @($items)) {
    $text = if ($item -is [string]) { $item } else { [string]$item.text }
    $pick = if ($item -isnot [string] -and $item.pick) { [int]$item.pick } else { 0 }
    $label = ($text -replace '\s+', ' ').Trim(); if ($label.Length -gt 60) { $label = $label.Substring(0, 60) + "..." }
    $lines = @($text -split "\r?\n" | Where-Object { (Norm $_ $false).Length -ge 2 })
    if (-not $lines) { "NOT boxed: `"$label`" has no letters or digits to look for"; continue }
    if ($lines.Count -gt 1) {
      $blk = Find-Block $segs $lines
      if (-not $blk) { "NOT boxed: the lines of `"$label`" were not found together on the screen (check with action read)"; continue }
      [void]$boxes.Add($blk.box)
      "red box around `"$label`" ($($blk.found) of $($lines.Count) lines found, $(Place $blk.box $area))"
      continue
    }
    $found = Find-Line $segs $lines[0]   # already an array (no @(): that would wrap it once more)
    if (-not $found.Count) { "NOT boxed: `"$label`" was not found on the screen (hidden, scrolled away or read differently: action read shows the text Windows reads)"; continue }
    if ($pick -gt $found.Count) { "NOT boxed: `"$label`" shows up $($found.Count) time(s), there is no #$pick"; continue }
    if ($pick) {
      [void]$boxes.Add($found[$pick - 1])
      "red box around `"$label`" (#$pick of $($found.Count): $(Place $found[$pick - 1] $area))"
      continue
    }
    # several places: where it stands on its own (the Send button) rather than inside a sentence ("Click Send to ...")
    $idx = @(for ($i = 0; $i -lt $found.Count; $i++) { $i })
    $alone = @($idx | Where-Object { $found[$_].whole })
    if ($alone.Count -and $alone.Count -lt $found.Count) { $idx = $alone }
    $idx = @($idx | Select-Object -First 6)
    foreach ($i in $idx) { [void]$boxes.Add($found[$i]) }
    $where = (@(foreach ($i in $idx) { "#$($i + 1) $(Place $found[$i] $area)" }) -join "; ")
    $line = if ($idx.Count -eq 1) { "red box around `"$label`" ($where)" } else { "red boxes around `"$label`" in $($idx.Count) places ($where)" }
    if ($found.Count -gt 1) {
      $rest = @(for ($i = 0; $i -lt $found.Count; $i++) { if ($idx -notcontains $i) { "#$($i + 1) $(Place $found[$i] $area)" } })
      $line += $(if ($rest.Count) { "; not boxed: " + ($rest -join "; ") } else { "" }) + ". To box just one, give {`"text`": ..., `"pick`": n}"
    }
    $line
  }
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 230, 20, 20)), 3
  try {
    foreach ($b in $boxes) { $g.DrawRectangle($pen, [int]($b.x - 5), [int]($b.y - 5), [int]($b.w + 10), [int]($b.h + 10)) }
  } finally { $pen.Dispose(); $g.Dispose() }
  return ,@($report)
}

try {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  switch ([string]$req.action) {
    "open" {
      $app = Find-App ([string]$req.app)
      $before = @([S]::AppWindows())
      Start-Process "shell:AppsFolder\$($app.AppID)"
      # its window: a new one, or (an app that was already running) one with its name
      $win = [IntPtr]::Zero
      $short = ($app.Name -split '\s')[0]
      for ($i = 0; $i -lt 40 -and $win -eq [IntPtr]::Zero; $i++) {
        Start-Sleep -Milliseconds 500
        $now = @([S]::AppWindows())
        $new = @($now | Where-Object { $before -notcontains $_ })
        $named = @($now | Where-Object { [S]::Title($_) -like "*$short*" -or (Proc-Name $_) -like "*$short*" })
        if ($new) { $win = $new[0] } elseif ($i -ge 6 -and $named) { $win = $named[0] }
      }
      if ($win -eq [IntPtr]::Zero) { Out-Json @{ ok = $true; text = "started $($app.Name); no window yet (it may still be loading: check with windows, then snap)" }; break }
      Start-Sleep -Milliseconds 1500   # let it finish drawing its first screen
      Show-Window $win ([bool]$req.maximize) 500
      Out-Json @{ ok = $true; text = "started $($app.Name): " + (Describe $win) + " in front" }
    }
    "windows" {
      $fg = [S]::GetForegroundWindow()
      $lines = @(foreach ($w in [S]::AppWindows() | Select-Object -First 60) { $(if ($w -eq $fg) { "* " } else { "- " }) + (Describe $w) })
      Out-Json @{ ok = $true; text = "Open windows, front first (* = active):`n" + ($lines -join "`n") }
    }
    "snap" {
      $h = [S]::GetForegroundWindow()
      $named = [bool]($req.window -or $req.profile)
      if ($named) {
        $h = if ($req.profile) { Find-ProfileWindow ([string]$req.profile) } else { Find-Window ([string]$req.window) }
        if ([S]::Title($h) -like "M365 Agent*") { throw "that is this agent's own page; name the app to show" }
        Show-Window $h ([bool]$req.maximize) ([int]$(if ($req.wait) { $req.wait } else { 800 }))
      }
      $cap = Capture $h $named
      $bmp = $cap.bmp
      try {
        $marks = if (@($req.highlight).Count -and $req.highlight) { Highlight $bmp $cap.area $req.highlight } else { @() }
        [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent ([string]$req.out)))
        $bmp.Save([string]$req.out, [System.Drawing.Imaging.ImageFormat]::Png)
        $size = "$($bmp.Width)x$($bmp.Height)"
      } finally { $bmp.Dispose() }
      $text = "full screen $size, taskbar included" + $(if ($named) { ", with " + (Describe $h) + " in front" } else { "" })
      if ($marks.Count) { $text += "`n" + ($marks -join "`n") }
      Out-Json @{ ok = $true; text = $text }
    }
    "read" {
      if (-not $req.window) { throw "name the window to read, e.g. {`"action`": `"read`", `"window`": `"Postman`"}" }
      $h = Find-Window ([string]$req.window)
      if ([S]::Title($h) -like "M365 Agent*") { throw "that is this agent's own page; name the app to read" }
      Show-Window $h ([bool]$req.maximize) ([int]$(if ($req.wait) { $req.wait } else { 800 }))
      $cap = Capture $h $true
      try { $segs = Read-Words $cap.bmp $cap.area } finally { $cap.bmp.Dispose() }
      $rows = @($segs | Sort-Object { [int]($_[0].y / 8) }, { $_[0].x } | Select-Object -First 300 | ForEach-Object {
        "$([int]$_[0].x),$([int]$_[0].y): " + (@($_ | ForEach-Object { $_.t }) -join " ")
      })
      Out-Json @{ ok = $true; text = "Text Windows reads in " + (Describe $h) + " (x,y: text; left to right, top to bottom):`n" + ($rows -join "`n") }
    }
    "clipboard" {
      $text = [string]$req.text
      if (-not $text) { throw "no text to copy: put it in a code block after the JSON" }
      Set-Clipboard -Value $text
      Out-Json @{ ok = $true; text = "copied $($text.Length) characters to the clipboard (paste with Ctrl+V)" }
    }
    default { throw "unknown action '$($req.action)'; use windows, open, snap, read or clipboard" }
  }
} catch {
  Out-Json @{ ok = $false; error = $_.Exception.Message }
}
