[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$CleoHome,
    [string]$SourceRoot,
    [switch]$RecreateRuntime,
    [switch]$SkipPathUpdate,
    [string]$IndexUrl
)

$ErrorActionPreference = "Stop"

$arguments = @{}
if ($InstallRoot) {
    $arguments.InstallRoot = $InstallRoot
}
if ($CleoHome) {
    $arguments.CleoHome = $CleoHome
}
if ($SourceRoot) {
    $arguments.SourceRoot = $SourceRoot
}
if ($RecreateRuntime) {
    $arguments.RecreateRuntime = $true
}
if ($SkipPathUpdate) {
    $arguments.SkipPathUpdate = $true
}
if ($IndexUrl) {
    $arguments.IndexUrl = $IndexUrl
}

& (Join-Path $PSScriptRoot "install.ps1") @arguments
