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
$dataRoots = @(
    [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Cleo")),
    [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA "Cleo"))
)
$evolutionRoot = Join-Path $dataRoots[1] "evolution"
$programRoots = @($InstallRoot, (Join-Path $evolutionRoot "builds"), (Join-Path $dataRoots[0] "runtimes"))
$pathRoot = [System.IO.Path]::GetPathRoot($InstallRoot).TrimEnd("\")
$userProfile = [Environment]::GetFolderPath("UserProfile").TrimEnd("\")
if ($InstallRoot -eq $pathRoot -or $InstallRoot -eq $userProfile) {
    throw "Refusing unsafe uninstall root: $InstallRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot "install.json"))) {
    throw "Refusing to remove an unmarked Cleo installation: $InstallRoot"
}

function Assert-UnlinkedRemovalPath {
    param([string]$Path)

    # Refuse relocated storage before traversing or deleting any program/data tree.
    $ancestor = $Path
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "Refusing to uninstall through a link: $ancestor"
            }
        }
        $ancestor = Split-Path -Parent $ancestor
    }
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($Path)
    while ($pending.Count) {
        $item = Get-Item -LiteralPath $pending.Pop() -Force
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw "Refusing to uninstall linked storage: $($item.FullName)"
        }
        if ($item.PSIsContainer) {
            Get-ChildItem -LiteralPath $item.FullName -Force | ForEach-Object { $pending.Push($_.FullName) }
        }
    }
}

$removalPaths = if ($PurgeData) {
    @($InstallRoot) + $dataRoots
} else {
    # Reset generated programs and launch selection, preserving editable source and personal data.
    @((Join-Path $evolutionRoot "state.json"), (Join-Path $evolutionRoot "downloads")) + $programRoots
}
foreach ($removalPath in $removalPaths) {
    $resolved = [System.IO.Path]::GetFullPath($removalPath)
    $owned = $resolved -eq $InstallRoot
    foreach ($dataRoot in $dataRoots) {
        if ($resolved -eq $dataRoot -or $resolved.StartsWith($dataRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
            $owned = $true
        }
    }
    if (-not $owned) { throw "Refusing an unowned uninstall path: $resolved" }
    Assert-UnlinkedRemovalPath $resolved
}
$action = if ($PurgeData) { "Uninstall Cleo and permanently remove its user data" } else { "Uninstall Cleo desktop application" }
if (-not $PSCmdlet.ShouldProcess($InstallRoot, $action)) { return }

Get-CimInstance Win32_Process | ForEach-Object {
    $processInfo = $_
    if ($processInfo.ExecutablePath) {
        foreach ($programRoot in $programRoots) {
            if ($processInfo.ExecutablePath.StartsWith($programRoot + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
                $running = Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue
                if ($running -and $running.Path -eq $processInfo.ExecutablePath) {
                    try { $running | Stop-Process -Force }
                    catch { if (-not $running.HasExited) { throw } }
                    if (-not $running.WaitForExit(10000)) { throw "Cleo process did not stop: $($running.Id)" }
                }
                break
            }
        }
    }
}
foreach ($removalPath in $removalPaths) {
    if (Test-Path -LiteralPath $removalPath) {
        Remove-Item -LiteralPath $removalPath -Recurse -Force
        Write-Host "Removed Cleo files: $removalPath"
    }
}
if (-not $PurgeData) {
    foreach ($dataRoot in $dataRoots) {
        if (Test-Path -LiteralPath $dataRoot) { Write-Host "Preserved Cleo user data: $dataRoot" }
    }
}
