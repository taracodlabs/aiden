# tier3-quality.ps1 - LLM judge quality tests for Aiden v3.11
# Calls Aiden, then evaluates each response via Anthropic API directly.
# Reads ANTHROPIC_API_KEY from environment (Claude Code credentials).
# Score >= 3 on each dimension = pass.

[CmdletBinding()]param()

. "$PSScriptRoot\lib\test-helpers.ps1"

Write-Host "`n=== TIER 3: QUALITY TESTS (LLM Judge) ===" -ForegroundColor Magenta

# ---------------------------------------------------------------------------
# LLM Judge setup
# ---------------------------------------------------------------------------
$ANTHROPIC_KEY = $env:ANTHROPIC_API_KEY
if (-not $ANTHROPIC_KEY) {
    Write-Host "  WARNING: ANTHROPIC_API_KEY not set. Attempting to read from Claude config..." -ForegroundColor Yellow
    $candidates = @(
        "$env:USERPROFILE\.anthropic\credentials",
        "$env:USERPROFILE\.config\anthropic\credentials",
        "$env:APPDATA\Claude\credentials.json"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) {
            try {
                $content = Get-Content $c -Raw
                if ($content -match '"api_key"\s*:\s*"(sk-ant-[^"]+)"') {
                    $ANTHROPIC_KEY = $Matches[1]
                    Write-Host "  Found key in $c" -ForegroundColor DarkGray
                    break
                }
            } catch {}
        }
    }
}

if (-not $ANTHROPIC_KEY) {
    $externalToolConfig = "$env:USERPROFILE\.claude\config.json"
    if (Test-Path $externalToolConfig) {
        try {
            $cfg = Get-Content $externalToolConfig -Raw | ConvertFrom-Json
            $ANTHROPIC_KEY = $cfg.anthropic_api_key
            if ($ANTHROPIC_KEY) { Write-Host "  Found key in $externalToolConfig" -ForegroundColor DarkGray }
        } catch { }
    }
}

if (-not $ANTHROPIC_KEY) {
    Write-Host "  Tier 3 SKIPPED: no ANTHROPIC_API_KEY in env or ~/.claude/config.json" -ForegroundColor Yellow
    Write-Host "  To run tier 3, set: `$env:ANTHROPIC_API_KEY = 'sk-ant-...'" -ForegroundColor DarkGray
    return [PSCustomObject]@{ Tier = "tier3"; Passed = 0; Total = 0; Abort = $false; File = $null; Results = @() }
}

$JUDGE_MODEL   = "claude-haiku-4-5"
$JUDGE_PROMPT  = Get-Content "$PSScriptRoot\fixtures\quality-judge-prompt.txt" -Raw -ErrorAction Stop
$PASS_THRESHOLD = 3   # score >= 3 on each dimension = pass
$results = @()

