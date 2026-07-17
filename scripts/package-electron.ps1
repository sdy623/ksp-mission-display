param(
    [switch]$SkipWebBuild,
    [switch]$SkipBackendBuild,
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "release"))
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempOutput = [System.IO.Path]::GetFullPath((Join-Path $tempBase "kmd-electron-release"))
$builderRoot = [System.IO.Path]::GetFullPath((Join-Path $tempBase "kmdb"))

function Assert-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    $parentWithSeparator = $Parent.TrimEnd('\') + '\'
    if (-not $Candidate.StartsWith($parentWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing filesystem operation outside expected parent: $Candidate"
    }
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "")
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Remove-DirectoryWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$Attempts = 30,
        [int]$DelayMilliseconds = 500
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
            return
        }
        catch {
            if ($attempt -eq $Attempts) {
                throw "Unable to clear generated directory after $Attempts attempts: $Path. $($_.Exception.Message)"
            }
            Start-Sleep -Milliseconds $DelayMilliseconds
        }
    }
}

Assert-ChildPath -Candidate $releaseRoot -Parent $projectRoot
Assert-ChildPath -Candidate $tempOutput -Parent $tempBase
Assert-ChildPath -Candidate $builderRoot -Parent $tempBase

Push-Location $projectRoot
try {
    if (-not $SkipBackendBuild) {
        & npm.cmd run backend:bundle
        if ($LASTEXITCODE -ne 0) {
            throw "Frozen backend build failed with exit code $LASTEXITCODE"
        }
    }

    if (-not $SkipWebBuild) {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) {
            throw "Web build failed with exit code $LASTEXITCODE"
        }
    }

    if (Test-Path -LiteralPath $tempOutput) {
        Remove-DirectoryWithRetry -Path $tempOutput
    }

    # NSIS cannot open very long include paths. Install/reuse the packager from
    # a compact temp path, then point it at the real project with --projectDir.
    $builderCli = Join-Path $builderRoot "node_modules\.bin\electron-builder.cmd"
    if (-not (Test-Path -LiteralPath $builderCli)) {
        New-Item -ItemType Directory -Path $builderRoot -Force | Out-Null
        & npm.cmd install --prefix $builderRoot --no-save --ignore-scripts electron-builder@26.15.3
        if ($LASTEXITCODE -ne 0) {
            throw "Short-path electron-builder installation failed with exit code $LASTEXITCODE"
        }
    }

    & $builderCli "--projectDir=$projectRoot" --win --x64 "--config.directories.output=$tempOutput"
    if ($LASTEXITCODE -ne 0) {
        throw "Electron packaging failed with exit code $LASTEXITCODE"
    }

    $unpackedRoot = Join-Path $tempOutput "win-unpacked"
    $requiredPackagedFiles = @(
        (Join-Path $unpackedRoot "resources\standalone\node_modules\react\package.json"),
        (Join-Path $unpackedRoot "resources\standalone\node_modules\react-dom\package.json"),
        (Join-Path $unpackedRoot "resources\standalone\node_modules\scheduler\package.json"),
        (Join-Path $unpackedRoot "resources\standalone\node_modules\vinext\package.json"),
        (Join-Path $unpackedRoot "resources\backend\kmd-backend.exe")
    )
    foreach ($requiredFile in $requiredPackagedFiles) {
        if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
            throw "Packaged runtime dependency is missing: $requiredFile"
        }
    }

    if (-not $SkipSmokeTest) {
        $smokeExe = Join-Path $unpackedRoot "KSP Mission Display.exe"
        $smokeRoot = Join-Path $tempBase ("kmd-smoke-" + [System.Guid]::NewGuid().ToString("N"))
        $smokeOut = Join-Path $smokeRoot "stdout.log"
        $smokeErr = Join-Path $smokeRoot "stderr.log"
        New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null

        $previousSmokeTest = $env:KMD_SMOKE_TEST
        $previousSmokeUserData = $env:KMD_SMOKE_USER_DATA
        $previousBackendPort = $env:KMD_BACKEND_PORT
        $previousExposeLan = $env:KMD_EXPOSE_LAN
        try {
            $env:KMD_SMOKE_TEST = "1"
            $env:KMD_SMOKE_USER_DATA = Join-Path $smokeRoot "user-data"
            $env:KMD_BACKEND_PORT = "18241"
            $env:KMD_EXPOSE_LAN = "0"
            # Windows PowerShell 5.1 only populates ExitCode reliably when
            # Start-Process itself performs the wait.
            $smokeProcess = Start-Process -FilePath $smokeExe -WorkingDirectory $unpackedRoot `
                -WindowStyle Hidden -RedirectStandardOutput $smokeOut -RedirectStandardError $smokeErr `
                -Wait -PassThru
            $smokeExitCode = $smokeProcess.ExitCode
            if ($smokeExitCode -ne 0) {
                $stdout = if (Test-Path -LiteralPath $smokeOut) { Get-Content -LiteralPath $smokeOut -Raw } else { "" }
                $stderr = if (Test-Path -LiteralPath $smokeErr) { Get-Content -LiteralPath $smokeErr -Raw } else { "" }
                throw "Packaged application smoke test failed with exit code $smokeExitCode.`nSTDOUT:`n$stdout`nSTDERR:`n$stderr"
            }
            Write-Host "Packaged application smoke test passed." -ForegroundColor Green
        }
        finally {
            $env:KMD_SMOKE_TEST = $previousSmokeTest
            $env:KMD_SMOKE_USER_DATA = $previousSmokeUserData
            $env:KMD_BACKEND_PORT = $previousBackendPort
            $env:KMD_EXPOSE_LAN = $previousExposeLan
        }
    }

    if (Test-Path -LiteralPath $releaseRoot) {
        Remove-DirectoryWithRetry -Path $releaseRoot
    }
    New-Item -ItemType Directory -Path $releaseRoot | Out-Null
    Copy-Item -Path (Join-Path $tempOutput "*") -Destination $releaseRoot -Recurse -Force

    Write-Host ""
    Write-Host "Windows packages created:" -ForegroundColor Green
    Get-ChildItem -LiteralPath $releaseRoot -Filter "*.exe" -File |
        Sort-Object Name |
        ForEach-Object {
            $hash = Get-Sha256Hex -Path $_.FullName
            Write-Host ("  {0} ({1:N1} MiB)" -f $_.FullName, ($_.Length / 1MB))
            Write-Host ("    SHA256 {0}" -f $hash)
        }
}
finally {
    Pop-Location
}
