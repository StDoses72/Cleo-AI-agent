[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$InstallRoot,
    [string]$CleoHome,
    [string]$SourceRoot,
    [switch]$MigrateCurrentData,
    [switch]$SkipPathUpdate,
    [switch]$RecreateRuntime,
    [string]$IndexUrl
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "scripts/install.ps1 currently supports Windows only."
}

if (-not $InstallRoot) {
    $InstallRoot = Join-Path $env:LOCALAPPDATA "Programs\Cleo"
}
if (-not $CleoHome) {
    $CleoHome = Join-Path $env:LOCALAPPDATA "Cleo"
}
if (-not $SourceRoot) {
    $SourceRoot = Join-Path $PSScriptRoot ".."
}

$InstallRoot = [System.IO.Path]::GetFullPath(
    [Environment]::ExpandEnvironmentVariables($InstallRoot)
)
$CleoHome = [System.IO.Path]::GetFullPath(
    [Environment]::ExpandEnvironmentVariables($CleoHome)
)
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path

function Assert-SafeInstallPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LiteralPath,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $fullPath = [System.IO.Path]::GetFullPath($LiteralPath).TrimEnd("\")
    $pathRoot = [System.IO.Path]::GetPathRoot($fullPath).TrimEnd("\")
    $userProfile = [Environment]::GetFolderPath("UserProfile").TrimEnd("\")
    $localAppData = [Environment]::GetFolderPath("LocalApplicationData").TrimEnd("\")
    if (
        $fullPath -eq $pathRoot -or
        $fullPath -eq $userProfile -or
        $fullPath -eq $localAppData
    ) {
        throw "Refusing unsafe $Label path: $fullPath"
    }
}

Assert-SafeInstallPath -LiteralPath $InstallRoot -Label "install root"
Assert-SafeInstallPath -LiteralPath $CleoHome -Label "Cleo home"
if (
    $InstallRoot.Equals($CleoHome, [System.StringComparison]::OrdinalIgnoreCase) -or
    $InstallRoot.StartsWith(
        $CleoHome.TrimEnd("\") + "\",
        [System.StringComparison]::OrdinalIgnoreCase
    ) -or
    $CleoHome.StartsWith(
        $InstallRoot.TrimEnd("\") + "\",
        [System.StringComparison]::OrdinalIgnoreCase
    )
) {
    throw "Install root and Cleo home must not overlap."
}

$requiredSourcePaths = @(
    "pyproject.toml",
    "main.py",
    "cleo\config\templates\cleo.example.json",
    "cleo\config\templates\harnesses.example.json",
    "cleo\images\assets\cleo-startup.png",
    "memory\MEMORY_POLICY.md"
)
foreach ($relativePath in $requiredSourcePaths) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot $relativePath))) {
        throw "Invalid Cleo source directory. Missing: $relativePath"
    }
}

$runtimeRoot = Join-Path $InstallRoot "runtime"
$runtimePython = Join-Path $runtimeRoot "Scripts\python.exe"
$cleoExecutable = Join-Path $runtimeRoot "Scripts\cleo.exe"
$binRoot = Join-Path $InstallRoot "bin"
$launcherPath = Join-Path $binRoot "cleo.cmd"
$powershellLauncherPath = Join-Path $binRoot "cleo-launch.ps1"
$installMarker = Join-Path $InstallRoot "install.json"
$homeMarker = Join-Path $CleoHome ".cleo-home.json"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    Write-Host "+ $FilePath $($Arguments -join ' ')"
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $FilePath"
    }
}

function New-CleoRuntime {
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        Invoke-Checked -FilePath "uv" -Arguments @(
            "venv",
            "--python",
            "3.12",
            "--seed",
            $runtimeRoot
        )
        return
    }

    if (Get-Command py -ErrorAction SilentlyContinue) {
        & py -3.12 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)"
        if ($LASTEXITCODE -eq 0) {
            Invoke-Checked -FilePath "py" -Arguments @(
                "-3.12",
                "-m",
                "venv",
                $runtimeRoot
            )
            return
        }
    }

    if (Get-Command python -ErrorAction SilentlyContinue) {
        & python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)"
        if ($LASTEXITCODE -eq 0) {
            Invoke-Checked -FilePath "python" -Arguments @(
                "-m",
                "venv",
                $runtimeRoot
            )
            return
        }
    }

    throw "Python 3.12+ or uv is required. Install uv or Python 3.12 and retry."
}

