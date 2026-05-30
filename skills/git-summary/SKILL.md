---

name: git-summary

description: Generate summaries of Git repositories, commits, branches, contributors, and recent changes using git commands.

category: developer

version: 1.0.0

origin: community

license: Apache-2.0

tags: git, github, commits, branches, changelog, repository, summary

---

# Git Repository Summary

Generate a concise summary of a Git repository including recent commits, active branches, contributors, changed files, and repository status.

## When to Use

- User wants a quick overview of a repository

- User wants a summary of recent development activity

- User wants to understand a new codebase

- User wants release notes or changelog style output

- User wants branch and contributor statistics

## How to Use

### Repository Status

```powershell

git status

```

### Recent Commits

```powershell

git log --oneline -10

```

### Branch Summary

```powershell

git branch -a

```

### Contributor Summary

```powershell

git shortlog -sn

```

### Changed Files

```powershell

git diff --stat HEAD~10..HEAD

```

### Repository Overview

```powershell

git log --since="30 days ago" --oneline

```

## Examples

### Example 1

User prompt:

"Summarize this repository"

Expected flow:

- Run git status

- Run git log --oneline -10

- Run git shortlog -sn

- Generate concise summary

### Example 2

User prompt:

"What happened recently in this repo?"

Expected flow:

- Run git log --since="7 days ago"

- Analyze commit messages

- Summarize major changes

## Cautions

- Must be run inside a git repository

- Large repositories may take longer to analyze

- Private repositories require appropriate access

## Requirements

- Git installed

- Read access to repository

