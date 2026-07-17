param(
    [string]$PythonPath,
    [string]$HostAddress = "127.0.0.1",
    [int]$Port = 8021
)

$ErrorActionPreference = "Stop"
$BackendRoot = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $BackendRoot
$ProjectDeps = Join-Path $BackendRoot ".deps"
. (Join-Path $ProjectRoot "scripts\python-env.ps1")

$PythonPath = Resolve-KmdPython -ProjectRoot $ProjectRoot -ExplicitPython $PythonPath

$env:PYTHONNOUSERSITE = "1"
$env:PYTHONPATH = "$ProjectDeps;$BackendRoot"
& $PythonPath -m uvicorn kmd.app:app --host $HostAddress --port $Port