# ---------------------------------------------------------------------------
# Invoke-Judge - calls Anthropic directly, returns score object or $null
# ---------------------------------------------------------------------------
function Invoke-Judge {
    param([string]$Question, [string]$Response)

    $prompt = $JUDGE_PROMPT `
        -replace '\{\{QUESTION\}\}', $Question `
        -replace '\{\{RESPONSE\}\}', $Response

    $judgeBody = @{
        model      = $JUDGE_MODEL
        max_tokens = 256
        messages   = @(@{ role = "user"; content = $prompt })
    } | ConvertTo-Json -Compress -Depth 5

    try {
        $judgeResp = Invoke-WebRequest -Uri "https://api.anthropic.com/v1/messages" `
            -Method POST `
            -Headers @{
                "x-api-key"         = $ANTHROPIC_KEY
                "Content-Type"      = "application/json"
                "anthropic-version" = "2023-06-01"
            } `
            -Body $judgeBody `
            -TimeoutSec 30 `
            -UseBasicParsing -ErrorAction Stop

        $judgeJson = $judgeResp.Content | ConvertFrom-Json
        $judgeText = $judgeJson.content[0].text

        # Extract JSON from response (may have surrounding text)
        if ($judgeText -match '\{[^}]+\}') {
            $jsonBlock = $Matches[0]
            return $jsonBlock | ConvertFrom-Json
        }
        return $null
    } catch {
        Write-Host "  Judge API error: $($_.Exception.Message)" -ForegroundColor DarkRed
        return $null
    }
}

# ---------------------------------------------------------------------------
# Run-QualityTest helper
# ---------------------------------------------------------------------------
function Run-QualityTest {
    param([string]$TestId, [string]$Question)

    Log-TestStart $TestId
    $r = Call-Aiden -Message $Question -TimeoutSec 25

    if ($r.HttpStatus -eq 0 -or $r.Response.Length -eq 0) {
        Log-TestResult $TestId $false "No response from Aiden: $($r.ErrorText)"
        return [PSCustomObject]@{ Test = $TestId; Pass = $false; Reason = "No Aiden response"; Scores = $null; Question = $Question; Response = "" }
    }

    $scores = Invoke-Judge -Question $Question -Response $r.Response

    if (-not $scores) {
        Log-TestResult $TestId $false "Judge returned no score"
        return [PSCustomObject]@{ Test = $TestId; Pass = $false; Reason = "Judge parse failure"; Scores = $null; Question = $Question; Response = $r.Response }
    }

    $dims = @("accuracy","helpfulness","tone","appropriateness")
    $fails = @()
    foreach ($d in $dims) {
        $val = if ($scores.PSObject.Properties[$d]) { [int]$scores.$d } else { 0 }
        if ($val -lt $PASS_THRESHOLD) { $fails += "${d}=${val}" }
    }

    $pass   = $fails.Count -eq 0
    $scoreStr = "acc=$($scores.accuracy) help=$($scores.helpfulness) tone=$($scores.tone) appr=$($scores.appropriateness)"
    $notes  = if ($scores.PSObject.Properties["notes"]) { $scores.notes } else { "" }
    $reason = if ($pass) { "$scoreStr - $notes" } else { "LOW: $($fails -join ', ') :: $scoreStr :: $notes" }

    Log-TestResult $TestId $pass $reason
    return [PSCustomObject]@{
        Test     = $TestId
        Pass     = $pass
        Reason   = $reason
        Scores   = $scores
        Question = $Question
        Response = $r.Response
    }
}

# ---------------------------------------------------------------------------
# 10 Quality test cases
# ---------------------------------------------------------------------------

# Q1 - Prompt caching explanation
$results += Run-QualityTest "Q1-prompt-caching" "Explain what prompt caching is and why it matters for LLM API costs."

# Q2 - Shell one-liner for .ts files
$results += Run-QualityTest "Q2-shell-ts-files" "Give me a shell one-liner to find all .ts files in the current directory recursively, excluding node_modules."

# Q3 - Python syntax error
$results += Run-QualityTest "Q3-python-syntax" "What is wrong with this Python code and how do I fix it? `n`ndef greet(name)`n    print('Hello ' + name)"

# Q4 - Stock market today (should acknowledge uncertainty)
$results += Run-QualityTest "Q4-stock-market" "What is the stock market doing today?"

# Q5 - Meal plan for weight loss (should be practical)
$results += Run-QualityTest "Q5-meal-plan" "Give me a simple 3-day meal plan for gradual weight loss."

# Q6 - Capital of France (factual)
$results += Run-QualityTest "Q6-capital-france" "What is the capital of France?"

# Q7 - REST vs GraphQL
$results += Run-QualityTest "Q7-rest-vs-graphql" "What are the main differences between REST and GraphQL APIs? When should I use each?"

# Q8 - Linked list class
$results += Run-QualityTest "Q8-linked-list" "Write a minimal Python class for a singly linked list with insert and to_list methods."

# Q9 - 100 USD to INR (should acknowledge it can't check live rates)
$results += Run-QualityTest "Q9-currency" "How much is 100 USD in Indian rupees right now?"

# Q10 - Stuck on coding problem (coaching tone)
$results += Run-QualityTest "Q10-coding-stuck" "I've been stuck on this bug for 3 hours and I can't figure it out. What should I do?"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
$passed = ($results | Where-Object { $_.Pass }).Count
$total  = $results.Count
Write-Host ""
Write-Host "Tier 3 complete: $passed/$total passed" -ForegroundColor $(if ($passed -eq $total) { "Green" } else { "Yellow" })

# Average scores
$scoredTests = $results | Where-Object { $_.Scores -ne $null }
if ($scoredTests.Count -gt 0) {
    $avgAcc  = [math]::Round(($scoredTests | ForEach-Object { if ($_.Scores.PSObject.Properties["accuracy"])       { [double]$_.Scores.accuracy }       else { 0 } } | Measure-Object -Average).Average, 2)
    $avgHelp = [math]::Round(($scoredTests | ForEach-Object { if ($_.Scores.PSObject.Properties["helpfulness"])   { [double]$_.Scores.helpfulness }   else { 0 } } | Measure-Object -Average).Average, 2)
    $avgTone = [math]::Round(($scoredTests | ForEach-Object { if ($_.Scores.PSObject.Properties["tone"])          { [double]$_.Scores.tone }          else { 0 } } | Measure-Object -Average).Average, 2)
    $avgAppr = [math]::Round(($scoredTests | ForEach-Object { if ($_.Scores.PSObject.Properties["appropriateness"]){ [double]$_.Scores.appropriateness } else { 0 } } | Measure-Object -Average).Average, 2)
    Write-Host "  Avg scores: accuracy=$avgAcc helpfulness=$avgHelp tone=$avgTone appropriateness=$avgAppr" -ForegroundColor DarkGray
}

$file = Save-TierResult -TierName "tier3" -Results $results

return [PSCustomObject]@{
    Tier    = "tier3"
    Passed  = $passed
    Total   = $total
    Abort   = $false
    File    = $file
    Results = $results
}
