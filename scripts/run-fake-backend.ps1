param(
  [int]$Port = 8021,
  [string]$Scenario = "nominal_ascent"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BackendRoot = Join-Path $ProjectRoot "backend"
. (Join-Path $PSScriptRoot "python-env.ps1")
$Python = Resolve-KmdPython -ProjectRoot $ProjectRoot
$env:PYTHONNOUSERSITE = "1"
$env:PYTHONPATH = "$BackendRoot\.deps;$BackendRoot"
$env:KMD_FAKE_SCENARIO = $Scenario

Write-Host "Starting KMD fake backend on http://127.0.0.1:$Port ($Scenario)"
& $Python -m uvicorn kmd.fake_server:app --host 127.0.0.1 --port $Port
