$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$backendRoot = Join-Path $projectRoot "backend"
$dependencyRoot = Join-Path $backendRoot ".deps"
$buildDependencyRoot = Join-Path $backendRoot ".build-deps"
$distRoot = Join-Path $backendRoot "dist"
$workRoot = Join-Path $backendRoot "build\pyinstaller"
$specRoot = Join-Path $backendRoot "build"
$entryPoint = Join-Path $backendRoot "kmd_backend.py"
. (Join-Path $PSScriptRoot "python-env.ps1")

$python = Resolve-KmdPython -ProjectRoot $projectRoot
$env:PYTHONNOUSERSITE = "1"

$runtimeModules = @("fastapi", "krpc", "numpy", "pydantic", "uvicorn")
$runtimeReady = Test-KmdPythonImports -PythonPath $python -SearchPaths @($dependencyRoot) -Modules $runtimeModules
$buildReady = Test-KmdPythonImports -PythonPath $python -SearchPaths @($buildDependencyRoot) -Modules @("PyInstaller")
if (-not $runtimeReady -or -not $buildReady) {
    Initialize-KmdPip -PythonPath $python
}
if (-not $runtimeReady) {
    Reset-KmdDependencyDirectory -TargetPath $dependencyRoot -ProjectRoot $projectRoot
    & $python -m pip install --disable-pip-version-check --target $dependencyRoot -r (Join-Path $backendRoot "runtime-requirements.txt")
    if ($LASTEXITCODE -ne 0) {
        throw "Installing backend runtime dependencies failed with exit code $LASTEXITCODE"
    }
}

$pythonBasePrefix = (& $python -c "import sys; print(sys.base_prefix)").Trim()
$condaBinaryRoot = Join-Path $pythonBasePrefix "Library\bin"
$runtimeDllNames = @(
    "libssl-3-x64.dll",
    "libcrypto-3-x64.dll",
    "liblzma.dll",
    "LIBBZ2.dll",
    "libexpat.dll",
    "ffi.dll"
)
$runtimeDlls = foreach ($dllName in $runtimeDllNames) {
    $dllPath = Join-Path $condaBinaryRoot $dllName
    if (Test-Path -LiteralPath $dllPath) {
        $dllPath
    }
}

if (-not $buildReady) {
    Reset-KmdDependencyDirectory -TargetPath $buildDependencyRoot -ProjectRoot $projectRoot
    & $python -m pip install --disable-pip-version-check --target $buildDependencyRoot -r (Join-Path $backendRoot "build-requirements.txt")
    if ($LASTEXITCODE -ne 0) {
        throw "Installing backend build dependencies failed with exit code $LASTEXITCODE"
    }
}

$oldPythonPath = $env:PYTHONPATH
$pythonPathParts = @($buildDependencyRoot, $dependencyRoot, $backendRoot, $oldPythonPath) |
    Where-Object { $_ }
$env:PYTHONPATH = [string]::Join([System.IO.Path]::PathSeparator, $pythonPathParts)

try {
    $pyInstallerArguments = @(
        "--noconfirm",
        "--clean",
        "--onedir",
        "--console",
        "--noupx",
        "--name", "kmd-backend",
        "--distpath", $distRoot,
        "--workpath", $workRoot,
        "--specpath", $specRoot,
        "--paths", $backendRoot,
        "--paths", $dependencyRoot,
        "--copy-metadata", "fastapi",
        "--copy-metadata", "starlette",
        "--copy-metadata", "pydantic",
        "--copy-metadata", "uvicorn",
        "--copy-metadata", "krpc",
        "--collect-submodules", "krpc",
        "--hidden-import", "uvicorn.logging",
        "--hidden-import", "uvicorn.lifespan.on",
        "--hidden-import", "uvicorn.protocols.http.h11_impl",
        "--hidden-import", "uvicorn.protocols.websockets.websockets_impl",
        "--exclude-module", "scipy",
        "--exclude-module", "matplotlib",
        "--exclude-module", "IPython",
        "--exclude-module", "PyQt6",
        "--exclude-module", "tkinter",
        "--exclude-module", "PIL",
        "--exclude-module", "pandas",
        "--exclude-module", "tornado",
        "--exclude-module", "zmq",
        "--exclude-module", "psutil",
        "--exclude-module", "jedi"
    )
    foreach ($dllPath in $runtimeDlls) {
        $pyInstallerArguments += @("--add-binary", "$dllPath;.")
    }
    $pyInstallerArguments += $entryPoint

    & $python -m PyInstaller @pyInstallerArguments

    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller backend build failed with exit code $LASTEXITCODE"
    }
}
finally {
    $env:PYTHONPATH = $oldPythonPath
}

$backendExe = Join-Path $distRoot "kmd-backend\kmd-backend.exe"
if (-not (Test-Path -LiteralPath $backendExe)) {
    throw "Frozen backend executable was not created: $backendExe"
}

Write-Host "Frozen backend created: $backendExe" -ForegroundColor Green
