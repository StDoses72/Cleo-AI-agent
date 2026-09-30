param([Parameter(Mandatory=$true)][string]$Stage, [string]$SourceDirectory, [string]$Progress, [string]$Cancel, [string]$Log)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
# The installer watches this process and reads the exit marker if it can no longer open it.
try { [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'bootstrap.pid'), "$PID") } catch { }
$labels = @{ 'program-download' = 'Downloading Cleo'; 'extract' = 'Extracting Cleo' }
function Write-Log([string]$Text) {
    if (-not $Log) { return }
    try { [IO.File]::AppendAllText($Log, "[$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))] $Text`r`n") } catch { }
}
# Purpose: Publish the shared installer progress JSON. Input: stage id and optional byte counts. Output: none; never fails.
function Set-Stage([string]$Id, $Bytes = $null, $TotalBytes = $null) {
    if (-not $Progress) { return }
    $temporary = "$Progress.$PID.tmp"
    try {
        $json = [ordered]@{ stage = $Id; label = $labels[$Id]; done = $null; total = $null; bytes = $Bytes
            totalBytes = $TotalBytes; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($temporary, $json)
    } catch { return }
    # The installer may be reading the file; retry, and let a later update replace a skipped one.
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try {
            if ([IO.File]::Exists($Progress)) { [IO.File]::Replace($temporary, $Progress, [NullString]::Value) }
            else { [IO.File]::Move($temporary, $Progress) }
            return
        } catch { Start-Sleep -Milliseconds 20 }
    }
    try { [IO.File]::Delete($temporary) } catch { }
}
function Assert-Active { if ($Cancel -and [IO.File]::Exists($Cancel)) { throw 'Installation cancelled.' } }
function Wait-Task($Task, [string]$Failure) {
    $deadline = [DateTime]::UtcNow.AddSeconds(900)
    while ($true) {
        try { if ($Task.Wait(250)) { break } } catch { throw $_.Exception.GetBaseException() }
        Assert-Active
        if ([DateTime]::UtcNow -gt $deadline) { throw $Failure }
    }
    return $Task.Result
}
function Hash([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose() }
    } finally { $algorithm.Dispose() }
}
# Purpose: Stream the program archive with byte progress. Input: URL, destination, manifest size. Output: the file.
function Receive-Program([string]$Url, [string]$Path, $Expected) {
    Add-Type -AssemblyName System.Net.Http
    if ([int][Net.ServicePointManager]::SecurityProtocol -ne 0) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    }
    $partial = "$Path.partial"
    $client = New-Object Net.Http.HttpClient
    # Timeouts are enforced per wait so slow but progressing downloads still complete.
    $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
    $complete = $false
    try {
        Set-Stage 'program-download' ([long]0) $Expected
        $request = $client.GetAsync($Url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead)
        $response = Wait-Task $request 'The program download server did not respond.'
        try {
            if (-not $response.IsSuccessStatusCode) { throw "The program download returned HTTP $([int]$response.StatusCode)." }
            $total = if ($Expected) { [long]$Expected } else { $response.Content.Headers.ContentLength }
            $source = Wait-Task $response.Content.ReadAsStreamAsync() 'The program download did not start.'
            $target = [IO.File]::Create($partial)
            try {
                $buffer = New-Object byte[] 262144
                $received = [long]0
                $reported = [DateTime]::MinValue
                while ($true) {
                    $count = Wait-Task $source.ReadAsync($buffer, 0, $buffer.Length) 'The program download stopped responding.'
                    if ($count -le 0) { break }
                    $target.Write($buffer, 0, $count)
                    $received += $count
                    if ($total -and $received -gt $total) { throw 'The program download is larger than expected.' }
                    if (([DateTime]::UtcNow - $reported).TotalMilliseconds -ge 250) {
                        Set-Stage 'program-download' $received $total
                        $reported = [DateTime]::UtcNow
                    }
                }
                Set-Stage 'program-download' $received $total
            } finally { $target.Dispose(); $source.Dispose() }
        } finally { $response.Dispose() }
        if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
        Move-Item -LiteralPath $partial -Destination $Path
        $complete = $true
    } finally {
        $client.Dispose()
        if (-not $complete) { Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue }
    }
}
function Append-Log([string]$Path) {
    if (-not $Log -or -not (Test-Path -LiteralPath $Path)) { return }
    try { [IO.File]::AppendAllText($Log, [IO.File]::ReadAllText($Path)) } catch { }
}

