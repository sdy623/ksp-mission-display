[CmdletBinding()]
param(
    [switch]$SkipDependencyInstall,
    [switch]$SkipTests,
    [switch]$SkipPackaging,
    [switch]$RefreshDependencies
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$BackendRoot = Join-Path $ProjectRoot "backend"
$BackendDependencyRoot = Join-Path $BackendRoot ".deps"
$BackendExe = Join-Path $BackendRoot "dist\kmd-backend\kmd-backend.exe"
$StandaloneServer = Join-Path $ProjectRoot "dist\standalone\server.js"
$ReleaseRoot = Join-Path $ProjectRoot "release"
$PackageJson = Join-Path $ProjectRoot "package.json"
. (Join-Path $ProjectRoot "scripts\python-env.ps1")

function Invoke-BuildStep {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Action
    )

    Write-Host ""
    Write-Host ("==> {0}" -f $Name) -ForegroundColor Cyan
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $global:LASTEXITCODE = 0
    & $Action
    $timer.Stop()
    if ($LASTEXITCODE -ne 0) {
        throw ("{0} failed with exit code {1}" -f $Name, $LASTEXITCODE)
    }
    Write-Host ("    completed in {0:N1}s" -f $timer.Elapsed.TotalSeconds) -ForegroundColor DarkGray
}

function Require-Command {
    param([Parameter(Mandatory = $true)][string]$Name)

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "Required command is not available: $Name"
    }
    return $command
}

function Assert-File {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description was not created: $Path"
    }
}

function Get-GitValue {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $value = & git.exe @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $null
    }
    return ($value | Out-String).Trim()
}

if (-not (Test-Path -LiteralPath $PackageJson -PathType Leaf)) {
    throw "Run this script from a complete KSP Mission Display checkout. Missing: $PackageJson"
}

Require-Command "node.exe" | Out-Null
Require-Command "npm.cmd" | Out-Null
Require-Command "git.exe" | Out-Null
$Python = Resolve-KmdPython -ProjectRoot $ProjectRoot
$env:KMD_PYTHON = $Python
$env:PYTHONNOUSERSITE = "1"

$nodeVersion = (& node.exe --version).Trim().TrimStart("v")
if ($LASTEXITCODE -ne 0) {
    throw "Unable to read the Node.js version."
}
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt 22) {
    throw "Node.js 22 or newer is required; found $nodeVersion."
}

$pythonVersion = (& $Python --version 2>&1 | Out-String).Trim()
$package = Get-Content -LiteralPath $PackageJson -Raw | ConvertFrom-Json
$version = [string]$package.version

Write-Host "KSP Mission Display complete build" -ForegroundColor Green
Write-Host ("  Project : {0}" -f $ProjectRoot)
Write-Host ("  Version : {0}" -f $version)
Write-Host ("  Node    : {0}" -f $nodeVersion)
Write-Host ("  Python  : {0} ({1})" -f $pythonVersion, $Python)

