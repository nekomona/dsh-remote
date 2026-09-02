# dsh-remote - per-file node:test runner (Windows sandbox equivalent of `node --test`).
#
# WHY THIS EXISTS: the DSH desktop Windows file sandbox denies the named-pipe
# spawn that `node --test` uses for its per-file child processes, so a literal
# `node --test` fails with `spawn EPERM` before running any test (verified on
# this machine). Running each test file directly (`node <file>.test.js`)
# executes the identical node:test suite in-process (same TAP output, same
# pass/fail semantics) and is the accepted verification step for this
# environment.
#
# Usage:  pwsh -File scripts/run-tests.ps1             (all test\*.test.js)
#         pwsh -File scripts/run-tests.ps1 contexts    (substring file filter)
# Exit:   0 when every suite passes, 1 otherwise.
#
# ASCII-only on purpose: Windows PowerShell 5.1 (no BOM) would misread any
# non-ASCII literal, so TAP symbols are matched with \uXXXX escapes.

param(
  [string]$Filter = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$files = @(Get-ChildItem (Join-Path $repo 'test') -Filter '*.test.js' -File |
  Where-Object { $Filter -eq '' -or $_.Name -like "*$Filter*" } |
  Sort-Object Name)

if ($files.Count -eq 0) {
  Write-Host "run-tests: no test files matched filter '$Filter'"
  exit 1
}

$total = 0
$passed = 0
$failed = 0
$failedFiles = @()

foreach ($f in $files) {
  Write-Host "=== $($f.Name) ==="
  $out = @(& node $f.FullName 2>&1 | ForEach-Object { [string]$_ })
  $code = $LASTEXITCODE
  $out | Where-Object { $_ -match '^\u2714|^\u2716|^\u2026|^\S+ (tests|suites|pass|fail|cancelled|skipped|todo) \d' } |
    ForEach-Object { Write-Host "  $_" }
  if ($code -ne 0) {
    $out | Where-Object { $_ -match '^\u2716|AssertionError|Error:' } | Select-Object -First 25 |
      ForEach-Object { Write-Host "  | $_" }
  }
  $t = 0; $p = 0; $fl = 0
  foreach ($line in $out) {
    if ($line -match '^\S+ tests (\d+)') { $t = [int]$Matches[1] }
    elseif ($line -match '^\S+ pass (\d+)') { $p = [int]$Matches[1] }
    elseif ($line -match '^\S+ fail (\d+)') { $fl = [int]$Matches[1] }
  }
  $total += $t
  $passed += $p
  $failed += $fl
  if ($code -eq 0 -and $fl -eq 0) {
    Write-Host "  [PASS] $($f.Name): $p/$t tests"
  } else {
    Write-Host "  [FAIL] $($f.Name): $p/$t tests (exit $code)"
    $failedFiles += $f.Name
  }
}

Write-Host ''
Write-Host "run-tests summary: $passed/$total tests passed, $failed failed across $($files.Count) file(s)"
if ($failedFiles.Count -gt 0) {
  Write-Host "failing files: $($failedFiles -join ', ')"
  exit 1
}
Write-Host 'NOTE: literal `node --test` is blocked in this Windows file sandbox (spawn EPERM); the per-file run above is the equivalent verification step.'
exit 0
