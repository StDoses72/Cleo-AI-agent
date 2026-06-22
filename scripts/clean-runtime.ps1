[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$IncludeToolCaches
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

$requiredPaths = @(
    "pyproject.toml",
    "config/settings.py",
    "memory/AGENT.md"
)

foreach ($requiredPath in $requiredPaths) {
    $candidate = Join-Path $repoRoot $requiredPath
    if (-not (Test-Path -LiteralPath $candidate)) {
        throw "This script must be run from the Cleo repository layout. Missing: $requiredPath"
    }
}

$relativeTargets = @(
    "data/runtime.json",
    "data/shell_audit.log",
    "memory/thread_objects",
    "memory/threads.jsonl",
    "memory/projects"
)

if ($IncludeToolCaches) {
    $relativeTargets += @(
        ".ruff_cache",
        ".pytest_cache",
        ".mypy_cache",
        ".coverage"
    )
}

function Remove-WorkspaceItem {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LiteralPath
    )

    if (-not (Test-Path -LiteralPath $LiteralPath)) {
        return
    }

    $resolved = (Resolve-Path -LiteralPath $LiteralPath).Path
    if (-not $resolved.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to delete outside repository: $resolved"
    }

    if ($PSCmdlet.ShouldProcess($resolved, "Remove runtime artifact")) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
        Write-Host "Deleted $resolved"
    }
}

foreach ($relativeTarget in $relativeTargets) {
    Remove-WorkspaceItem -LiteralPath (Join-Path $repoRoot $relativeTarget)
}

Get-ChildItem -LiteralPath $repoRoot -Recurse -Directory -Force -Filter "__pycache__" |
    ForEach-Object {
        Remove-WorkspaceItem -LiteralPath $_.FullName
    }

Write-Host "Runtime cleanup complete. Local provider config was preserved: config/cleo.json"
