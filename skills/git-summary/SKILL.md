---
name: git-summary
description: "Summarize recent git activity grouped by day in plain English"
category: productivity
version: 1.0.0
license: Apache-2.0
origin: community
tags: git, productivity, development, commits, summary
---

# Git Summary

Summarize your recent git commit history, grouped by day, presented in plain English. Optionally generate a standup update format.

## When to Use

- User says "summarize my recent commits"
- User says "what did I work on this week"
- User asks for a git activity summary
- User wants a standup update based on recent work
- User needs to recall what they accomplished recently

## How to Use

### 1. Fetch Recent Commits

Use `shell_exec` to get recent commit history:

```bash
git log --oneline -20 --since="7 days ago"
```

### 2. Parse and Group by Day

Use `run_python` to process the commit log:

```python
import subprocess
from datetime import datetime
from collections import defaultdict

# Get commits with dates
result = subprocess.run(
    ["git", "log", "--pretty=format:%H|%ci|%s", "-20"],
    capture_output=True, text=True
)

commits_by_day = defaultdict(list)
for line in result.stdout.strip().split('\n'):
    if '|' in line:
        hash, date_str, message = line.split('|', 2)
        day = datetime.strptime(date_str.split()[0], '%Y-%m-%d').strftime('%A, %B %d')
        commits_by_day[day].append(message)

# Generate summary
for day, messages in commits_by_day.items():
    print(f"\n{day}:")
    for msg in messages:
        print(f"  • {msg}")
```

### 3. Summarize in Plain English

Transform commit messages into readable sentences:

- "feat: add auth middleware" → "Implemented authentication middleware"
- "fix: resolve null pointer" → "Fixed a null pointer issue"
- "docs: update API guide" → "Updated API documentation"
- "refactor: simplify utils" → "Refactored and simplified utility functions"
- "test: add unit tests" → "Added unit test coverage"

### 4. Standup Update Format (Optional)

When user requests standup format:

```
## Standup Update — [Today's Date]

### Yesterday
- [Task completed 1]
- [Task completed 2]
- [Task completed 3]

### Today
- [Planned work based on recent commits]

### Blockers
- [Any issues mentioned in commits or None]
```

## Examples

**"Summarize my recent commits"**
→ Shows last 20 commits grouped by day with plain-English summaries.

**"What did I work on this week?"**
→ Week-long summary with daily breakdowns.

**"Generate a standup update"**
→ Formats recent commits into yesterday/today/blockers structure.

## Notes

- Runs from the current git repository context
- Uses last 20 commits by default (adjustable)
- Groups by calendar day
- Converts conventional commit prefixes to readable text
- Standup format is best-effort based on commit messages
