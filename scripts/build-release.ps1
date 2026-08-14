[CmdletBinding()]
param(
    [string]$PythonVersion = "3.12",
    [string]$AgentBrowserVersion = "0.33.1",
    [string]$ElectronMirror = "https://registry.npmmirror.com/-/binary/electron",
    [string]$PythonIndex = "https://mirrors.aliyun.com/pypi/simple/"
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "The Cleo desktop release builder currently supports Windows only."
}

$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$uiRoot = Join-Path $sourceRoot "ui"
$releaseRoot = Join-Path $sourceRoot "release"
$scratchParent = Join-Path $sourceRoot ".release-build"
$scratchRoot = Join-Path $scratchParent ([guid]::NewGuid().ToString("N"))
$freshUiRoot = Join-Path $scratchRoot "ui"
$pythonSourceRoot = Join-Path $scratchRoot "python-source"
$pythonInstallRoot = Join-Path $scratchRoot "python-install"
$npmCache = Join-Path $scratchRoot "npm-cache"
$browserRoot = Join-Path $scratchRoot "browser"
$appBuildPath = Join-Path $scratchRoot "Cleo"
$resourcesPath = Join-Path $appBuildPath "resources"
$stagePath = Join-Path $scratchRoot "app-staging"
$finalAppPath = Join-Path $releaseRoot "Cleo"
$archivePath = Join-Path $releaseRoot "Cleo-windows-x64.zip"
$checksumPath = Join-Path $releaseRoot "Cleo-windows-x64.sha256"
$manifestPath = Join-Path $releaseRoot "release.json"
$electronVersion = (
    (Get-Content -LiteralPath (Join-Path $uiRoot "package.json") -Raw | ConvertFrom-Json).
        devDependencies.electron
).TrimStart("^", "~")

