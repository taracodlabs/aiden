---
name: opencode
description: Delegate coding to OpenCode CLI (multi-LLM open-source coding agent)
category: agent-bridge
version: 1.0.0
origin: aiden
license: Apache-2.0
tags: opencode, ai-coding, agent-bridge, open-source, multi-model, coding, delegation, claude, gpt
---

# OpenCode CLI Agent Bridge

Delegate coding tasks to OpenCode — an open-source AI coding CLI that supports multiple LLM providers (Anthropic, OpenAI, Gemini, local Ollama). Provides a terminal UI for interactive coding sessions.

## When to Use

- User wants an open-source, self-hostable AI coding agent
- User wants to use local Ollama models for coding without cloud API costs
- User wants to switch between multiple LLM providers for the same task
- Task requires a coding agent with a built-in terminal UI
- User wants to run coding sessions with custom model configurations

## How to Use

### 1. Install OpenCode

```powershell
# Install via npm
npm install -g opencode-ai

# Or install via the installer script
Invoke-WebRequest -Uri "https://opencode.ai/install" -UseBasicParsing | Invoke-Expression

# Verify
opencode --version
```

### 2. Configure providers

OpenCode reads from `~/.config/opencode/config.json`:

```powershell
$config = @{
  providers = @{
    anthropic = @{ apiKey = $env:ANTHROPIC_API_KEY }
    openai    = @{ apiKey = $env:OPENAI_API_KEY }
    ollama    = @{ baseUrl = "http://localhost:11434" }
  }
  model = "anthropic/claude-opus-4-5"
} | ConvertTo-Json -Depth 5

$configDir = "$env:USERPROFILE\.config\opencode"
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
Set-Content -Path "$configDir\config.json" -Value $config
```

### 3. Run an interactive coding session

```powershell
Set-Location "C:\Users\<you>\myproject"
opencode
# Opens terminal UI — type your task in the prompt
```

### 4. Run a specific task non-interactively

```powershell
# Run task without TUI
opencode run "Add pagination to the GET /users endpoint"

# Run with a specific model
opencode run --model "openai/gpt-4o" "Refactor the auth middleware to handle OAuth2"
```

### 5. Use local Ollama model (no cloud API costs)

```powershell
# Ensure Ollama is running with a code-capable model
# ollama pull qwen2.5-coder:7b

opencode run --model "ollama/qwen2.5-coder:7b" "Write a Python script to parse CSV files"
```

### 6. Run on a specific file

```powershell
opencode run "Review and fix the error handling in" src/api/payments.ts
```

### 7. Generate a new file

```powershell
opencode run "Create a new TypeScript module at src/cache/redis.ts that wraps ioredis with:
- connect(), disconnect() methods
- get(key), set(key, value, ttlSeconds) methods
- Proper error handling and type safety"
```

## Examples

**"Use the local Qwen model to add tests to my utility functions"**
→ Use step 5 with `--model "ollama/qwen2.5-coder:7b"` and ask it to generate tests for your utils file.

**"Run an interactive coding session on my project"**
→ Use step 3 — navigate to the project first, then run `opencode` to open the TUI.

**"Refactor this module but use GPT-4o instead of Claude"**
→ Use step 4 with `--model "openai/gpt-4o"`.

## Cautions

- OpenCode requires at least one provider configured with a valid API key (or Ollama running locally)
- The TUI mode (step 3) requires a terminal that supports ANSI escape codes — works in Windows Terminal
- Local models via Ollama are free but slower and less capable than cloud models for complex refactoring
- OpenCode may request file system access — review the project scope before running on sensitive codebases
- Check https://opencode.ai for the latest install instructions as the project is actively developed
