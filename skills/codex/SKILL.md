---
name: codex
description: Delegate coding tasks to OpenAI Codex CLI
category: agent-bridge
version: 1.0.0
origin: aiden
license: Apache-2.0
tags: openai, codex, cli, code-generation, agent-bridge, gpt, automation, coding, delegation
---

# OpenAI Codex CLI Agent Bridge

Delegate code generation, editing, and explanation tasks to the OpenAI Codex CLI. Codex CLI runs GPT-4o in an agentic coding loop with sandboxed code execution.

## When to Use

- User wants to generate code using OpenAI's GPT-4o model
- Task requires code execution in a sandboxed environment
- User wants an alternative to Claude Code using the OpenAI API
- User wants to benchmark or compare code generation between providers
- Task requires OpenAI-specific features or models

## How to Use

### 1. Install Codex CLI

```powershell
# Requires Node.js 18+
npm install -g @openai/codex

# Verify
codex --version

# Set API key
$env:OPENAI_API_KEY = "sk-..."
```

### 2. Run a coding task interactively

```powershell
Set-Location "C:\Users\<you>\myproject"
codex "Add input validation to all form fields in the React components"
```

### 3. Non-interactive mode

```powershell
# Auto-approve all edits (use with caution)
codex --approval-mode auto-edit "Add JSDoc comments to all exported functions in src/"

# Full auto mode (applies changes without confirmation)
codex --approval-mode full-auto "Fix all ESLint errors in the project"
```

### 4. Use a specific model

```powershell
# Use GPT-4o (default)
codex --model gpt-4o "Optimize the database query in src/db.js"

# Use GPT-4o-mini for faster, cheaper tasks
codex --model gpt-4o-mini "Add error handling to the fetch calls"
```

### 5. Ask a coding question without editing files

```powershell
# Question mode — returns explanation only
codex --question "What does the middleware chain in src/app.ts do?"
```

### 6. Generate code from scratch

```powershell
# Create a new file/module
codex "Create a TypeScript utility module with functions for:
- Formatting currency (Indian Rupee)
- Parsing date strings to Date objects
- Debouncing function calls
Save to src/utils/format.ts"
```

### 7. Explain existing code

```powershell
codex "Explain what the agentLoop.ts file does, focusing on the tool execution flow"
```

## Examples

**"Generate a REST API client for the GitHub API in TypeScript"**
→ Use step 6: `codex "Create a TypeScript GitHub API client with methods for: list repos, create issue, get PR. Save to src/github-client.ts"`.

**"Fix all TypeScript compilation errors in the project"**
→ Use step 3 with `--approval-mode auto-edit` after reviewing what changes will be made.

**"Explain how the authentication middleware works"**
→ Use step 5 or 7 in question mode — returns an explanation without modifying files.

## Cautions

- `--approval-mode full-auto` applies all changes without confirmation — always run on a clean git branch
- Codex CLI bills against your OpenAI API key — monitor usage at platform.openai.com/usage
- `OPENAI_API_KEY` must be set in the environment before running any commands
- Codex executes code in a sandbox but may read any files in the current directory — scope to the right project folder
- For very large codebases, provide a focused scope (specific file or module) rather than asking it to scan the entire project