function Assert-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
    $fullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd("\") + "\"
    if (-not $fullPath.StartsWith($fullParent, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify path outside the owned build directory: $fullPath"
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    Write-Host "+ $FilePath $($Arguments -join ' ')" -ForegroundColor DarkGray
    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code $LASTEXITCODE`: $FilePath"
        }
    } finally {
        Pop-Location
    }
}

function Copy-RequiredItem {
    param([string]$RelativePath, [string]$DestinationRoot)

    $source = Join-Path $uiRoot $RelativePath
    if (-not (Test-Path -LiteralPath $source)) {
        throw "Missing required UI source: $RelativePath"
    }
    Copy-Item -LiteralPath $source -Destination $DestinationRoot -Recurse
}

function Get-LockedRequirementVersion {
    param([Parameter(Mandatory = $true)][string]$PackageName)

    $pattern = "^$([regex]::Escape($PackageName))==([^;\s]+)"
    foreach ($line in Get-Content -LiteralPath (Join-Path $sourceRoot "requirements.txt")) {
        $match = [regex]::Match($line.Trim(), $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($match.Success) {
            return $match.Groups[1].Value
        }
    }
    throw "requirements.txt does not lock $PackageName."
}

function Download-LockedWindowsWheel {
    param(
        [Parameter(Mandatory = $true)][string]$PackageName,
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$DestinationRoot,
        [string]$WheelTag = "py3-none"
    )

    $indexUrl = "$($PythonIndex.TrimEnd('/'))/$PackageName/"
    $indexPath = Join-Path $DestinationRoot "$PackageName-index.html"
    Invoke-Checked -FilePath $curl.Source -WorkingDirectory $DestinationRoot -Arguments @(
        "--fail", "--location", "--retry", "3", "--retry-all-errors",
        "--output", $indexPath, $indexUrl
    )
    $wheelPackageName = $PackageName.Replace("-", "_")
    $wheelPattern = 'href="([^"]+/' + [regex]::Escape($wheelPackageName) + '-' +
        [regex]::Escape($Version) + '-' + [regex]::Escape($WheelTag) +
        '-win_amd64\.whl)#sha256=([a-fA-F0-9]{64})"'
    $wheelMatch = [regex]::Match(
        (Get-Content -LiteralPath $indexPath -Raw),
        $wheelPattern,
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    if (-not $wheelMatch.Success) {
        throw "The Python index does not contain a Windows x64 wheel for $PackageName==$Version."
    }
    $wheelUrl = [Uri]::new([Uri]::new($indexUrl), $wheelMatch.Groups[1].Value).AbsoluteUri
    $wheelName = [System.IO.Path]::GetFileName(([Uri]$wheelUrl).LocalPath)
    $wheelPath = Join-Path $DestinationRoot $wheelName
    Invoke-Checked -FilePath $curl.Source -WorkingDirectory $DestinationRoot -Arguments @(
        "--fail", "--location", "--retry", "3", "--retry-all-errors",
        "--output", $wheelPath, $wheelUrl
    )
    $actualHash = (Get-FileHash -LiteralPath $wheelPath -Algorithm SHA256).Hash
    if (-not $actualHash.Equals($wheelMatch.Groups[2].Value, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Python wheel checksum mismatch for $PackageName==$Version."
    }
    return $wheelPath
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
}
$uv = Get-Command uv -ErrorAction SilentlyContinue
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if (-not $npm -or -not $node) {
    throw "Node.js with npm is required to build the Windows release."
}
if (-not $uv) {
    throw "uv is required to download the isolated Python runtime. Install uv and retry."
}
if (-not $curl) {
    throw "curl.exe is required to download and verify the Electron runtime."
}

Assert-ChildPath -Path $scratchParent -Parent $sourceRoot
Assert-ChildPath -Path $finalAppPath -Parent $releaseRoot
Assert-ChildPath -Path $archivePath -Parent $releaseRoot

if (Test-Path -LiteralPath $scratchParent) {
    Remove-Item -LiteralPath $scratchParent -Recurse -Force
}
New-Item -ItemType Directory -Path $freshUiRoot, $pythonSourceRoot, $releaseRoot -Force | Out-Null

try {
    foreach ($relativePath in @(
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "vite.config.ts",
        "index.html",
        "src",
        "public",
        "electron"
    )) {
        Copy-RequiredItem -RelativePath $relativePath -DestinationRoot $freshUiRoot
    }

    $previousElectronSkip = $env:ELECTRON_SKIP_BINARY_DOWNLOAD
    try {
        $env:ELECTRON_SKIP_BINARY_DOWNLOAD = "1"
        Invoke-Checked -FilePath $npm.Source -WorkingDirectory $freshUiRoot -Arguments @(
            "ci",
            "--cache", $npmCache,
            "--prefer-online",
            "--no-audit",
            "--no-fund"
        )
    } finally {
        if ($null -eq $previousElectronSkip) {
            Remove-Item Env:ELECTRON_SKIP_BINARY_DOWNLOAD -ErrorAction SilentlyContinue
        } else {
            $env:ELECTRON_SKIP_BINARY_DOWNLOAD = $previousElectronSkip
        }
    }
    Invoke-Checked -FilePath $npm.Source -WorkingDirectory $freshUiRoot -Arguments @("run", "build")

    $electronArchiveName = "electron-v$electronVersion-win32-x64.zip"
    $electronReleaseBase = "$($ElectronMirror.TrimEnd('/'))/$electronVersion"
    $electronChecksumBase = "https://github.com/electron/electron/releases/download/v$electronVersion"
    $electronArchive = Join-Path $scratchRoot $electronArchiveName
    $electronChecksums = Join-Path $scratchRoot "electron-SHASUMS256.txt"
    Invoke-Checked -FilePath $curl.Source -WorkingDirectory $scratchRoot -Arguments @(
        "--fail", "--location", "--retry", "3", "--retry-all-errors",
        "--output", $electronArchive,
        "$electronReleaseBase/$electronArchiveName"
    )
    try {
        Invoke-Checked -FilePath $curl.Source -WorkingDirectory $scratchRoot -Arguments @(
            "--fail", "--location", "--retry", "3", "--retry-all-errors",
            "--connect-timeout", "10", "--max-time", "30",
            "--output", $electronChecksums,
            "$electronChecksumBase/SHASUMS256.txt"
        )
    } catch {
        Write-Warning "The official Electron checksum endpoint is unavailable; using the mirror checksum manifest."
        Invoke-Checked -FilePath $curl.Source -WorkingDirectory $scratchRoot -Arguments @(
            "--fail", "--location", "--retry", "3", "--retry-all-errors",
            "--output", $electronChecksums,
            "$electronReleaseBase/SHASUMS256.txt"
        )
    }
    $checksumLine = Get-Content -LiteralPath $electronChecksums |
        Where-Object { $_ -match ([regex]::Escape($electronArchiveName) + "$") } |
        Select-Object -First 1
    $expectedElectronHash = if ($checksumLine) { ($checksumLine.Trim() -split "\s+")[0] } else { "" }
    if ($expectedElectronHash -notmatch "^[a-fA-F0-9]{64}$") {
        throw "The Electron checksum manifest does not contain $electronArchiveName."
    }
    $actualElectronHash = (Get-FileHash -LiteralPath $electronArchive -Algorithm SHA256).Hash
    if (-not $actualElectronHash.Equals($expectedElectronHash, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Electron package checksum mismatch."
    }
    $electronDist = Join-Path $freshUiRoot "node_modules\electron\dist"
    New-Item -ItemType Directory -Path $electronDist -Force | Out-Null
    Expand-Archive -LiteralPath $electronArchive -DestinationPath $electronDist

    foreach ($relativePath in @("pyproject.toml", "README.md", "main.py", "LICENSE")) {
        $source = Join-Path $sourceRoot $relativePath
        if (Test-Path -LiteralPath $source) {
            Copy-Item -LiteralPath $source -Destination $pythonSourceRoot
        }
    }
    Copy-Item -LiteralPath (Join-Path $sourceRoot "cleo") -Destination $pythonSourceRoot -Recurse

    Invoke-Checked -FilePath $uv.Source -WorkingDirectory $sourceRoot -Arguments @(
        "python", "install", $PythonVersion,
        "--install-dir", $pythonInstallRoot,
        "--no-bin",
        "--no-registry",
        "--reinstall",
        "--no-cache"
    )
    $runtimePython = Get-ChildItem -LiteralPath $pythonInstallRoot -Recurse -File -Filter "python.exe" |
        Where-Object { $_.DirectoryName -notmatch "[\\/]Scripts$" } |
        Select-Object -First 1
    if (-not $runtimePython) {
        throw "The downloaded Python runtime does not contain python.exe."
    }
    $wheelhouse = Join-Path $scratchRoot "wheelhouse"
    New-Item -ItemType Directory -Path $wheelhouse -Force | Out-Null
    $codexWheel = Download-LockedWindowsWheel -PackageName "openai-codex-cli-bin" `
        -Version (Get-LockedRequirementVersion -PackageName "openai-codex-cli-bin") `
        -DestinationRoot $wheelhouse
    $claudeWheel = Download-LockedWindowsWheel -PackageName "claude-agent-sdk" `
        -Version (Get-LockedRequirementVersion -PackageName "claude-agent-sdk") `
        -DestinationRoot $wheelhouse
    $torchWheel = Download-LockedWindowsWheel -PackageName "torch" `
        -Version (Get-LockedRequirementVersion -PackageName "torch") `
        -DestinationRoot $wheelhouse -WheelTag "cp312-cp312"
    $scipyWheel = Download-LockedWindowsWheel -PackageName "scipy" `
        -Version (Get-LockedRequirementVersion -PackageName "scipy") `
        -DestinationRoot $wheelhouse -WheelTag "cp312-cp312"
    $previousUvConcurrency = $env:UV_CONCURRENT_DOWNLOADS
    $previousUvTimeout = $env:UV_HTTP_TIMEOUT
    try {
        $env:UV_CONCURRENT_DOWNLOADS = "4"
        $env:UV_HTTP_TIMEOUT = "120"
        Invoke-Checked -FilePath $uv.Source -WorkingDirectory $sourceRoot -Arguments @(
            "pip", "install",
            "--python", $runtimePython.FullName,
            "--break-system-packages",
            "--default-index", $PythonIndex,
            "--no-cache",
            "--compile-bytecode",
            $pythonSourceRoot,
            $codexWheel,
            $claudeWheel,
            $torchWheel,
            $scipyWheel
        )
    } finally {
        if ($null -eq $previousUvConcurrency) {
            Remove-Item Env:UV_CONCURRENT_DOWNLOADS -ErrorAction SilentlyContinue
        } else {
            $env:UV_CONCURRENT_DOWNLOADS = $previousUvConcurrency
        }
        if ($null -eq $previousUvTimeout) {
            Remove-Item Env:UV_HTTP_TIMEOUT -ErrorAction SilentlyContinue
        } else {
            $env:UV_HTTP_TIMEOUT = $previousUvTimeout
        }
    }

    New-Item -ItemType Directory -Path $browserRoot | Out-Null
    Invoke-Checked -FilePath $npm.Source -WorkingDirectory $browserRoot -Arguments @(
        "install",
        "--prefix", $browserRoot,
        "--cache", $npmCache,
        "--prefer-online",
        "--no-audit",
        "--no-fund",
        "--omit", "dev",
        "agent-browser@$AgentBrowserVersion"
    )
    Copy-Item -LiteralPath $node.Source -Destination (Join-Path $browserRoot "node.exe")

    New-Item -ItemType Directory -Path $stagePath, $appBuildPath | Out-Null
    Copy-Item -LiteralPath (Join-Path $freshUiRoot "package.json") -Destination $stagePath
    Copy-Item -LiteralPath (Join-Path $freshUiRoot "electron") -Destination $stagePath -Recurse
    Copy-Item -LiteralPath (Join-Path $freshUiRoot "dist") -Destination $stagePath -Recurse
    Copy-Item -Path (Join-Path $freshUiRoot "node_modules\electron\dist\*") -Destination $appBuildPath -Recurse
    Remove-Item -LiteralPath (Join-Path $resourcesPath "default_app.asar") -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath (Join-Path $freshUiRoot "public\cleo.png") -Destination (Join-Path $resourcesPath "cleo.png")
    Copy-Item -LiteralPath $runtimePython.DirectoryName -Destination (Join-Path $resourcesPath "python") -Recurse
    Copy-Item -LiteralPath $browserRoot -Destination (Join-Path $resourcesPath "browser") -Recurse

    $defaultsPath = Join-Path $resourcesPath "defaults"
    New-Item -ItemType Directory -Path (Join-Path $defaultsPath "assets"), (Join-Path $defaultsPath "config"), (Join-Path $defaultsPath "memory") | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot "cleo\images\assets\cleo-startup.png") -Destination (Join-Path $defaultsPath "assets\startup.png")
    Copy-Item -LiteralPath (Join-Path $sourceRoot "cleo\config\templates\cleo.example.json") -Destination (Join-Path $defaultsPath "config\cleo.json")
    Copy-Item -LiteralPath (Join-Path $sourceRoot "cleo\config\templates\harnesses.example.json") -Destination (Join-Path $defaultsPath "config\harnesses.json")
    Copy-Item -LiteralPath (Join-Path $sourceRoot "memory\MEMORY_POLICY.md") -Destination (Join-Path $defaultsPath "memory\MEMORY_POLICY.md")
    Copy-Item -LiteralPath (Join-Path $sourceRoot "AGENTS.md") -Destination (Join-Path $defaultsPath "AGENTS.md")
    Copy-Item -LiteralPath (Join-Path $sourceRoot "PERSONA.md") -Destination (Join-Path $defaultsPath "PERSONA.md")
    if (Test-Path -LiteralPath (Join-Path $sourceRoot "skills")) {
        Copy-Item -LiteralPath (Join-Path $sourceRoot "skills") -Destination $defaultsPath -Recurse
    }

    $asar = Join-Path $freshUiRoot "node_modules\.bin\asar.cmd"
    Invoke-Checked -FilePath $asar -WorkingDirectory $freshUiRoot -Arguments @(
        "pack", $stagePath, (Join-Path $resourcesPath "app.asar")
    )

    $electronExecutable = Join-Path $appBuildPath "electron.exe"
    if (-not (Test-Path -LiteralPath $electronExecutable)) {
        throw "Electron runtime is missing electron.exe."
    }
    Move-Item -LiteralPath $electronExecutable -Destination (Join-Path $appBuildPath "Cleo.exe")

    $version = (Get-Content -LiteralPath (Join-Path $uiRoot "package.json") -Raw | ConvertFrom-Json).version
    $releaseMetadata = [ordered]@{
        schema_version = 1
        app = "Cleo"
        version = $version
        platform = "windows-x64"
        python = $PythonVersion
        agent_browser = $AgentBrowserVersion
        created_at = [DateTimeOffset]::UtcNow.ToString("o")
    }
    $releaseMetadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $appBuildPath "release.json") -Encoding UTF8

    $runningApp = Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith(
            $finalAppPath.TrimEnd("\") + "\",
            [System.StringComparison]::OrdinalIgnoreCase
        )
    }
    if ($runningApp) {
        throw "Close the existing packaged Cleo app before replacing $finalAppPath."
    }
    foreach ($path in @(
        $finalAppPath,
        $archivePath,
        $checksumPath,
        $manifestPath,
        (Join-Path $releaseRoot "app-staging"),
        (Join-Path $releaseRoot "win-unpacked")
    )) {
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Recurse -Force
        }
    }
    Move-Item -LiteralPath $appBuildPath -Destination $finalAppPath
    Invoke-Checked -FilePath "$env:SystemRoot\System32\tar.exe" -WorkingDirectory $releaseRoot -Arguments @(
        "-a", "-c", "-f", $archivePath, "Cleo"
    )
    $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  Cleo-windows-x64.zip" | Set-Content -LiteralPath $checksumPath -Encoding ASCII
    $releaseMetadata.archive = "Cleo-windows-x64.zip"
    $releaseMetadata.sha256 = $hash
    $releaseMetadata.bytes = (Get-Item -LiteralPath $archivePath).Length
    $releaseMetadata | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding UTF8

    Write-Host ""
    Write-Host "Cleo clean release is ready." -ForegroundColor Green
    Write-Host "App:     $(Join-Path $finalAppPath 'Cleo.exe')"
    Write-Host "Archive: $archivePath"
    Write-Host "SHA256:  $hash"
} finally {
    if (Test-Path -LiteralPath $scratchParent) {
        Remove-Item -LiteralPath $scratchParent -Recurse -Force -ErrorAction SilentlyContinue
    }
}
