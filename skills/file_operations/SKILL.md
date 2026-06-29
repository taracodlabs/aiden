---
name: file_operations
description: File creation and management on Windows
version: 1.0.0
tags: file, write, read, save, document, report
license: Apache-2.0
---

# File Operations

When writing files on Windows:
1. Always use full absolute paths: C:\Users\<you>\Desktop\filename.ext
2. For reports: use .md extension for markdown, .txt for plain text
3. Verify file was written with fs.existsSync after write
4. For research reports: include sections — Overview, Findings, Comparison, Verdict
5. Never write empty files — ensure content is populated before file_write step
6. File names: use_underscores_not_spaces.md
