# dsh-remote - multi-session per-context E2E against the REAL local SSH endpoints.
#
# Boots an isolated DSH harness (same sandbox recipe as scripts/boot-smoke.ps1)
# that carries the product registry (machines.json), then drives the per-session
# web routes with HTTP:
#
#   e2e-s1  -> server-b  m-mtgxru10-rfof  (127.0.0.1:12922, user user)  ws /tmp
#   e2e-s2  -> server-a     m-mth1c6hl-wvus  (127.0.0.1:12722, user user)  ws /tmp
#             FALLBACK (spec): if server-a auth fails -> server-b + ws /home/user,
#             and a NOTE is printed (server-a has no stored password).
#
# Hard assertions:
#   1. s1 connects; /status?sessionId=e2e-s1 -> connected, right host/port, ws /tmp
#   2. s2 connects (server-a or fallback); /status?sessionId=e2e-s2 -> connected,
#      right host/port, its workspace; s1 and s2 workspaces are DISTINCT
#   3. /ls?path=<ws>&sessionId=... -> 200 with items for EACH session (per-session
#      routing: same port, different contexts)
#   4. disconnect s1 (POST /connect {action:'disconnect', sessionId}) -> s1
#      connected=false, s2 STILL connected (per-context disconnect)
#   5. fresh e2e-fresh -> /status connected=false, no machineId (no inheritance)
#   6. sessionMode (spec 12.5): bound sessions report 'remote' (sessionRemotePath
#      empty for synthetic ids), fresh session reports 'local'
#   7. legacy no-sessionId /status -> __global__ connected:false sessionMode:'local'
#      while s1/s2 stay connected (global unaffected by bound sessions)
#   8. raw contexts.json: no 'password'/'passphrase' key, and no server-b
#      plain-password string (credential guarantee proven E2E, not only in unit)
#
# The sandbox's machines.json is a COPY of the product registry with
# currentId blanked (NOTE printed) so the global auto-restore never probes an
# external production host from the sandbox.
#
# Usage:  pwsh -File scripts/e2e-multisession.ps1 [-Port N] [-TimeoutSec N]
# Exit:   0 when every assertion passes, 1 otherwise.
#
# ASCII-only on purpose: Windows PowerShell 5.1 (no BOM) would misread any
# non-ASCII literal in this script.

param(
  [int]$Port = 0,
  [int]$TimeoutSec = 180
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

$nodeExe      = 'D:\Program Files\DSH Desktop\resources\app\node_modules\node\bin\node.exe'
$binJs        = 'D:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js'
$patchYml     = 'D:\Program Files\DSH Desktop\resources\dsh-desktop.patch.yml'
$productHome  = Join-Path $env:APPDATA 'dsh-desktop\harness'
$productWeb   = Join-Path $productHome 'profiles\web'
$productMachines = Join-Path $productHome 'remote-workspaces\machines.json'

foreach ($p in @($nodeExe, $binJs, $patchYml, $productWeb, $productMachines, (Join-Path $repo 'lib'))) {
  if (-not (Test-Path $p)) {
    Write-Host "e2e: missing input: $p"
    exit 1
  }
}

$root        = Join-Path $repo 'dev-harness-smoke'
$homeDir     = Join-Path $root 'harness'
$profileCopy = Join-Path $homeDir 'profiles\web'
$logOut      = Join-Path $root 'e2e.out.log'
$logErr      = Join-Path $root 'e2e.err.log'

# --- junction enumeration: BFS that does NOT follow reparse points
function Get-Junctions {
  param([string]$Root)
  $found = @()
  $queue = @($Root)
  $head = 0
  while ($head -lt $queue.Count) {
    $dir = $queue[$head]
    $head++
    $entries = Get-ChildItem $dir -Directory -Force -ErrorAction SilentlyContinue
    foreach ($e in $entries) {
      if ($e.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        $found += [pscustomobject]@{ Path = $e.FullName; Target = $e.Target }
      } else {
        $queue += $e.FullName
      }
    }
  }
  return $found
}

# --- pick a port that can actually be bound: Windows winnat keeps dynamic
# port-exclusion ranges where listen() fails with EACCES even when the port
# is "free". Probe the real bind with the bundled node before committing.
function Get-UsablePort {
  param([string]$Node)
  for ($i = 0; $i -lt 12; $i++) {
    $p = 45000 + (Get-Random -Maximum 20000)
    $js = "const s=require('net').createServer();s.on('error',()=>process.exit(1));s.listen($p,'127.0.0.1',()=>{s.close();process.exit(0)});setTimeout(()=>process.exit(1),2500)"
    & $Node -e $js | Out-Null
    if ($LASTEXITCODE -eq 0) { return $p }
  }
  return 0
}

# --- assertion helper
$script:failures = @()
function Check {
  param([string]$Name, [scriptblock]$Block)
  try {
    $r = & $Block
    Write-Host "  [ok]   $Name"
    return $r
  } catch {
    $msg = "$($_.Exception.Message)"
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $msg += " | body: $($_.ErrorDetails.Message)" }
    Write-Host "  [FAIL] $Name : $msg"
    $script:failures += "$Name : $msg"
    return $null
  }
}

