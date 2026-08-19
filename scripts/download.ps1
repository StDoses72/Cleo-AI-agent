[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Version = "latest",
    [string]$InstallRoot,
    [string]$PackagePath,
    [string]$Sha256,
    [int]$WaitForProcessId,
    [switch]$RemovePackage,
    [switch]$Launch,
    [switch]$NoPause
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "The Cleo desktop downloader currently supports Windows only."
}
if (-not $InstallRoot) {
    $InstallRoot = Join-Path $env:LOCALAPPDATA "Programs\Cleo"
}
$InstallRoot = [System.IO.Path]::GetFullPath(
    [Environment]::ExpandEnvironmentVariables($InstallRoot)
).TrimEnd("\")
$installParent = Split-Path -Parent $InstallRoot
$installName = Split-Path -Leaf $InstallRoot
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    "cleo-download-" + [guid]::NewGuid().ToString("N")
)
$downloadedArchive = Join-Path $temporaryRoot "Cleo-windows-x64.zip"
$downloadedChecksum = Join-Path $temporaryRoot "Cleo-windows-x64.sha256"
$extractRoot = Join-Path $temporaryRoot "extract"
$backupRoot = Join-Path $installParent (".cleo-backup-" + [guid]::NewGuid().ToString("N"))

function Invoke-VerifiedDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Destination,
        [switch]$Resume
    )

    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $curl) {
        throw "curl.exe is required to download Cleo on Windows."
    }
    $arguments = @(
        "--fail",
        "--location",
        "--retry", "5",
        "--retry-all-errors",
        "--retry-delay", "2",
        "--connect-timeout", "20",
        "--progress-bar"
    )
    if ($Resume) {
        $arguments += @("--continue-at", "-")
    }
    $arguments += @("--output", $Destination, $Uri)
    & $curl.Source @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to download $Uri (curl exit code $LASTEXITCODE)."
    }
}