Push-Location $ProjectRoot
try {
    $nodeInstallMarker = Join-Path $ProjectRoot "node_modules\.package-lock.json"
    if (-not $SkipDependencyInstall -and ($RefreshDependencies -or -not (Test-Path -LiteralPath $nodeInstallMarker))) {
        Invoke-BuildStep "Install locked Node dependencies" {
            & npm.cmd ci
        }
    }
    elseif ($SkipDependencyInstall) {
        Write-Host "  Node dependency installation skipped by request." -ForegroundColor DarkYellow
    }
    else {
        Write-Host "  Existing Node dependency installation accepted." -ForegroundColor DarkGray
    }

    $buildDependencyRoot = Join-Path $BackendRoot ".build-deps"
    $runtimeModules = @("fastapi", "krpc", "numpy", "pydantic", "uvicorn")
    $runtimeReady = Test-KmdPythonImports -PythonPath $Python -SearchPaths @($BackendDependencyRoot) -Modules $runtimeModules
    $buildReady = Test-KmdPythonImports -PythonPath $Python -SearchPaths @($buildDependencyRoot) -Modules @("PyInstaller")
    $pythonInstallNeeded = $RefreshDependencies -or -not $runtimeReady -or -not $buildReady
    if (-not $SkipDependencyInstall -and $pythonInstallNeeded) {
        Invoke-BuildStep "Prepare isolated Python dependencies" {
            Initialize-KmdPip -PythonPath $Python
            if ($RefreshDependencies -or -not $runtimeReady) {
                Reset-KmdDependencyDirectory -TargetPath $BackendDependencyRoot -ProjectRoot $ProjectRoot
                & $Python -m pip install --disable-pip-version-check --target $BackendDependencyRoot -r (Join-Path $BackendRoot "runtime-requirements.txt")
                if ($LASTEXITCODE -ne 0) { throw "Installing Python runtime dependencies failed." }
            }
            if ($RefreshDependencies -or -not $buildReady) {
                Reset-KmdDependencyDirectory -TargetPath $buildDependencyRoot -ProjectRoot $ProjectRoot
                & $Python -m pip install --disable-pip-version-check --target $buildDependencyRoot -r (Join-Path $BackendRoot "build-requirements.txt")
            }
        }
    }
    elseif ($SkipDependencyInstall) {
        if (-not $runtimeReady -or -not $buildReady) {
            throw "Python dependencies are incomplete but -SkipDependencyInstall was used. Run .\build.ps1 once without that option."
        }
        Write-Host "  Python dependency installation skipped; project-local layers are complete." -ForegroundColor DarkYellow
    }
    else {
        Write-Host "  Existing Python dependency installation accepted." -ForegroundColor DarkGray
    }

    Invoke-BuildStep "Freeze the Python kRPC backend" {
        & npm.cmd run backend:bundle
    }
    Assert-File -Path $BackendExe -Description "Frozen Python backend"

    if (-not $SkipTests) {
        Invoke-BuildStep "Run static checks" {
            & npm.cmd run lint
        }
        Invoke-BuildStep "Run unit, integration, and Chrome tests" {
            & npm.cmd run test:all
        }
    }
    else {
        Write-Host "  Test suite skipped by request." -ForegroundColor DarkYellow
    }

    Invoke-BuildStep "Build the standalone web application" {
        & npm.cmd run build
    }
    Assert-File -Path $StandaloneServer -Description "Standalone web server"

    if (-not $SkipPackaging) {
        Invoke-BuildStep "Create Windows installer and portable application" {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot "scripts\package-electron.ps1") -SkipWebBuild -SkipBackendBuild
        }

        $executables = @(Get-ChildItem -LiteralPath $ReleaseRoot -Filter "*.exe" -File -ErrorAction SilentlyContinue)
        if ($executables.Count -lt 2) {
            throw "Expected installer and portable executables in $ReleaseRoot."
        }

        $commit = Get-GitValue -Arguments @("rev-parse", "--short=12", "HEAD")
        $status = Get-GitValue -Arguments @("status", "--porcelain")
        $manifest = [ordered]@{
            product = "KSP Mission Display"
            version = $version
            built_at_utc = [DateTime]::UtcNow.ToString("o")
            git_commit = $commit
            git_dirty = -not [string]::IsNullOrWhiteSpace($status)
            node = $nodeVersion
            python = $pythonVersion
            artifacts = @($executables | Sort-Object Name | ForEach-Object {
                [ordered]@{
                    name = $_.Name
                    bytes = $_.Length
                    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
                }
            })
        }
        $manifestPath = Join-Path $ReleaseRoot "build-manifest.json"
        $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

        Write-Host ""
        Write-Host "Release artifacts" -ForegroundColor Green
        foreach ($artifact in $manifest.artifacts) {
            Write-Host ("  {0} ({1:N1} MiB)" -f $artifact.name, ($artifact.bytes / 1MB))
            Write-Host ("    SHA256 {0}" -f $artifact.sha256)
        }
        Write-Host ("  Manifest: {0}" -f $manifestPath)
    }
    else {
        Write-Host "  Electron packaging skipped by request." -ForegroundColor DarkYellow
    }

    Write-Host ""
    Write-Host "Complete build finished successfully." -ForegroundColor Green
}
finally {
    Pop-Location
}
