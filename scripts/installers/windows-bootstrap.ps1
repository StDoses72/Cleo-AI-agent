param([Parameter(Mandatory=$true)][string]$Stage, [string]$SourceDirectory)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$Stage = [IO.Path]::GetFullPath($Stage)
$temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $Stage.StartsWith($temporary, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($Stage) -ne 'Cleo') { throw 'Invalid installer staging path.' }
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'bootstrap.json') -Raw | ConvertFrom-Json
function Hash([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose() }
    } finally { $algorithm.Dispose() }
}
$archive = Join-Path $PSScriptRoot 'program.zip'
$nearby = Join-Path $SourceDirectory $manifest.archive
if (Test-Path -LiteralPath $nearby -PathType Leaf) { Copy-Item -LiteralPath $nearby -Destination $archive -Force }
if (-not (Test-Path -LiteralPath $archive) -or (Hash $archive) -ne $manifest.sha256) {
    Invoke-WebRequest -UseBasicParsing -Uri $manifest.url -OutFile $archive -TimeoutSec 900
}
if ((Hash $archive) -ne $manifest.sha256) { throw 'Program download failed its SHA-256 check.' }
if (Test-Path -LiteralPath $Stage) {
    if ((Get-Item -LiteralPath $Stage).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked staging path.' }
    Remove-Item -LiteralPath $Stage -Recurse -Force
}
& "$env:SystemRoot\System32\tar.exe" -xf $archive -C (Split-Path -Parent $Stage)
if ($LASTEXITCODE -ne 0) { throw 'Cannot extract the program package.' }
$previous = $env:ELECTRON_RUN_AS_NODE
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $script = Join-Path $Stage 'resources/online-runtime.mjs'
    $errors = Join-Path $PSScriptRoot 'runtime-error.log'
    $process = Start-Process -FilePath (Join-Path $Stage 'Cleo.exe') -ArgumentList @("`"$script`"") -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot 'runtime.log') -RedirectStandardError $errors
    if ($process.ExitCode -ne 0) { throw "Runtime installation failed: $([IO.File]::ReadAllText($errors))" }
} finally { $env:ELECTRON_RUN_AS_NODE = $previous }
