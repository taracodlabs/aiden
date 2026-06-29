---
name: code_execution
description: Running scripts and code on Windows
version: 1.0.0
tags: code, script, python, node, run, execute, build
license: Apache-2.0
---

# Code Execution

When executing code on Windows:
1. Use PowerShell syntax for shell commands
2. Full paths always: C:\Users\<you>\DevOS\workspace\
3. For Python: verify python is in PATH first with shell_exec
4. For Node.js: check node version before running
5. Always capture and return stdout + stderr
6. Clean up temp files after execution
7. Never use Linux commands: use dir not ls, type not cat
