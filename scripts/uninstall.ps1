[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$InstallRoot,
    [switch]$PurgeData
)

$ErrorActionPreference = "Stop"

if (-not $InstallRoot) {
    $InstallRoot = Join-Path $env:LOCALAPPDATA "Programs\Cleo"
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\")
$dataRoot = Join-Path $env:APPDATA "Cleo"
$pathRoot = [System.IO.Path]::GetPathRoot($InstallRoot).TrimEnd("\")
$userProfile = [Environment]::GetFolderPath("UserProfile").TrimEnd("\")
if ($InstallRoot -eq $pathRoot -or $InstallRoot -eq $userProfile) {
    throw "Refusing unsafe uninstall root: $InstallRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot "install.json"))) {
    throw "Refusing to remove an unmarked Cleo installation: $InstallRoot"
}

if ($PSCmdlet.ShouldProcess($InstallRoot, "Uninstall Cleo desktop application")) {
    Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith(
            $InstallRoot + "\",
            [System.StringComparison]::OrdinalIgnoreCase
        )
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force
    Write-Host "Removed Cleo program files: $InstallRoot"
}

if ($PurgeData -and (Test-Path -LiteralPath $dataRoot)) {
    if ($PSCmdlet.ShouldProcess($dataRoot, "Permanently remove Cleo configuration, sessions, and memory")) {
        Remove-Item -LiteralPath $dataRoot -Recurse -Force
        Write-Host "Removed Cleo user data: $dataRoot"
    }
} elseif (Test-Path -LiteralPath $dataRoot) {
    Write-Host "Preserved Cleo user data: $dataRoot"
}
