---
name: github-repo-management
description: "GitHub repos: create, clone, fork, archive (gh CLI + git)"
category: developer
version: 1.0.0
origin: aiden
license: Apache-2.0
tags: github, repository, repo, clone, fork, branch, gh-cli, git, remote, management
---

# GitHub Repository Management

Create, clone, fork, configure, and manage GitHub repositories using the `gh` CLI and `git`. Covers repo creation, branch management, secrets, and repo settings.

## When to Use

- User wants to create a new GitHub repository
- User wants to clone or fork an existing repository
- User wants to list repositories in an organization or for a user
- User wants to manage branches (list, create, protect, delete)
- User wants to add or list GitHub Actions secrets

## How to Use

### 1. Create a new repository

```powershell
# Create public repo and clone locally
gh repo create my-new-project --public --clone

# Create private repo with description
gh repo create my-new-project --private --description "Internal API service"

# Create repo from local directory
cd "C:\Users\<you>\Projects\myapp"
gh repo create my-new-project --source=. --private --push
```

### 2. Clone a repository

```powershell
# Clone via gh (handles auth automatically)
gh repo clone owner/repo-name

# Clone to specific directory
gh repo clone owner/repo-name ./local-folder

# Clone with SSH explicitly
git clone git@github.com:owner/repo-name.git
```

### 3. Fork a repository

```powershell
# Fork to your account and clone locally
gh repo fork owner/repo-name --clone

# Fork to an organization
gh repo fork owner/repo-name --org my-org
```

### 4. List repositories

```powershell
# Your repos
gh repo list --limit 30

# Organization repos
gh repo list my-org --limit 50

# Filter by language
gh repo list --language python --limit 20
```

### 5. Manage branches

```powershell
# List remote branches
git branch -r

# Create and push a new branch
git checkout -b feature/my-feature
git push -u origin feature/my-feature

# Delete a remote branch
git push origin --delete feature/old-branch

# List branches via gh
gh api repos/owner/repo/branches | python -m json.tool
```

### 6. View and update repo settings

```powershell
# View repo details
gh repo view owner/repo-name

# View in browser
gh repo view owner/repo-name --web

# Edit repo description and topics
gh repo edit owner/repo-name --description "Updated description" --add-topic "api,python"
```

### 7. Manage GitHub Actions secrets

```powershell
# List secrets
gh secret list

# Set a secret
gh secret set DATABASE_URL --body "postgresql://user:pass@host/db"

# Set from a file
gh secret set PRIVATE_KEY < private_key.pem

# Delete a secret
gh secret delete OLD_SECRET
```

### 8. Archive or delete a repository

```powershell
# Archive (read-only, not deleted)
gh repo archive owner/repo-name

# Delete — IRREVERSIBLE — direct user to do this manually
# gh repo delete owner/repo-name --yes  ← do not run this for the user
```

## Examples

**"Create a new private GitHub repo for my Python scripts"**
→ Use step 1: `gh repo create my-python-scripts --private --clone`.

**"Fork the fastapi repository so I can contribute"**
→ Use step 3: `gh repo fork tiangolo/fastapi --clone`.

**"Add my API key as a GitHub Actions secret"**
→ Use step 7: `gh secret set API_KEY --body "..."`.

## Cautions

- Repository deletion is IRREVERSIBLE — never run `gh repo delete` for the user; direct them to do it in the GitHub web UI
- Archiving a repo makes it read-only but does not delete it — safe to run
- Secrets set with `gh secret set` are write-only in the GitHub UI — they cannot be read back after creation
- Forking a private repo copies it to your account — ensure the original owner's license permits this