if ($Port -le 0 -or $Port -gt 65535) {
  $Port = Get-UsablePort -Node $nodeExe
  if ($Port -le 0) { Write-Host 'e2e: FAIL - no bindable port found'; exit 1 }
}

$proc = $null
$exitCode = 1

try {
  # ── sandbox: isolated DSH_HOME + profile copy + source overlay ────────────
  Write-Host "e2e: isolated DSH_HOME: $homeDir"
  if (Test-Path $root) { Remove-Item $root -Recurse -Force }
  New-Item -ItemType Directory -Path (Join-Path $homeDir 'profiles') | Out-Null

  Write-Host 'e2e: enumerating profile junctions (non-following walk) ...'
  $junctions = @(Get-Junctions -Root $productWeb)
  Write-Host ("e2e: found {0} junctions in the product profile" -f $junctions.Count)

  Write-Host 'e2e: copying real profile files (robocopy /E /XJ) ...'
  robocopy $productWeb $profileCopy /E /XJ /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) {
    Write-Host ("e2e: FAIL - robocopy error (exit {0})" -f $LASTEXITCODE)
    exit 1
  }

  Write-Host 'e2e: re-creating junctions inside the copy ...'
  $skipJunction = Join-Path $profileCopy 'node_modules\dsh-remote'
  $recreated = 0
  foreach ($j in $junctions) {
    $rel = $j.Path.Substring($productWeb.Length).TrimStart('\')
    $destJ = Join-Path $profileCopy $rel
    if ($destJ -ieq $skipJunction) { continue }
    $t = $j.Target
    if ($null -ne $t -and $t -is [System.Collections.IList] -and $t.Count -gt 0) { $t = $t[0] }
    if ([string]::IsNullOrWhiteSpace($t)) { continue }
    $resolved = $t
    if ($t -match '^[a-zA-Z]:') {
      if ($t -ieq $productWeb -or $t.StartsWith($productWeb + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        $resolved = Join-Path $profileCopy $t.Substring($productWeb.Length).TrimStart('\')
      }
    } else {
      $resolved = Join-Path (Split-Path $destJ -Parent) $t
    }
    if (-not (Test-Path $destJ)) {
      New-Item -ItemType Junction -Path $destJ -Target $resolved -ErrorAction SilentlyContinue | Out-Null
      $recreated++
    }
  }
  Write-Host ("e2e: re-created {0} junctions" -f $recreated)

  $pluginCopy = Join-Path $profileCopy 'node_modules\dsh-remote'
  if (Test-Path $pluginCopy) { Remove-Item $pluginCopy -Recurse -Force }
  New-Item -ItemType Directory -Path $pluginCopy | Out-Null
  Copy-Item (Join-Path $repo 'lib') (Join-Path $pluginCopy 'lib') -Recurse
  Copy-Item (Join-Path $repo 'package.json') (Join-Path $pluginCopy 'package.json') -Force
  Copy-Item (Join-Path $repo 'cordis.patch.yml') (Join-Path $pluginCopy 'cordis.patch.yml') -Force
  Write-Host 'e2e: dsh-remote source (this repo lib/) overlaid in the isolated profile'

  # sandbox registry: copy of the product machines.json with currentId blanked
  $rwRoot = Join-Path $homeDir 'remote-workspaces'
  New-Item -ItemType Directory -Path $rwRoot | Out-Null
  $mach = Get-Content $productMachines -Raw | ConvertFrom-Json
  if ($mach.currentId) {
    Write-Host "e2e: NOTE - blanking registry currentId '$($mach.currentId)' in the sandbox copy (avoids auto-restore probing an external production host)"
    $mach.currentId = ''
  }
  $mach | ConvertTo-Json -Depth 10 | ForEach-Object {
    # NO BOM: PS 5.1 Set-Content -Encoding UTF8 writes a BOM, which makes the
    # plugin's JSON.parse fail and silently fall back to an empty registry
    [System.IO.File]::WriteAllText((Join-Path $rwRoot 'machines.json'), ($_ -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
  }

  $prevHome = $env:DSH_HOME
  $env:DSH_HOME = $homeDir

  Write-Host "e2e: starting isolated harness on 127.0.0.1:$Port (kept running for the session tests) ..."
  $argStr = "--expose-internals `"$binJs`" web --patch `"$patchYml`" --host 127.0.0.1 --port $Port"
  $proc = Start-Process -FilePath $nodeExe -NoNewWindow -PassThru `
    -ArgumentList $argStr `
    -WorkingDirectory $repo `
    -RedirectStandardOutput $logOut `
    -RedirectStandardError $logErr

  $ok = 0
  for ($i = 1; $i -le $TimeoutSec; $i++) {
    Start-Sleep -Seconds 1
    $tail = ''
    if (Test-Path $logOut) { $tail += (Get-Content $logOut -Raw -ErrorAction SilentlyContinue) }
    if (Test-Path $logErr) { $tail += (Get-Content $logErr -Raw -ErrorAction SilentlyContinue) }
    if ($tail -match 'DSH entry failed') { break }
    if ($tail -match 'dsh web: http') { $ok = 1; break }
    if ($proc.HasExited) { break }
    if ($i % 10 -eq 0) {
      $lastLine = @($tail -split "`r?`n" | Where-Object { $_ -ne '' } | Select-Object -Last 1)[0]
      Write-Host ("e2e: ...{0}s still starting: {1}" -f $i, $lastLine)
    }
  }
  if (-not $ok) {
    Write-Host 'e2e: FAIL - harness did not become healthy. Log tail:'
    if (Test-Path $logOut) { Get-Content $logOut -Tail 30 | ForEach-Object { Write-Host "  | $_" } }
    if (Test-Path $logErr) { Get-Content $logErr -Tail 30 | ForEach-Object { Write-Host "  | $_" } }
    exit 1 # finally cleans up
  }
  Write-Host "e2e: harness healthy on :$Port"

  $base = "http://127.0.0.1:$Port"
  function Invoke-JsonCore {
    param([string]$Method, [string]$Path, $Body)
    try {
      if ($Method -eq 'Post') {
        return Invoke-RestMethod -Uri "$base$Path" -Method Post -Body ($Body | ConvertTo-Json -Compress -Depth 5) -ContentType 'application/json' -TimeoutSec 60
      }
      return Invoke-RestMethod -Uri "$base$Path" -Method Get -TimeoutSec 60
    } catch {
      $detail = ''
      $code = ''
      try {
        $resp = $_.Exception.Response
        if ($resp) {
          $code = [int]$resp.StatusCode
          $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
          $detail = $sr.ReadToEnd()
          $sr.Close()
        }
      } catch {}
      if (-not $detail -and $_.ErrorDetails -and $_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message }
      throw ("HTTP {0} {1} {2}" -f $code, $Path, $detail)
    }
  }
  $postJson = {
    param([string]$Path, $Body)
    Invoke-JsonCore -Method Post -Path $Path -Body $Body
  }
  $getJson = {
    param([string]$Path)
    Invoke-JsonCore -Method Get -Path $Path
  }

  # ── session 1: server-b + /tmp ─────────────────────────────────────────────
  # NOTE on ordering: the pool is LAZY by design (spec §4) - /workspace re-targets
  # the pool (setTarget closes the client), so `connected` in /status is only
  # guaranteed true AFTER a pool operation. We prove the live connection with
  # /ls (a real SSH round-trip) and then assert /status connected=true.
  Write-Host ''
  Write-Host 'e2e: binding e2e-s1 -> server-b (m-mtgxru10-rfof) ws /tmp'
  $s1 = Check 's1 connect (server-b, machineId; ping echo ok inside route)' {
    $r = & $postJson '/dsh-remote/connect' @{ sessionId = 'e2e-s1'; machineId = 'm-mtgxru10-rfof' }
    if (-not $r -or $r.ok -ne $true) { throw "connect not ok: $($r | ConvertTo-Json -Compress -Depth 4)" }
    return $r
  }
  $s1ws = Check 's1 workspace /tmp' {
    $r = & $postJson '/dsh-remote/workspace' @{ sessionId = 'e2e-s1'; path = '/tmp' }
    if (-not $r -or $r.ok -ne $true -or $r.workspace -ne '/tmp') { throw "workspace not set: $($r | ConvertTo-Json -Compress -Depth 4)" }
    return $r
  }
  Check 's1 /ls /tmp -> 200 with items (proves the live per-session pool)' {
    $r = & $getJson '/dsh-remote/ls?sessionId=e2e-s1&path=%2Ftmp'
    if ($null -eq $r -or -not ($r.PSObject.Properties.Name -contains 'items')) { throw "no items in response: $($r | ConvertTo-Json -Compress -Depth 3)" }
    if (@($r.items).Count -lt 1) { throw 'expected at least one item in /tmp' }
    Write-Host ("         (s1 /tmp has {0} entries)" -f @($r.items).Count)
    return $r
  }
  $st1 = Check 's1 status: connected, 127.0.0.1:12922, ws /tmp, sessionMode remote (after pool use)' {
    $r = & $getJson '/dsh-remote/status?sessionId=e2e-s1'
    if ($r.connected -ne $true) { throw "not connected: $($r | ConvertTo-Json -Compress -Depth 2)" }
    if ($r.host -ne '127.0.0.1') { throw "wrong host: $($r.host)" }
    if ($r.port -ne 12922) { throw "wrong port: $($r.port)" }
    if ($r.workspace -ne '/tmp') { throw "wrong workspace: $($r.workspace)" }
    if ($r.sessionMode -cne 'remote') { throw "sessionMode expected 'remote', got '$($r.sessionMode)'" }
    if ("$($r.sessionRemotePath)" -ne '') { throw "sessionRemotePath expected empty (no local-cwd mirror for a synthetic session), got '$($r.sessionRemotePath)'" }
    return $r
  }

  # ── session 2: server-a (fallback: server-b + /home/user) ──────────────────────
  Write-Host ''
  Write-Host 'e2e: binding e2e-s2 -> server-a (m-mth1c6hl-wvus) ws /tmp'
  $s2host = '127.0.0.1'
  $s2port = 12722
  $s2ws = '/tmp'
  $s2 = Check 's2 connect (server-a, machineId)' {
    $r = & $postJson '/dsh-remote/connect' @{ sessionId = 'e2e-s2'; machineId = 'm-mth1c6hl-wvus' }
    if (-not $r -or $r.ok -ne $true) { throw "server-a connect not ok: $($r | ConvertTo-Json -Compress -Depth 4)" }
    return $r
  }
  if ($null -eq $s2) {
    Write-Host 'e2e: NOTE - server-a auth failed (no stored password); FALLBACK: e2e-s2 -> server-b (m-mtgxru10-rfof) ws /home/user'
    $s2port = 12922
    $s2ws = '/home/user'
    $s2 = Check 's2 connect (FALLBACK server-b)' {
      $r = & $postJson '/dsh-remote/connect' @{ sessionId = 'e2e-s2'; machineId = 'm-mtgxru10-rfof' }
      if (-not $r -or $r.ok -ne $true) { throw "fallback connect not ok: $($r | ConvertTo-Json -Compress -Depth 4)" }
      return $r
    }
  }
  if ($null -ne $s2) {
    Check 's2 workspace' {
      $r = & $postJson '/dsh-remote/workspace' @{ sessionId = 'e2e-s2'; path = $s2ws }
      if (-not $r -or $r.ok -ne $true -or $r.workspace -ne $s2ws) { throw "workspace not set: $($r | ConvertTo-Json -Compress -Depth 4)" }
      return $r
    }
    Check ("s2 /ls {0} -> 200 with items (proves the live per-session pool)" -f $s2ws) {
      $r = & $getJson ("/dsh-remote/ls?sessionId=e2e-s2&path=" + ([uri]::EscapeDataString($s2ws)))
      if ($null -eq $r -or -not ($r.PSObject.Properties.Name -contains 'items')) { throw "no items in response: $($r | ConvertTo-Json -Compress -Depth 3)" }
      if (@($r.items).Count -lt 1) { throw "expected at least one item in $s2ws" }
      Write-Host ("         (s2 {0} has {1} entries)" -f $s2ws, @($r.items).Count)
      return $r
    }
  }

  $st2 = Check ("s2 status: connected, {0}:{1}, ws {2}, sessionMode remote (after pool use)" -f $s2host, $s2port, $s2ws) {
    $r = & $getJson '/dsh-remote/status?sessionId=e2e-s2'
    if ($r.connected -ne $true) { throw "not connected: $($r | ConvertTo-Json -Compress -Depth 2)" }
    if ($r.host -ne $s2host) { throw "wrong host: $($r.host)" }
    if ($r.port -ne $s2port) { throw "wrong port: $($r.port)" }
    if ($r.workspace -ne $s2ws) { throw "wrong workspace: $($r.workspace)" }
    if ($r.sessionMode -cne 'remote') { throw "sessionMode expected 'remote', got '$($r.sessionMode)'" }
    if ("$($r.sessionRemotePath)" -ne '') { throw "sessionRemotePath expected empty (no local-cwd mirror for a synthetic session), got '$($r.sessionRemotePath)'" }
    return $r
  }

  # distinctness: the two sessions must be distinguishable (host/port or workspace)
  Check 's1 and s2 are distinct contexts' {
    $a = & $getJson '/dsh-remote/status?sessionId=e2e-s1'
    $b = & $getJson '/dsh-remote/status?sessionId=e2e-s2'
    $sameEndpoint = ($a.host -eq $b.host) -and ($a.port -eq $b.port)
    if ($sameEndpoint -and $a.workspace -eq $b.workspace) {
      throw 'both sessions point at the identical host:port + workspace'
    }
    return $true
  }

  # ── spec 12.5: legacy no-sessionId probe + raw credential inspection ───────
  Check 'legacy /status (no sessionId): __global__ connected:false sessionMode:local; s1+s2 still connected' {
    $r = & $getJson '/dsh-remote/status'
    if ($r.contextId -cne '__global__') { throw "expected __global__ context, got '$($r.contextId)'" }
    if ($r.connected -ne $false) { throw 'global context unexpectedly connected' }
    if ($r.sessionMode -cne 'local') { throw "global sessionMode expected 'local', got '$($r.sessionMode)'" }
    $a = & $getJson '/dsh-remote/status?sessionId=e2e-s1'
    $b = & $getJson '/dsh-remote/status?sessionId=e2e-s2'
    if ($a.connected -ne $true) { throw 'e2e-s1 no longer connected' }
    if ($b.connected -ne $true) { throw 'e2e-s2 no longer connected' }
    return $r
  }
  Check 'raw contexts.json: s1+s2 entries, no password/passphrase key, no server-b plain-password string' {
    $ctxFile = Join-Path $rwRoot 'contexts.json'
    if (-not (Test-Path $ctxFile)) { throw "missing $ctxFile" }
    $raw = Get-Content $ctxFile -Raw
    $j = $raw | ConvertFrom-Json
    if ($j.contexts.PSObject.Properties.Name -notcontains 'e2e-s1') { throw 'e2e-s1 entry missing' }
    if ($j.contexts.PSObject.Properties.Name -notcontains 'e2e-s2') { throw 'e2e-s2 entry missing' }
    if (-not $j.contexts.'e2e-s1'.machineId) { throw 'e2e-s1 entry has no machineId' }
    if (-not $j.contexts.'e2e-s1'.workspace) { throw 'e2e-s1 entry has no workspace' }
    $credKeys = Select-String -Path $ctxFile -Pattern '"(password|passphrase)"'
    if ($credKeys) { throw ("credential key present in contexts.json: " + (($credKeys | ForEach-Object { $_.Line.Trim() }) -join '; ')) }
    $sandMach = Get-Content (Join-Path $rwRoot 'machines.json') -Raw | ConvertFrom-Json
    $serverBPw = ($sandMach.list | Where-Object { $_.id -eq 'm-mtgxru10-rfof' }).password
    if ($serverBPw) {
      $leak = Select-String -Path $ctxFile -Pattern $serverBPw -SimpleMatch
      if ($leak) { throw 'server-b plain-password string leaked into contexts.json' }
      Write-Host '         (server-b plain password verified absent from contexts.json)'
    } else {
      Write-Host '         (NOTE: server-b has no plain password in the sandbox registry; string check skipped, key check applied)'
    }
    return $raw
  }

  # ── disconnect independence ────────────────────────────────────────────────
  Write-Host ''
  Write-Host 'e2e: disconnect s1 (per-context), s2 must stay connected'
  Check 's1 disconnect (action=disconnect, sessionId=e2e-s1)' {
    $r = & $postJson '/dsh-remote/connect' @{ sessionId = 'e2e-s1'; action = 'disconnect' }
    if (-not $r -or $r.ok -ne $true) { throw "disconnect not ok: $($r | ConvertTo-Json -Compress -Depth 4)" }
    return $r
  }
  Check 's1 now disconnected (binding kept)' {
    Start-Sleep -Seconds 1
    $r = & $getJson '/dsh-remote/status?sessionId=e2e-s1'
    if ($r.connected -ne $false) { throw "s1 still connected: $($r | ConvertTo-Json -Compress -Depth 4)" }
    if (-not $r.machineId) { throw 's1 binding lost (expected machineId to survive)' }
    return $r
  }
  Check 's2 STILL connected after s1 disconnect' {
    $r = & $getJson '/dsh-remote/status?sessionId=e2e-s2'
    if ($r.connected -ne $true) { throw "s2 was affected by s1 disconnect: $($r | ConvertTo-Json -Compress -Depth 4)" }
    return $r
  }

  # ── fresh session: no inheritance ─────────────────────────────────────────
  Write-Host ''
  Check 'fresh e2e-fresh: unbound, no machine, not connected, sessionMode local' {
    $r = & $getJson '/dsh-remote/status?sessionId=e2e-fresh'
    if ($r.connected -ne $false) { throw "fresh session unexpectedly connected: $($r | ConvertTo-Json -Compress -Depth 4)" }
    if ($r.machineId) { throw "fresh session inherited a machine: $($r.machineId)" }
    if ($r.sessionMode -cne 'local') { throw "fresh sessionMode expected 'local', got '$($r.sessionMode)'" }
    if ("$($r.sessionRemotePath)" -ne '') { throw "fresh sessionRemotePath expected empty, got '$($r.sessionRemotePath)'" }
    return $r
  }

  # all assertions executed (individual failures are recorded in $script:failures)
  $exitCode = 0
}
finally {
  if ($proc -and -not $proc.HasExited) {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch {}
    try { $proc.WaitForExit(5000) | Out-Null } catch {}
  }
  if ($prevHome) { $env:DSH_HOME = $prevHome } else { Remove-Item Env:\DSH_HOME -ErrorAction SilentlyContinue }
  if (Test-Path $root) {
    # remove junction links first (link-only), then the rest
    $jlinks = @(Get-Junctions -Root $root)
    foreach ($jl in $jlinks) {
      try { Remove-Item -LiteralPath $jl.Path -Force -ErrorAction Stop } catch {}
    }
    try { Remove-Item $root -Recurse -Force -ErrorAction Stop } catch {
      Write-Host "e2e: WARNING - could not fully clean $root : $($_.Exception.Message)"
    }
  }
}

Write-Host ''
if ($script:failures.Count -eq 0 -and $exitCode -eq 0) {
  Write-Host 'e2e: PASS - multi-session per-context E2E complete (sandbox stopped + cleaned)'
  exit 0
}
if ($script:failures.Count -gt 0) {
  Write-Host "e2e: FAIL - $($script:failures.Count) assertion(s) failed:"
  foreach ($f in $script:failures) { Write-Host "  - $f" }
  exit 1
}
exit 1
