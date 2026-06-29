---
name: obsidian
description: Read, search, and create notes in Obsidian vaults
category: productivity
version: 1.0.0
origin: aiden
license: Apache-2.0
tags: obsidian, notes, vault, markdown, knowledge-base, zettelkasten, wiki, pkm
---

# Obsidian Vault Operations

Interact with Obsidian vaults directly through the file system. Obsidian notes are plain Markdown files, so you can read, search, create, and link notes without launching the Obsidian app.

## When to Use

- User wants to search notes across an Obsidian vault
- User wants to create a new note in a specific vault folder
- User wants to find all notes tagged with a given tag
- User wants to read a specific note by name
- User wants to find backlinks or internal wiki-links across notes

## How to Use

### 1. Locate the vault

Obsidian vaults are folders containing `.md` files and a `.obsidian/` config dir. Ask the user for the vault path or search common locations.

```powershell
# Find Obsidian vaults on Windows (searches common locations)
Get-ChildItem "$env:USERPROFILE" -Recurse -Filter ".obsidian" -Directory -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty Parent | Select-Object FullName
```

### 2. Search notes by keyword

```powershell
# Full-text search across all notes in vault
$vault = "C:\Users\<you>\Documents\MyVault"
Get-ChildItem $vault -Recurse -Filter "*.md" |
  Select-String -Pattern "your keyword" -SimpleMatch |
  Select-Object Path, LineNumber, Line |
  Format-Table -AutoSize
```

### 3. Search notes by tag

Obsidian tags appear as `#tag` in note body or `tags: [tag]` in frontmatter.

```powershell
$vault = "C:\Users\<you>\Documents\MyVault"
$tag   = "project"
Get-ChildItem $vault -Recurse -Filter "*.md" |
  Select-String -Pattern "#$tag\b|tags:.*\b$tag\b" -SimpleMatch:$false |
  Select-Object Path | Sort-Object Path -Unique
```

### 4. Read a specific note

```powershell
$note = "C:\Users\<you>\Documents\MyVault\Daily\2026-04-17.md"
Get-Content $note -Raw
```

### 5. Create a new note

```powershell
$vault   = "C:\Users\<you>\Documents\MyVault"
$folder  = "Projects"
$title   = "New Project Idea"
$date    = Get-Date -Format "yyyy-MM-dd"
$content = @"
---
title: $title
date: $date
tags: [project, idea]
---

# $title

Write your note content here.
"@
$path = Join-Path $vault $folder "$title.md"
New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
Set-Content -Path $path -Value $content -Encoding UTF8
Write-Host "Created: $path"
```

### 6. Find all backlinks to a note

```powershell
$vault    = "C:\Users\<you>\Documents\MyVault"
$noteName = "Index"   # without .md
Get-ChildItem $vault -Recurse -Filter "*.md" |
  Select-String -Pattern "\[\[$noteName(\|[^\]]*)?\]\]" |
  Select-Object Path | Sort-Object Path -Unique
```

## Examples

**"Search my Obsidian vault for notes about async/await"**
→ Use step 2 with keyword `async/await`. Ask user for vault path first if not known.

**"Create a daily note for today in my vault"**
→ Use step 5 with folder `Daily`, title as today's date `2026-04-17`, and standard daily note frontmatter.

**"Find all notes tagged #book-review in my vault"**
→ Use step 3 with tag `book-review`.

## Cautions

- Never delete notes without explicit user confirmation — deletions are hard to recover
- Obsidian vaults can be very large; use `-Recurse` with care on deep vault trees
- The `.obsidian/` directory contains config/plugins — do not modify it
- If the user has Obsidian open, writing files simultaneously is safe (Obsidian watches for changes), but avoid writing the same file from two places at once
