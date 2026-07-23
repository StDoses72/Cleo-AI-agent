[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$IncludeToolCaches
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

$requiredPaths = @(
    "pyproject.toml",
    "cleo/config/settings.py",
    "memory/MEMORY_POLICY.md"
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
    "data/session_artifacts",
    "data/pytest-session-store",
    "data/pytest-session-store-targeted",
    "data/pytest-tmp",
    "memory/non_productivity",
    "memory/productivity",
    "memory/sessions.sqlite3",
    "memory/sessions.sqlite3-shm",
    "memory/sessions.sqlite3-wal"
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

if ($IncludeToolCaches) {
    $sourceRoots = @(
        "cleo",
        "scripts",
        "skills",
        "tests"
    )
    Remove-WorkspaceItem -LiteralPath (Join-Path $repoRoot "__pycache__")
    foreach ($sourceRoot in $sourceRoots) {
        $sourcePath = Join-Path $repoRoot $sourceRoot
        if (-not (Test-Path -LiteralPath $sourcePath)) {
            continue
        }
        Get-ChildItem -LiteralPath $sourcePath -Recurse -Directory -Force `
            -Filter "__pycache__" |
            ForEach-Object {
                Remove-WorkspaceItem -LiteralPath $_.FullName
            }
    }
}

Write-Host "Runtime cleanup complete. Local provider configs were preserved: config/cleo.json, config/harnesses.json"
