[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$InstallRoot,
    [string]$CleoHome,
    [switch]$PurgeData
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "scripts/uninstall.ps1 currently supports Windows only."
}

if (-not $InstallRoot) {
    $InstallRoot = Join-Path $env:LOCALAPPDATA "Programs\Cleo"
}
if (-not $CleoHome) {
    $CleoHome = Join-Path $env:LOCALAPPDATA "Cleo"
}

$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$CleoHome = [System.IO.Path]::GetFullPath($CleoHome)

function Assert-SafeRemovalPath {
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

Assert-SafeRemovalPath -LiteralPath $InstallRoot -Label "install root"
Assert-SafeRemovalPath -LiteralPath $CleoHome -Label "Cleo home"
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

$installMarker = Join-Path $InstallRoot "install.json"
$homeMarker = Join-Path $CleoHome ".cleo-home.json"
$binRoot = Join-Path $InstallRoot "bin"

if (-not (Test-Path -LiteralPath $installMarker)) {
    throw "Refusing to uninstall an unmarked directory: $InstallRoot"
}
if ($PurgeData -and -not (Test-Path -LiteralPath $homeMarker)) {
    throw "Refusing to purge an unmarked Cleo home: $CleoHome"
}

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

if ($PSCmdlet.ShouldProcess($InstallRoot, "Uninstall Cleo program files")) {
    [Environment]::SetEnvironmentVariable("Path", ($pathEntries -join ";"), "User")
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force
    Write-Host "Removed Cleo program files: $InstallRoot"
}

if ($PurgeData) {
    if ($PSCmdlet.ShouldProcess($CleoHome, "Permanently remove Cleo user data")) {
        Remove-Item -LiteralPath $CleoHome -Recurse -Force
        Write-Host "Removed Cleo user data: $CleoHome"
    }
} else {
    Write-Host "Preserved Cleo user data: $CleoHome"
}

Write-Host "Open a new terminal to refresh PATH."
