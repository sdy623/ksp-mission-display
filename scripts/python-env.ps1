function Test-KmdPython311 {
    param([Parameter(Mandatory = $true)][string]$PythonPath)

    if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
        return $false
    }
    $version = & $PythonPath -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
    return $LASTEXITCODE -eq 0 -and $version -eq "3.11"
}

function Resolve-KmdPython {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [string]$ExplicitPython
    )

    if ($ExplicitPython) {
        if (-not (Test-KmdPython311 -PythonPath $ExplicitPython)) {
            throw "Explicit Python must be an existing Python 3.11 interpreter: $ExplicitPython"
        }
        return [System.IO.Path]::GetFullPath($ExplicitPython)
    }

    $projectVenv = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $projectVenv -PathType Leaf) {
        if (-not (Test-KmdPython311 -PythonPath $projectVenv)) {
            throw "Project .venv exists but is not Python 3.11: $projectVenv"
        }
        return [System.IO.Path]::GetFullPath($projectVenv)
    }

    $pathPython = Get-Command python.exe -ErrorAction SilentlyContinue
    $candidates = @(
        $env:KMD_PYTHON,
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "miniconda3\envs\ksp\python.exe" }),
        $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE "AppData\Local\miniconda3\envs\ksp\python.exe" }),
        $(if ($pathPython) { $pathPython.Source })
    ) | Where-Object { $_ } | Select-Object -Unique

    foreach ($candidate in $candidates) {
        if (Test-KmdPython311 -PythonPath $candidate) {
            return [System.IO.Path]::GetFullPath($candidate)
        }
    }

    throw "Python 3.11 was not found. Create .venv or set KMD_PYTHON to python.exe."
}

function Initialize-KmdPip {
    param([Parameter(Mandatory = $true)][string]$PythonPath)

    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $PythonPath -m pip --version *> $null
        $pipAvailable = $LASTEXITCODE -eq 0
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($pipAvailable) {
        return
    }

    Write-Host "Bootstrapping pip in the selected project Python..." -ForegroundColor DarkYellow
    & $PythonPath -m ensurepip --upgrade
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to bootstrap pip in: $PythonPath"
    }
    & $PythonPath -m pip --version *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "pip is still unavailable after ensurepip: $PythonPath"
    }
}

function Test-KmdPythonImports {
    param(
        [Parameter(Mandatory = $true)][string]$PythonPath,
        [Parameter(Mandatory = $true)][string[]]$SearchPaths,
        [Parameter(Mandatory = $true)][string[]]$Modules
    )

    $previousPythonPath = $env:PYTHONPATH
    $previousNoUserSite = $env:PYTHONNOUSERSITE
    $previousErrorAction = $ErrorActionPreference
    try {
        $env:PYTHONPATH = [string]::Join(
            [System.IO.Path]::PathSeparator,
            @($SearchPaths | Where-Object { $_ })
        )
        $env:PYTHONNOUSERSITE = "1"
        $ErrorActionPreference = "Continue"
        & $PythonPath -c "import importlib, sys; [importlib.import_module(name) for name in sys.argv[1:]]" @Modules *> $null
        $importsSucceeded = $LASTEXITCODE -eq 0
        return $importsSucceeded
    }
    finally {
        $env:PYTHONPATH = $previousPythonPath
        $env:PYTHONNOUSERSITE = $previousNoUserSite
        $ErrorActionPreference = $previousErrorAction
    }
}

function Reset-KmdDependencyDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [Parameter(Mandatory = $true)][string]$ProjectRoot
    )

    $resolvedProject = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\') + '\'
    $resolvedTarget = [System.IO.Path]::GetFullPath($TargetPath)
    if (-not $resolvedTarget.StartsWith($resolvedProject, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to reset a Python dependency directory outside the project: $resolvedTarget"
    }

    try {
        if (Test-Path -LiteralPath $resolvedTarget) {
            Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
        }
        New-Item -ItemType Directory -Path $resolvedTarget -Force | Out-Null
    }
    catch {
        throw "Unable to refresh project Python dependencies at $resolvedTarget. Close any running KMD backend and retry. $($_.Exception.Message)"
    }
}
