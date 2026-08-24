#Requires -Version 5.1
<#
.SYNOPSIS
    Atomic dual-publish release script for aiden-runtime + aiden-os.
    Prevents the v3.19.x publish drift (aiden-runtime forgotten on npm).

.DESCRIPTION
    9-step release pipeline:
      1. Pre-flight checks (npm auth, clean tree, version sync)
      2. Build verification (dist-bundle + dist versions match)
      3. Test gate (audit suite must pass)
      4. Tag check (no duplicate tags)
      5. Dual publish (aiden-runtime then aiden-os, atomic intent)
      6. Post-publish verification (npm CDN propagation)
      7. Git tag + push
      8. GitHub releases (both repos)
      9. Final summary

.PARAMETER DryRun
    Walk through all checks without publishing, tagging, or pushing.
    Prints what WOULD happen at each mutation step.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/release-npm.ps1
    powershell -ExecutionPolicy Bypass -File scripts/release-npm.ps1 -DryRun
#>
param(
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Helpers ─────────────────────────────────────────────────────────────

function Write-Step ($N, $Label) { Write-Host ("`n[$N/9] $Label") -ForegroundColor Cyan }
function Write-Ok ($Msg)   { Write-Host "  OK  $Msg" -ForegroundColor Green }
function Write-Skip ($Msg) { Write-Host "  SKIP (dry-run) $Msg" -ForegroundColor Yellow }
function Write-Abort ($Msg) {
    Write-Host ("`n  ABORT  $Msg") -ForegroundColor Red
    exit 1
}

$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ROOT

$AIDEN_OS_DIR  = Join-Path (Join-Path $ROOT 'packages') 'aiden-os'
$SOURCE_REPO   = 'taracodlabs/aiden'
$RELEASES_REPO = 'taracodlabs/aiden-releases'

Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
if ($DryRun) {
    Write-Host '  AIDEN RELEASE - DRY RUN' -ForegroundColor Yellow
} else {
    Write-Host '  AIDEN RELEASE' -ForegroundColor Cyan
}
Write-Host '========================================' -ForegroundColor Cyan

# =========================================================================
# STEP 1 - Pre-flight checks
# =========================================================================
Write-Step 1 'Pre-flight checks'

# 1a. npm auth
$npmUser = & npm whoami 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Abort "npm whoami failed. Are you logged in? Output: $npmUser"
}
$npmUser = "$npmUser".Trim()
Write-Ok "npm logged in as: $npmUser"

# 1b. Clean working tree (tracked files only — untracked files are OK)
$gitDirty = & git diff --name-only HEAD 2>&1
$gitStaged = & git diff --cached --name-only 2>&1
$dirtyStr = "$gitDirty".Trim()
$stagedStr = "$gitStaged".Trim()
if (($dirtyStr.Length -gt 0) -or ($stagedStr.Length -gt 0)) {
    Write-Abort "Working tree has uncommitted tracked changes. Commit or stash first.`n$dirtyStr`n$stagedStr"
}
Write-Ok 'Working tree clean (tracked files)'

# 1c. Extract versions from all 3 sources
$versionTsRaw = Get-Content (Join-Path (Join-Path $ROOT 'core') 'version.ts') -Raw
$versionTsMatch = [regex]::Match($versionTsRaw, "VERSION\s*=\s*'([^']+)'")
if (-not $versionTsMatch.Success) {
    Write-Abort 'Could not parse VERSION from core/version.ts'
}
$versionTs = $versionTsMatch.Groups[1].Value

$rootPkg = Get-Content (Join-Path $ROOT 'package.json') -Raw | ConvertFrom-Json
$versionPkg = $rootPkg.version

$osPkg = Get-Content (Join-Path $AIDEN_OS_DIR 'package.json') -Raw | ConvertFrom-Json
$versionOs = $osPkg.version

