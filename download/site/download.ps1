[CmdletBinding()]
param([string]$OutputDirectory = (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads'))

$ErrorActionPreference = 'Stop'

function Get-CleoDownloadTarget {
    if ($env:OS -ne 'Windows_NT') { throw 'Use download.sh on macOS or Linux.' }
    # .NET Framework may report the emulated x64 architecture on ARM Windows.
    $architecture = Get-CimInstance -ClassName Win32_Processor -Property Architecture |
        Select-Object -First 1 -ExpandProperty Architecture
    if (-not [Environment]::Is64BitOperatingSystem -or $architecture -ne 9) {
        throw 'Only Windows x64 is supported; this system uses a different native architecture.'
    }
    return 'windows-x64'
}

function Save-CleoDownload {
    param([Parameter(Mandatory = $true)][string]$OutputDirectory)
    $target = Get-CleoDownloadTarget
    $repository = 'https://github.com/StDoses72/Cleo-AI-agent'
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/StDoses72/Cleo-AI-agent/releases/latest' -TimeoutSec 60
    if ($release.draft -or $release.prerelease -or $release.tag_name -cnotmatch '^v\d+\.\d+\.\d+$') {
        throw 'GitHub did not return a matching stable release.'
    }
    $archive = "Cleo-$target.zip"
    $base = "$repository/releases/download/$($release.tag_name)"
    $output = [IO.Path]::GetFullPath($OutputDirectory)
    [IO.Directory]::CreateDirectory($output) | Out-Null
    $temporary = Join-Path $output ('.cleo-download.' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($temporary) | Out-Null
    try {
        $checksumPath = Join-Path $temporary 'checksum'
        Invoke-WebRequest -UseBasicParsing -Uri "$base/Cleo-$target.sha256" -OutFile $checksumPath -TimeoutSec 60
        $checksum = ([IO.File]::ReadAllText($checksumPath)).Trim().TrimStart([char]0xFEFF)
        if ($checksum -notmatch ('^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($archive) + '$')) {
            throw 'Unexpected checksum metadata.'
        }
        $expected = $Matches[1]
        $destination = Join-Path $output $archive
        if (Test-Path -LiteralPath $destination) {
            if ((Test-Path -LiteralPath $destination -PathType Leaf) -and
                (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -eq $expected) {
                Write-Output "Already verified: $destination"
                return
            }
            throw "A different file already exists at $destination. Choose another output directory."
        }
        Write-Output "Downloading Cleo $($release.tag_name) for $target..."
        $package = Join-Path $temporary 'package'
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$archive" -OutFile $package -TimeoutSec 3600
        if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash -ne $expected) {
            throw 'SHA-256 mismatch; the download was discarded.'
        }
        [IO.File]::Move($package, $destination)
        Write-Output "Verified download: $destination"
    } finally {
        # Only remove the unique temporary child created by this invocation.
        if ([IO.Path]::GetDirectoryName($temporary).TrimEnd('\') -ne $output.TrimEnd('\') -or
            -not ([IO.Path]::GetFileName($temporary)).StartsWith('.cleo-download.')) {
            throw 'Unexpected temporary download path.'
        }
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    }
}

if ($MyInvocation.InvocationName -ne '.') { Save-CleoDownload -OutputDirectory $OutputDirectory }
