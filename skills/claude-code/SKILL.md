---
name: claude-code
description: Delegate coding and file edits to Anthropic Claude Code CLI
category: agent-bridge
version: 1.0.0
origin: aiden
license: Apache-2.0
tags: claude, anthropic, code, cli, agent-bridge, coding, delegation, agentic, pair-programming
---

# Claude Code Agent Bridge

Delegate complex multi-file coding tasks, refactoring, and code review to Anthropic Claude Code CLI. Claude Code has deep IDE integration and can make targeted edits across an entire codebase.

## When to Use

- Task requires deep multi-file refactoring beyond a single script
- User wants an expert code review with inline suggestions
- Task requires reading, understanding, and rewriting large codebases
- User wants to pair-program with an AI that can navigate projects
- Task requires complex TypeScript/Python/Rust code generation

## How to Use

### 1. Install Claude Code

```powershell
# Requires Node.js 18+
npm install -g @anthropic-ai/claude-code

# Verify installation
claude --version

# Authenticate (requires Anthropic API key)
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

### 2. Run Claude Code on a task

```powershell
# Navigate to the project
Set-Location "C:\Users\<you>\myproject"

# Run with a specific task
claude "Refactor the authentication module to use JWT tokens instead of sessions"
```

### 3. Non-interactive (headless) mode

```powershell
# Run a specific task non-interactively (for automation)
claude --print "Review the function in src/utils.ts and suggest improvements" 

# Pipe output to a file
claude --print "Generate TypeScript interfaces for this JSON schema" | Out-File types.ts
```

### 4. Run Claude Code on a specific file

```powershell
# Ask Claude to work on a specific file
claude "Fix all TypeScript type errors in src/components/Dashboard.tsx"

# With additional context
claude "The function processPayment in src/payments.ts fails when amount is 0. Fix it."
```

### 5. Run in print mode to get a response without editing files

```powershell
# Get a code review without applying changes
$review = claude --print "Review src/api.ts for security vulnerabilities and anti-patterns"
Write-Host $review
```

### 6. Delegate a complex refactoring task

```powershell
# Multi-step task with context
$task = @"
Refactor the codebase to:
1. Extract all database queries from controllers into a repository layer
2. Add TypeScript types for all repository methods  
3. Update all tests to use the new repository interfaces
"@
claude $task
```

### 7. Run on a different directory

```powershell
claude --directory "C:\Users\<you>\other-project" "Add error handling to all async functions"
```

## Examples

**"Refactor my Express API to use async/await everywhere"**
→ Navigate to the project directory and use step 2: `claude "Refactor all callback-based Express route handlers to use async/await with proper error handling"`.

**"Review my authentication code for security issues"**
→ Use step 5 with `--print` to get a review without applying changes.

**"Generate TypeScript interfaces for my API response types"**
→ Use step 3 in headless mode, pipe output to a types file.

## Cautions

- Claude Code applies edits directly to files — review changes with `git diff` after each session
- `ANTHROPIC_API_KEY` must be set — Claude Code bills against the Anthropic API
- Headless mode (`--print`) does not apply changes — it only returns text
- For large codebases, scope the task to a specific module or file to avoid context overflow
- Always commit or stash changes before running Claude Code on a large task, so you can revert if needed