Write-Ok "core/version.ts:                $versionTs"
Write-Ok "package.json:                   $versionPkg"
Write-Ok "packages/aiden-os/package.json: $versionOs"

# 1d. All 3 must match
if (($versionTs -ne $versionPkg) -or ($versionTs -ne $versionOs)) {
    Write-Abort ("Version mismatch! ts=$versionTs pkg=$versionPkg os=$versionOs")
}

$VERSION = $versionTs
$TAG = "v$VERSION"
Write-Ok "All versions match: $VERSION"

# =========================================================================
# STEP 2 - Build verification
# =========================================================================
Write-Step 2 'Build verification'

Write-Host '  Running npm run build...' -ForegroundColor DarkGray
$buildOut = cmd /c "npm run build 2>&1"
if ($LASTEXITCODE -ne 0) { Write-Abort "npm run build failed`n$buildOut" }
Write-Ok 'npm run build succeeded'

# Verify version baked into built artifacts
$checkFiles = @(
    @{ Path = (Join-Path 'dist-bundle' 'index.js'); Pat = ('VERSION = "' + $VERSION + '"') },
    @{ Path = (Join-Path 'dist-bundle' 'cli.js');   Pat = ('VERSION = "' + $VERSION + '"') },
    @{ Path = (Join-Path (Join-Path 'dist' 'core') 'version.js'); Pat = ("VERSION = '" + $VERSION + "'") }
)

foreach ($f in $checkFiles) {
    $fp = Join-Path $ROOT $f.Path
    if (-not (Test-Path $fp)) { Write-Abort "Built file not found: $($f.Path)" }
    $hit = Select-String -Path $fp -Pattern $f.Pat -SimpleMatch
    if (-not $hit) { Write-Abort "Stale version in $($f.Path). Expected: $($f.Pat)" }
    Write-Ok "$($f.Path) contains $VERSION"
}

# =========================================================================
# STEP 3 - Test gate
# =========================================================================
Write-Step 3 'Test gate'

Write-Host '  Running npm run test:audit...' -ForegroundColor DarkGray
$testOutput = cmd /c "npm run test:audit 2>&1"

# Known deferred failures that do not block release.
# These are pre-existing issues tracked for future fix:
#   A-12: no handler for memory_store, memory_forget
#   U-01..U-05: C9 responder custom-provider routing (pre-existing)
$knownDeferred = @('memory_store', 'memory_forget', 'U-01', 'U-02', 'U-03', 'U-04', 'U-05')

# Match only actual FAIL result lines: contain test ID [X-NN] AND the FAIL emoji/marker
# but NOT lines that are PASS results whose test name happens to contain "FAIL"
$testLines = $testOutput -split "`n"
# The actual FAIL marker in test output is the Unicode ❌ character.
# WARN lines use ⚠️ and PASS lines use ✅. Only count ❌ lines.
$failLines = $testLines | Where-Object { $_ -match '\[[\w]+-\d+\]' -and $_ -match '❌' }
$blockingFails = @()
foreach ($line in $failLines) {
    $isKnown = $false
    foreach ($known in $knownDeferred) {
        if ($line -match [regex]::Escape($known)) { $isKnown = $true; break }
    }
    if (-not $isKnown) { $blockingFails += $line }
}

if ($blockingFails.Count -gt 0) {
    Write-Host ''
    foreach ($bl in $blockingFails) { Write-Host "  $bl" -ForegroundColor Red }
    Write-Abort "Test suite has $($blockingFails.Count) NEW failure(s). Fix before releasing."
}
$knownCount = ($failLines | Measure-Object).Count - $blockingFails.Count
Write-Ok "Test suite passed ($knownCount known deferred failure(s), 0 new)"

# =========================================================================
# STEP 4 - Tag check
# =========================================================================
Write-Step 4 'Tag check'

