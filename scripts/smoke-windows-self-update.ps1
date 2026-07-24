[CmdletBinding()]
param(
    [switch]$AutomatedOnly,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$nodeMajor = [int]((& $node -p "process.versions.node.split('.')[0]").Trim())

if ($env:OS -ne 'Windows_NT') {
    throw 'This acceptance harness must run on Windows.'
}

if ($nodeMajor -ne 22) {
    throw "Node 22 is required; found $(& $node --version)."
}

Push-Location $repo
try {
    if (-not $SkipBuild) {
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw 'Production build failed.'
        }
    }

    $tests = @(
        'tests/v4/core/update/installPreflight.test.ts',
        'tests/v4/core/update/executeInstallSafety.test.ts',
        'tests/v4/core/update/windowsUpdateHelper.test.ts',
        'tests/v4/core/update/failureBackoff.test.ts',
        'tests/v4/core/executeInstall.test.ts',
        'tests/v4/cli/update/installProgressIntegration.test.ts',
        'tests/v4/cli/updateBootPrompt.test.ts',
        'tests/v4/cli/ui/progressBar.test.ts'
    )

    & $node '.\node_modules\vitest\vitest.mjs' run @tests
    if ($LASTEXITCODE -ne 0) {
        throw 'Automated updater acceptance failed.'
    }

    Write-Host ''
    Write-Host 'Automated acceptance passed:' -ForegroundColor Green
    Write-Host '  - writable and non-writable prefixes'
    Write-Host '  - cancellation, package-manager failure, and timeout'
    Write-Host '  - external Windows helper success and verification'
    Write-Host '  - composer/status cleanup and timer disposal'
    Write-Host '  - bounded startup failure backoff'

    if ($AutomatedOnly) {
        return
    }

    Write-Host ''
    Write-Host 'Physical Windows Terminal checklist' -ForegroundColor Cyan
    Write-Host 'Use an isolated AIDEN_HOME and a disposable npm prefix.'
    Write-Host 'Do not point this checklist at a shared or system npm installation.'
    Write-Host ''

    $checks = @(
        'Writable user-local prefix: exact target and prefix shown; update prepares, exits, verifies, and reports completion on restart.',
        'Simulated non-writable prefix: installation never starts; actual prefix and manual remediation are shown.',
        'Cancellation: Ctrl+C stops the update path and restores the composer, status strip, draft, and cursor once.',
        'Package-manager failure: sanitized classified failure is shown; normal input remains usable.',
        'Timeout: the npm process tree is stopped; no spinner, timer, or child process remains.',
        'Successful update: helper waits for Aiden to exit, installs the exact target, verifies package.json, and records a sanitized result.',
        'Immediate restart after failure: the blocking startup prompt is suppressed by bounded backoff; /update remains available.',
        'Normal startup after failure: one composer and one status surface render; no duplicate helper or progress row remains.',
        'Restart after success: the reported runtime version equals the exact requested target.'
    )

    foreach ($check in $checks) {
        Write-Host "  [ ] $check"
    }

    Write-Host ''
    Write-Host 'Launch the freshly built CLI with:'
    Write-Host '  node dist\cli\v4\aidenCLI.js'
}
finally {
    Pop-Location
}