$succeeded = $false
try {
    Assert-Active
    $Stage = [IO.Path]::GetFullPath($Stage)
    $temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $Stage.StartsWith($temporary, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($Stage) -ne 'Cleo') { throw 'Invalid installer staging path.' }
    $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'bootstrap.json') -Raw | ConvertFrom-Json
    Write-Log "Preparing Cleo from $($manifest.url)"
    $archive = Join-Path $PSScriptRoot 'program.zip'
    $nearby = Join-Path $SourceDirectory $manifest.archive
    if (Test-Path -LiteralPath $nearby -PathType Leaf) {
        Write-Log "Using $nearby"
        Copy-Item -LiteralPath $nearby -Destination $archive -Force
    }
    if (-not (Test-Path -LiteralPath $archive) -or (Hash $archive) -ne $manifest.sha256) {
        Receive-Program $manifest.url $archive $manifest.bytes
    }
    if ((Hash $archive) -ne $manifest.sha256) { throw 'Program download failed its SHA-256 check.' }
    Assert-Active
    Set-Stage 'extract'
    if (Test-Path -LiteralPath $Stage) {
        if ((Get-Item -LiteralPath $Stage).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked staging path.' }
        Remove-Item -LiteralPath $Stage -Recurse -Force
    }
    $errors = Join-Path $PSScriptRoot 'extract-error.log'
    $process = Start-Process -FilePath "$env:SystemRoot\System32\tar.exe" -NoNewWindow -PassThru -RedirectStandardError $errors `
        -ArgumentList @('-xf', "`"$archive`"", '-C', "`"$(Split-Path -Parent $Stage)`"")
    $null = $process.Handle
    while (-not $process.WaitForExit(250)) {
        if ($Cancel -and [IO.File]::Exists($Cancel)) { $process.Kill(); $null = $process.WaitForExit(5000); Assert-Active }
    }
    if ($process.ExitCode -ne 0) { Append-Log $errors; throw 'Cannot extract the program package.' }
    Assert-Active
    $names = 'ELECTRON_RUN_AS_NODE', 'CLEO_INSTALL_PROGRESS', 'CLEO_INSTALL_CANCEL'
    $previous = @{}
    foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name) }
    try {
        $env:ELECTRON_RUN_AS_NODE = '1'
        # online-runtime.mjs continues the same progress file and removes its own staging on cancellation.
        $env:CLEO_INSTALL_PROGRESS = $Progress
        $env:CLEO_INSTALL_CANCEL = $Cancel
        $script = Join-Path $Stage 'resources/online-runtime.mjs'
        $output = Join-Path $PSScriptRoot 'runtime.log'
        $errors = Join-Path $PSScriptRoot 'runtime-error.log'
        Write-Log 'Preparing the Cleo runtime'
        $process = Start-Process -FilePath (Join-Path $Stage 'Cleo.exe') -ArgumentList @("`"$script`"") -WindowStyle Hidden -PassThru -RedirectStandardOutput $output -RedirectStandardError $errors
        $null = $process.Handle
        $process.WaitForExit()
        Append-Log $output
        Append-Log $errors
        Assert-Active
        if ($process.ExitCode -ne 0) { throw "Runtime installation failed: $([IO.File]::ReadAllText($errors))" }
    } finally {
        foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name]) }
    }
    Write-Log 'Cleo is ready to install.'
    $succeeded = $true
} catch {
    Write-Log "Failed: $($_.Exception.Message)"
    throw
} finally {
    try { [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'bootstrap.exit'), $(if ($succeeded) { '0' } else { '1' })) } catch { }
}