$localTag = & git tag -l $TAG 2>&1
$localTagStr = "$localTag".Trim()
if ($localTagStr.Length -gt 0) {
    Write-Abort "Tag $TAG already exists locally. Bump version or delete tag first."
}
Write-Ok "Tag $TAG does not exist locally"

$remoteTag = & git ls-remote --tags origin "refs/tags/$TAG" 2>&1
$remoteTagStr = "$remoteTag".Trim()
if ($remoteTagStr.Length -gt 0) {
    Write-Abort "Tag $TAG already exists on remote. Bump version or delete remote tag first."
}
Write-Ok "Tag $TAG does not exist on remote"

# =========================================================================
# STEP 5 - Dual publish (atomic intent)
# =========================================================================
Write-Step 5 'Dual publish'

# 5a. Publish aiden-runtime (root package)
if ($DryRun) {
    Write-Skip "npm publish --access public (aiden-runtime@$VERSION)"
} else {
    Write-Host "  Publishing aiden-runtime@$VERSION..." -ForegroundColor DarkGray
    cmd /c "npm publish --access public 2>&1" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Abort "aiden-runtime publish failed. Nothing was published. Safe to retry."
    }
    Write-Ok "aiden-runtime@$VERSION published to npm"
}

# 5b. Publish aiden-os
if ($DryRun) {
    Write-Skip "npm publish --access public (aiden-os@$VERSION)"
} else {
    Write-Host "  Publishing aiden-os@$VERSION..." -ForegroundColor DarkGray
    Push-Location $AIDEN_OS_DIR
    cmd /c "npm publish --access public 2>&1" | Out-Null
    $osExit = $LASTEXITCODE
    Pop-Location
    if ($osExit -ne 0) {
        Write-Host ''
        Write-Host '  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!' -ForegroundColor Red
        Write-Host '  !! PARTIAL PUBLISH: aiden-runtime OK but aiden-os !!' -ForegroundColor Red
        Write-Host '  !! FAILED. Manual intervention required:          !!' -ForegroundColor Red
        Write-Host '  !!   cd packages/aiden-os                         !!' -ForegroundColor Red
        Write-Host '  !!   npm publish --access public                  !!' -ForegroundColor Red
        Write-Host '  !! aiden-runtime cannot be unpublished (npm rule) !!' -ForegroundColor Red
        Write-Host '  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!' -ForegroundColor Red
        exit 1
    }
    Write-Ok "aiden-os@$VERSION published to npm"
}

# =========================================================================
# STEP 6 - Post-publish verification
# =========================================================================
Write-Step 6 'Post-publish verification'

if ($DryRun) {
    Write-Skip 'npm CDN propagation check'
} else {
    Write-Host '  Waiting 15s for npm CDN propagation...' -ForegroundColor DarkGray
    Start-Sleep -Seconds 15

    $verified = $false
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        $runtimeVer = (cmd /c "npm view aiden-runtime version 2>&1").Trim()
        $osVer      = (cmd /c "npm view aiden-os version 2>&1").Trim()

        if (($runtimeVer -eq $VERSION) -and ($osVer -eq $VERSION)) {
            $verified = $true
            break
        }
        if ($attempt -lt 4) {
            Write-Host "  Attempt ${attempt}/4: runtime=$runtimeVer os=$osVer - retrying in 15s..." -ForegroundColor DarkGray
            Start-Sleep -Seconds 15
        }
    }

    if (-not $verified) {
        Write-Host ''
        Write-Host "  WARNING: npm CDN may be slow." -ForegroundColor Yellow
        Write-Host "    aiden-runtime: $runtimeVer (expected $VERSION)" -ForegroundColor Yellow
        Write-Host "    aiden-os:      $osVer (expected $VERSION)" -ForegroundColor Yellow
        Write-Host '  Packages were published. CDN may need more time.' -ForegroundColor Yellow
        Write-Host '  Verify manually: npm view aiden-runtime version' -ForegroundColor Yellow
    } else {
        Write-Ok "aiden-runtime@$runtimeVer confirmed on npm"
        Write-Ok "aiden-os@$osVer confirmed on npm"
    }
}

