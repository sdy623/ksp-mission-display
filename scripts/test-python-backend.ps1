$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BackendRoot = Join-Path $ProjectRoot "backend"
. (Join-Path $PSScriptRoot "python-env.ps1")
$Python = Resolve-KmdPython -ProjectRoot $ProjectRoot
$env:PYTHONNOUSERSITE = "1"
$env:PYTHONPATH = "$BackendRoot\.deps;$BackendRoot"

$runtimeModules = @("fastapi", "krpc", "numpy", "pydantic", "uvicorn")
if (-not (Test-KmdPythonImports -PythonPath $Python -SearchPaths @("$BackendRoot\.deps") -Modules $runtimeModules)) {
  throw "Project-local Python runtime dependencies are incomplete. Run .\build.ps1 once without -SkipDependencyInstall."
}

Push-Location $BackendRoot
try {
  & $Python -m unittest discover -s tests -v
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
  Pop-Location
}
