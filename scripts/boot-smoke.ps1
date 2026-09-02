# dsh-remote - Windows boot smoke test (port of scripts/boot-smoke.sh).
#
# Starts an isolated DSH harness instance (bundled node.exe + bin.js + the
# desktop patch) against a throwaway DSH_HOME that carries a copy of the
# product web profile with THIS REPO's source overlaid on the dsh-remote
# plugin. Waits for "dsh web: http" (healthy) or "DSH entry failed" (plugin
# tree load failure), probes the dsh-remote routes, kills the instance, and
# always cleans the temp dirs (finally block).
#
# The product DSH_HOME is NEVER written through: the profile is COPIED first.
# The copy handles the profile's pnpm junction layout explicitly:
#   1. enumerate the source profile's directory junctions (without following
#      them - one junction points at this dev repo, so following it would
#      recurse into the copy being built),
#   2. robocopy /E /XJ the real files (junctions excluded),
#   3. re-create every junction in the copy (targets remapped into the copy
#      where they lived under the product profile),
#   4. replace the copied dsh-remote junction with a REAL directory holding
#      this repo's lib/ + package.json + cordis.patch.yml (the source under
#      test).
#
# Usage:   pwsh -File scripts/boot-smoke.ps1 [-Port N]   (0 = pick a free port)
# Exit:    0 on a healthy boot + 200 probes, 1 otherwise.
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

foreach ($p in @($nodeExe, $binJs, $patchYml, $productWeb, (Join-Path $repo 'lib'))) {
  if (-not (Test-Path $p)) {
    Write-Host "boot-smoke: missing input: $p"
    exit 1
  }
}

# --- junction enumeration: BFS that does NOT follow reparse points.
# (Plain array + head index: .NET generic collections misbehave under this
#  sandbox's PowerShell, so no Stack/Queue objects.)
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

$root     = Join-Path $repo 'dev-harness-smoke'
$homeDir  = Join-Path $root 'harness'
$profileCopy = Join-Path $homeDir 'profiles\web'
$logOut   = Join-Path $root 'boot.out.log'
$logErr   = Join-Path $root 'boot.err.log'

if ($Port -le 0 -or $Port -gt 65535) {
  $Port = Get-UsablePort -Node $nodeExe
  if ($Port -le 0) { Write-Host 'boot-smoke: FAIL - no bindable port found'; exit 1 }
}

$proc = $null
$exitCode = 1