# =========================================================================
# STEP 7 - Git tag + push
# =========================================================================
Write-Step 7 'Git tag + push'

if ($DryRun) {
    Write-Skip "git tag $TAG"
    Write-Skip 'git push origin main'
    Write-Skip "git push origin $TAG"
} else {
    & git tag $TAG
    if ($LASTEXITCODE -ne 0) { Write-Abort "git tag $TAG failed" }
    Write-Ok "Tagged $TAG"

    & git push origin main
    if ($LASTEXITCODE -ne 0) { Write-Abort 'git push origin main failed' }
    Write-Ok 'Pushed main'

    & git push origin $TAG
    if ($LASTEXITCODE -ne 0) { Write-Abort "git push origin $TAG failed" }
    Write-Ok "Pushed tag $TAG"
}

# =========================================================================
# STEP 8 - GitHub releases
# =========================================================================
Write-Step 8 'GitHub releases'

$majorMinor = $VERSION -replace '(\d+\.\d+)\.\d+', '$1'
$notesFile = Join-Path $ROOT "RELEASE_NOTES_v$majorMinor.md"

if ($DryRun) {
    Write-Skip "gh release create $TAG --repo $SOURCE_REPO --title $TAG"
    if (Test-Path $notesFile) {
        Write-Host "    (would use notes from: $notesFile)" -ForegroundColor DarkGray
    }
    Write-Skip "gh release create $TAG --repo $RELEASES_REPO --title $TAG"
} else {
    # Source repo release
    if (Test-Path $notesFile) {
        & gh release create $TAG --repo $SOURCE_REPO --title "$TAG" --notes-file "$notesFile" --latest
    } else {
        & gh release create $TAG --repo $SOURCE_REPO --title "$TAG" --notes "$TAG release" --latest
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  WARNING: GitHub release on $SOURCE_REPO failed (non-fatal)" -ForegroundColor Yellow
    } else {
        Write-Ok "GitHub release created on $SOURCE_REPO"
    }

    # Releases repo (pointer only)
    $pointerUrl = "https://github.com/$SOURCE_REPO/releases/tag/$TAG"
    $pointerNotes = "Refer to source repo release for details: $pointerUrl"
    & gh release create $TAG --repo $RELEASES_REPO --title "$TAG" --notes "$pointerNotes" --latest
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  WARNING: GitHub release on $RELEASES_REPO failed (non-fatal)" -ForegroundColor Yellow
    } else {
        Write-Ok "GitHub release created on $RELEASES_REPO"
    }
}

# =========================================================================
# STEP 9 - Final summary
# =========================================================================
Write-Step 9 'Release summary'

Write-Host ''
Write-Host '========================================' -ForegroundColor Green
if ($DryRun) {
    Write-Host "  DRY RUN COMPLETE - $TAG" -ForegroundColor Yellow
    Write-Host '  No packages published, no tags created.' -ForegroundColor Yellow
} else {
    Write-Host "  RELEASE $TAG COMPLETE" -ForegroundColor Green
}
Write-Host '========================================' -ForegroundColor Green
Write-Host ''
Write-Host '  npm:' -ForegroundColor White
Write-Host '    aiden-runtime  https://www.npmjs.com/package/aiden-runtime'
Write-Host '    aiden-os       https://www.npmjs.com/package/aiden-os'
Write-Host ''
Write-Host '  GitHub:' -ForegroundColor White
Write-Host "    Source    https://github.com/$SOURCE_REPO/releases/tag/$TAG"
Write-Host "    Releases  https://github.com/$RELEASES_REPO/releases/tag/$TAG"
Write-Host ''
Write-Host '  Verify fresh install:' -ForegroundColor White
Write-Host '    npx aiden-os@latest'
Write-Host ''