function Wait-ForClose {
    if ($NoPause -or -not [Environment]::UserInteractive) {
        return
    }
    Write-Host ""
    Write-Host "Press Enter to close this window"
    try {
        [void](Read-Host)
    } catch {
        # Some redirected hosts do not expose an interactive input stream.
    }
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [System.BitConverter]::ToString(
            $algorithm.ComputeHash($stream)
        ).Replace("-", "")
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Assert-SafeInstallRoot {
    param([string]$Path)

    $pathRoot = [System.IO.Path]::GetPathRoot($Path).TrimEnd("\")
    $userProfile = [Environment]::GetFolderPath("UserProfile").TrimEnd("\")
    $localAppData = [Environment]::GetFolderPath("LocalApplicationData").TrimEnd("\")
    if (
        $Path -eq $pathRoot -or
        $Path.Equals($userProfile, [System.StringComparison]::OrdinalIgnoreCase) -or
        $Path.Equals($localAppData, [System.StringComparison]::OrdinalIgnoreCase)
    ) {
        throw "Refusing unsafe install root: $Path"
    }
}

Assert-SafeInstallRoot -Path $InstallRoot
$requestedWhatIf = [bool]$WhatIfPreference
# Verification happens in an owned temporary directory even for -WhatIf. The
# installation decision below still honors the caller's original preference.
$WhatIfPreference = $false
New-Item -ItemType Directory -Path $temporaryRoot, $extractRoot -Force | Out-Null

try {
    if ($PackagePath) {
        $resolvedPackage = (Resolve-Path -LiteralPath $PackagePath).Path
        if ($RemovePackage) {
            Move-Item -LiteralPath $resolvedPackage -Destination $downloadedArchive
        } else {
            Copy-Item -LiteralPath $resolvedPackage -Destination $downloadedArchive
        }
        if (-not $Sha256) {
            $localChecksum = [System.IO.Path]::ChangeExtension($resolvedPackage, "sha256")
            if (Test-Path -LiteralPath $localChecksum) {
                $Sha256 = ((Get-Content -LiteralPath $localChecksum -Raw).Trim() -split "\s+")[0]
            }
        }
    } else {
        $releaseBase = if ($Version -eq "latest") {
            "https://github.com/StDoses72/Cleo-AI-agent/releases/latest/download"
        } else {
            "https://github.com/StDoses72/Cleo-AI-agent/releases/download/$Version"
        }
        $archiveUrl = "$releaseBase/Cleo-windows-x64.zip"
        $checksumUrl = "$releaseBase/Cleo-windows-x64.sha256"
        Write-Host "Reading release checksum from $checksumUrl"
        Invoke-VerifiedDownload -Uri $checksumUrl -Destination $downloadedChecksum
        $Sha256 = (((Get-Content -LiteralPath $downloadedChecksum -Raw).Trim()) -split "\s+")[0]
        Write-Host "Downloading $archiveUrl"
        Invoke-VerifiedDownload -Uri $archiveUrl -Destination $downloadedArchive -Resume
    }

    if (-not $Sha256 -or $Sha256 -notmatch "^[a-fA-F0-9]{64}$") {
        throw "A valid SHA256 checksum is required before installing Cleo."
    }
    $actualHash = Get-Sha256 -Path $downloadedArchive
    if (-not $actualHash.Equals($Sha256, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Cleo package checksum mismatch. Expected $Sha256, got $actualHash."
    }

    $tar = Join-Path $env:SystemRoot "System32\tar.exe"
    & $tar -x -f $downloadedArchive -C $extractRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to extract the verified Cleo package."
    }
    $packageRoot = Join-Path $extractRoot "Cleo"
    if (-not (Test-Path -LiteralPath (Join-Path $packageRoot "Cleo.exe"))) {
        throw "The downloaded archive does not contain Cleo\Cleo.exe."
    }
    $packageMetadataPath = Join-Path $packageRoot "release.json"
    if (-not (Test-Path -LiteralPath $packageMetadataPath)) {
        throw "The downloaded archive does not contain Cleo\release.json."
    }
    try {
        $packageMetadata = Get-Content -LiteralPath $packageMetadataPath -Raw | ConvertFrom-Json
    } catch {
        throw "The downloaded archive contains invalid release metadata."
    }
    $installedVersion = [string]$packageMetadata.version
    if (
        $packageMetadata.app -ne "Cleo" -or
        $packageMetadata.platform -ne "windows-x64" -or
        -not $installedVersion
    ) {
        throw "The downloaded archive contains unexpected release metadata."
    }
    if ($Version -ne "latest" -and (($Version -replace '^v', '') -ne $installedVersion)) {
        throw "Requested Cleo $Version, but the package contains version $installedVersion."
    }

    $WhatIfPreference = $requestedWhatIf
    if (-not $PSCmdlet.ShouldProcess($InstallRoot, "Install verified Cleo desktop package")) {
        Write-Host "Verified package: $downloadedArchive"
        Write-Host "Install root:     $InstallRoot"
        return
    }
    $WhatIfPreference = $false

    if (
        (Test-Path -LiteralPath $InstallRoot) -and
        -not (Test-Path -LiteralPath (Join-Path $InstallRoot "Cleo.exe"))
    ) {
        throw "Refusing to replace a directory that is not a Cleo installation: $InstallRoot"
    }

    if ($WaitForProcessId -gt 0) {
        try {
            Wait-Process -Id $WaitForProcessId -Timeout 120 -ErrorAction Stop
        } catch {
            if (Get-Process -Id $WaitForProcessId -ErrorAction SilentlyContinue) {
                throw "Cleo did not close in time; the update was not installed."
            }
        }
    }

    $runningProcesses = Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith(
            $InstallRoot + "\",
            [System.StringComparison]::OrdinalIgnoreCase
        )
    }
    if ($runningProcesses -and $WaitForProcessId -gt 0) {
        throw "Cleo is still running; the update was not installed."
    }
    $runningProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

    New-Item -ItemType Directory -Path $installParent -Force | Out-Null
    if (Test-Path -LiteralPath $InstallRoot) {
        Move-Item -LiteralPath $InstallRoot -Destination $backupRoot
    }
    try {
        Move-Item -LiteralPath $packageRoot -Destination $InstallRoot
        if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot "Cleo.exe"))) {
            throw "Cleo.exe is missing after package promotion."
        }
        @{
            schema_version = 1
            app = "Cleo"
            version = $installedVersion
            installed_at = [DateTimeOffset]::UtcNow.ToString("o")
            sha256 = $actualHash.ToLowerInvariant()
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallRoot "install.json") -Encoding UTF8
        if (Test-Path -LiteralPath $backupRoot) {
            Remove-Item -LiteralPath $backupRoot -Recurse -Force
        }
    } catch {
        if (Test-Path -LiteralPath $InstallRoot) {
            Remove-Item -LiteralPath $InstallRoot -Recurse -Force
        }
        if (Test-Path -LiteralPath $backupRoot) {
            Move-Item -LiteralPath $backupRoot -Destination $InstallRoot
        }
        throw
    }

    $installedExecutable = Join-Path $InstallRoot "Cleo.exe"
    Write-Host ""
    Write-Host "Cleo download and installation complete." -ForegroundColor Green
    Write-Host "Version: $installedVersion"
    Write-Host "Program: $installedExecutable"
    Write-Host "Data:    $env:LOCALAPPDATA\Cleo"
    if ($Launch) {
        Start-Process -FilePath $installedExecutable -WorkingDirectory $InstallRoot
    }
} catch {
    $failure = $_
    $waitingProcessStillRuns = $WaitForProcessId -gt 0 -and (
        Get-Process -Id $WaitForProcessId -ErrorAction SilentlyContinue
    )
    $fallbackExecutable = Join-Path $InstallRoot "Cleo.exe"
    if ($Launch -and -not $waitingProcessStillRuns -and (Test-Path -LiteralPath $fallbackExecutable)) {
        Start-Process -FilePath $fallbackExecutable -WorkingDirectory $InstallRoot
    }
    throw $failure
} finally {
    $WhatIfPreference = $false
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    $WhatIfPreference = $requestedWhatIf
    Wait-ForClose
}