try {
  Write-Host "boot-smoke: isolated DSH_HOME: $homeDir"
  if (Test-Path $root) { Remove-Item $root -Recurse -Force }
  New-Item -ItemType Directory -Path (Join-Path $homeDir 'profiles') | Out-Null

  Write-Host 'boot-smoke: enumerating profile junctions (non-following walk) ...'
  $junctions = @(Get-Junctions -Root $productWeb)
  Write-Host ("boot-smoke: found {0} junctions in the product profile" -f $junctions.Count)

  Write-Host 'boot-smoke: copying real profile files (robocopy /E /XJ, junctions excluded) ...'
  robocopy $productWeb $profileCopy /E /XJ /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) {
    Write-Host ("boot-smoke: FAIL - robocopy error (exit {0})" -f $LASTEXITCODE)
    exit 1
  }

  Write-Host 'boot-smoke: re-creating junctions inside the copy ...'
  $skipJunction = Join-Path $profileCopy 'node_modules\dsh-remote'
  $recreated = 0
  foreach ($j in $junctions) {
    $rel = $j.Path.Substring($productWeb.Length).TrimStart('\')
    $destJ = Join-Path $profileCopy $rel
    if ($destJ -ieq $skipJunction) {
      continue # dsh-remote is materialized from source below
    }
    $t = $j.Target
    if ($null -ne $t -and $t -is [System.Collections.IList] -and $t.Count -gt 0) { $t = $t[0] }
    if ([string]::IsNullOrWhiteSpace($t)) { continue }
    $resolved = $t
    if ($t -match '^[a-zA-Z]:') {
      # absolute target: remap anything under the product profile root into
      # the copy; dev-repo links (other plugins) stay as-is (read-only use)
      if ($t -ieq $productWeb -or $t.StartsWith($productWeb + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        $resolved = Join-Path $profileCopy $t.Substring($productWeb.Length).TrimStart('\')
      }
    } else {
      # relative target: resolve against the destination directory
      $resolved = Join-Path (Split-Path $destJ -Parent) $t
    }
    if (-not (Test-Path $destJ)) {
      New-Item -ItemType Junction -Path $destJ -Target $resolved -ErrorAction SilentlyContinue | Out-Null
      $recreated++
    }
  }
  Write-Host ("boot-smoke: re-created {0} junctions" -f $recreated)

  # materialize the dsh-remote plugin from THIS repo's source (a real dir,
  # never a write-through to the product/profile copy)
  $pluginCopy = Join-Path $profileCopy 'node_modules\dsh-remote'
  if (Test-Path $pluginCopy) { Remove-Item $pluginCopy -Recurse -Force }
  New-Item -ItemType Directory -Path $pluginCopy | Out-Null
  Copy-Item (Join-Path $repo 'lib') (Join-Path $pluginCopy 'lib') -Recurse
  Copy-Item (Join-Path $repo 'package.json') (Join-Path $pluginCopy 'package.json') -Force
  Copy-Item (Join-Path $repo 'cordis.patch.yml') (Join-Path $pluginCopy 'cordis.patch.yml') -Force
  Write-Host 'boot-smoke: dsh-remote source (this repo lib/) overlaid in the isolated profile'

  $prevHome = $env:DSH_HOME
  $env:DSH_HOME = $homeDir

  Write-Host "boot-smoke: starting isolated harness on 127.0.0.1:$Port ..."
  # single quoted argument string: PS 5.1 Start-Process -ArgumentList array
  # drops quoting on paths containing spaces
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
    if ($tail -match 'DSH entry failed') {
      Write-Host 'boot-smoke: FATAL - "DSH entry failed" in harness log'
      break
    }
    if ($tail -match 'dsh web: http') { $ok = 1; break }
    if ($proc.HasExited) {
      if ($tail -match 'EADDRINUSE') {
        Write-Host ("boot-smoke: port {0} already in use - re-run to pick another port" -f $Port)
      } else {
        Write-Host ("boot-smoke: harness process exited early (code {0})" -f $proc.ExitCode)
      }
      break
    }
    if ($i % 10 -eq 0) {
      $lastLine = @($tail -split "`r?`n" | Where-Object { $_ -ne '' } | Select-Object -Last 1)[0]
      Write-Host ("boot-smoke: ...{0}s still starting: {1}" -f $i, $lastLine)
    }
  }

  if (-not $ok) {
    Write-Host ("boot-smoke: FAIL (no healthy ""dsh web: http"" within {0}s). Log tail:" -f $TimeoutSec)
    if (Test-Path $logOut) { Get-Content $logOut -Tail 30 | ForEach-Object { Write-Host "  | $_" } }
    if (Test-Path $logErr) { Get-Content $logErr -Tail 30 | ForEach-Object { Write-Host "  | $_" } }
    $exitCode = 1
  }
  else {
    Write-Host "boot-smoke: harness healthy - probing dsh-remote routes on :$Port ..."
    $exitCode = 0
    $base = "http://127.0.0.1:$Port"
    try {
      $machines = Invoke-RestMethod -Uri "$base/dsh-remote/machines" -Method Get -TimeoutSec 10
      Write-Host ("boot-smoke: GET /dsh-remote/machines -> 200 (list count {0})" -f @($machines.list).Count)
    } catch {
      Write-Host "boot-smoke: FAIL - GET /dsh-remote/machines error: $($_.Exception.Message)"
      $exitCode = 1
    }
    try {
      $status = Invoke-RestMethod -Uri "$base/dsh-remote/status" -Method Get -TimeoutSec 10
      Write-Host ("boot-smoke: GET /dsh-remote/status -> 200 (contextId {0}, connected {1})" -f $status.contextId, $status.connected)
    } catch {
      Write-Host "boot-smoke: FAIL - GET /dsh-remote/status error: $($_.Exception.Message)"
      $exitCode = 1
    }
    if ($exitCode -eq 0) {
      Write-Host 'boot-smoke: PASS - plugin tree loaded, harness served the dsh-remote routes'
    }
  }
}
finally {
  if ($proc -and -not $proc.HasExited) {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch {}
    try { $proc.WaitForExit(5000) | Out-Null } catch {}
  }
  if ($prevHome) { $env:DSH_HOME = $prevHome } else { Remove-Item Env:\DSH_HOME -ErrorAction SilentlyContinue }
  if (Test-Path $root) {
    try { Remove-Item $root -Recurse -Force -ErrorAction Stop } catch {
      Write-Host "boot-smoke: WARNING - could not fully clean $root : $($_.Exception.Message)"
    }
  }
}

if ($exitCode -eq 0) { exit 0 }
exit 1