function Copy-FileIfMissing {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    if (Test-Path -LiteralPath $Destination) {
        return
    }
    $destinationParent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination
}

function Copy-TreeMissing {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Source)) {
        return
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $sourcePrefix = [System.IO.Path]::GetFullPath($Source).TrimEnd("\") + "\"
    Get-ChildItem -LiteralPath $Source -Recurse -File -Force | ForEach-Object {
        $relativePath = $_.FullName.Substring($sourcePrefix.Length)
        $targetPath = Join-Path $Destination $relativePath
        if (-not (Test-Path -LiteralPath $targetPath)) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force |
                Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $targetPath
        }
    }
}

if (-not $PSCmdlet.ShouldProcess($InstallRoot, "Install or update Cleo")) {
    Write-Host "Install root: $InstallRoot"
    Write-Host "Cleo home:   $CleoHome"
    Write-Host "Source:      $SourceRoot"
    return
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
New-Item -ItemType Directory -Path $CleoHome -Force | Out-Null
New-Item -ItemType Directory -Path $binRoot -Force | Out-Null

if ($RecreateRuntime -and (Test-Path -LiteralPath $runtimeRoot)) {
    $resolvedRuntime = (Resolve-Path -LiteralPath $runtimeRoot).Path
    if (
        -not $resolvedRuntime.StartsWith(
            $InstallRoot.TrimEnd("\") + "\",
            [System.StringComparison]::OrdinalIgnoreCase
        )
    ) {
        throw "Refusing to recreate runtime outside install root: $resolvedRuntime"
    }
    Remove-Item -LiteralPath $resolvedRuntime -Recurse -Force
}

if (-not (Test-Path -LiteralPath $runtimePython)) {
    New-CleoRuntime
}

& $runtimePython -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)"
if ($LASTEXITCODE -ne 0) {
    throw "The Cleo runtime must use Python 3.12 or newer. Use -RecreateRuntime."
}

$uv = Get-Command uv -ErrorAction SilentlyContinue
if ($uv) {
    $installArguments = @(
        "pip",
        "install",
        "--python",
        $runtimePython,
        "--upgrade"
    )
    if ($IndexUrl) {
        $installArguments += @("--index-url", $IndexUrl)
    }
    $installArguments += $SourceRoot
    Invoke-Checked -FilePath $uv.Source -Arguments $installArguments
} else {
    $pipUpgradeArguments = @(
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--upgrade",
        "pip"
    )
    if ($IndexUrl) {
        $pipUpgradeArguments += @("--index-url", $IndexUrl)
    }
    Invoke-Checked -FilePath $runtimePython -Arguments $pipUpgradeArguments

    $installArguments = @(
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--upgrade"
    )
    if ($IndexUrl) {
        $installArguments += @("--index-url", $IndexUrl)
    }
    $installArguments += $SourceRoot
    Invoke-Checked -FilePath $runtimePython -Arguments $installArguments
}

$layoutDirectories = @(
    "config",
    "assets",
    "data",
    "data\session_artifacts",
    "memory",
    "memory\non_productivity\projects",
    "memory\productivity\projects",
    "skills",
    "workspace"
)
foreach ($relativePath in $layoutDirectories) {
    New-Item -ItemType Directory -Path (Join-Path $CleoHome $relativePath) -Force |
        Out-Null
}

$sourceConfig = Join-Path $SourceRoot "cleo\config\templates\cleo.example.json"
$sourceHarnesses = Join-Path $SourceRoot "cleo\config\templates\harnesses.example.json"
$sourceStartupImage = Join-Path $SourceRoot "cleo\images\assets\cleo-startup.png"
if ($MigrateCurrentData) {
    $localConfig = Join-Path $SourceRoot "config\cleo.json"
    $localHarnesses = Join-Path $SourceRoot "config\harnesses.json"
    if (Test-Path -LiteralPath $localConfig) {
        $sourceConfig = $localConfig
    }
    if (Test-Path -LiteralPath $localHarnesses) {
        $sourceHarnesses = $localHarnesses
    }
}

Copy-FileIfMissing `
    -Source $sourceConfig `
    -Destination (Join-Path $CleoHome "config\cleo.json")
Copy-FileIfMissing `
    -Source $sourceHarnesses `
    -Destination (Join-Path $CleoHome "config\harnesses.json")
Copy-FileIfMissing `
    -Source $sourceStartupImage `
    -Destination (Join-Path $CleoHome "assets\startup.png")
Copy-FileIfMissing `
    -Source (Join-Path $SourceRoot "memory\MEMORY_POLICY.md") `
    -Destination (Join-Path $CleoHome "memory\MEMORY_POLICY.md")
Copy-TreeMissing `
    -Source (Join-Path $SourceRoot "skills") `
    -Destination (Join-Path $CleoHome "skills")

if ($MigrateCurrentData) {
    Write-Host "Migrating missing runtime files. Cleo should not be running during migration."
    foreach ($relativePath in @("data", "memory", "workspace")) {
        Copy-TreeMissing `
            -Source (Join-Path $SourceRoot $relativePath) `
            -Destination (Join-Path $CleoHome $relativePath)
    }
}

$escapedCleoHome = $CleoHome.Replace("'", "''")
$powershellLauncher = @"
`$env:CLEO_HOME = '$escapedCleoHome'
`$env:PYTHONUTF8 = '1'
& (Join-Path `$PSScriptRoot '..\runtime\Scripts\cleo.exe') @args
exit `$LASTEXITCODE
"@
Set-Content -LiteralPath $powershellLauncherPath -Value $powershellLauncher -Encoding UTF8

$launcher = @"
@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0cleo-launch.ps1" %*
exit /b %ERRORLEVEL%
"@
Set-Content -LiteralPath $launcherPath -Value $launcher -Encoding ASCII

$version = (
    & $runtimePython -c "from importlib.metadata import version; print(version('cleo-ai-agent'))"
).Trim()
$installedAt = [DateTimeOffset]::UtcNow.ToString("o")
@{
    schema_version = 1
    app = "cleo"
    version = $version
    installed_at = $installedAt
    source = $SourceRoot
    home = $CleoHome
} | ConvertTo-Json | Set-Content -LiteralPath $installMarker -Encoding UTF8

if (-not (Test-Path -LiteralPath $homeMarker)) {
    @{
        schema_version = 1
        app = "cleo"
        created_at = $installedAt
    } | ConvertTo-Json | Set-Content -LiteralPath $homeMarker -Encoding UTF8
}

if (-not $SkipPathUpdate) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $pathEntries = @(
        ($userPath -split ";") |
            Where-Object { $_ -and $_.Trim() } |
            ForEach-Object { $_.Trim().TrimEnd("\") } |
            Where-Object {
                -not $_.Equals(
                    $binRoot.TrimEnd("\"),
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            }
    )
    $newUserPath = (@($binRoot) + @($pathEntries)) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")

    $processPathEntries = @(
        ($env:Path -split ";") |
            Where-Object { $_ -and $_.Trim() } |
            Where-Object {
                -not $_.Trim().TrimEnd("\").Equals(
                    $binRoot.TrimEnd("\"),
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            }
    )
    $env:Path = (@($binRoot) + @($processPathEntries)) -join ";"
}

Invoke-Checked -FilePath $cleoExecutable -Arguments @("--help")

Write-Host ""
Write-Host "Cleo $version installed successfully." -ForegroundColor Green
Write-Host "Program: $InstallRoot"
Write-Host "Data:    $CleoHome"
Write-Host "Portrait: $(Join-Path $CleoHome 'assets\startup.png')"
Write-Host "Run:     cleo"
if (-not $SkipPathUpdate) {
    Write-Host "Open a new terminal if the cleo command is not visible in existing shells."
}
