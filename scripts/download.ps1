[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Version = "latest",
    [string]$InstallRoot,
    [string]$PackagePath,
    [string]$Sha256,
    [switch]$Launch
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
        Copy-Item -LiteralPath $resolvedPackage -Destination $downloadedArchive
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
        Write-Host "Downloading $archiveUrl"
        Invoke-WebRequest -UseBasicParsing -Uri $archiveUrl -OutFile $downloadedArchive
        Invoke-WebRequest -UseBasicParsing -Uri $checksumUrl -OutFile $downloadedChecksum
        $Sha256 = (((Get-Content -LiteralPath $downloadedChecksum -Raw).Trim()) -split "\s+")[0]
    }

    if (-not $Sha256 -or $Sha256 -notmatch "^[a-fA-F0-9]{64}$") {
        throw "A valid SHA256 checksum is required before installing Cleo."
    }
    $actualHash = (Get-FileHash -LiteralPath $downloadedArchive -Algorithm SHA256).Hash
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

    $runningProcesses = Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith(
            $InstallRoot + "\",
            [System.StringComparison]::OrdinalIgnoreCase
        )
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
            version = $Version
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
    Write-Host "Cleo installed from a verified prebuilt package." -ForegroundColor Green
    Write-Host "Program: $installedExecutable"
    Write-Host "Data:    $env:APPDATA\Cleo"
    if ($Launch) {
        Start-Process -FilePath $installedExecutable -WorkingDirectory $InstallRoot
    }
} finally {
    $WhatIfPreference = $false
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    $WhatIfPreference = $requestedWhatIf
}
