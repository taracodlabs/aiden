---
name: wsl-bridge
description: Run Linux in WSL from Windows; share files between hosts
category: windows
version: 1.0.0
platform: windows
tags: wsl, linux, ubuntu, bash, bridge, windows, distro, shell
license: Apache-2.0
---

# WSL Bridge

Invoke Linux commands from Windows, pass data between WSL and Windows filesystems, and manage WSL distributions — without switching terminals.

## When to Use

- User wants to run a Linux command (grep, awk, sed, curl) from Windows
- User asks to install or manage a WSL distribution
- User needs to access Windows files from WSL or vice versa
- User wants to run a bash script via WSL
- User asks about WSL status, memory usage, or network config

## How to Use

### Run a Linux command from PowerShell
```powershell
wsl -- ls -la /home/
wsl -- df -h
wsl -- uname -a
```

### Run a bash script in WSL
```powershell
wsl bash -c "cd /home/user/project && npm install && npm run build"
```

### Pass Windows file to WSL command
```powershell
# Convert Windows path to WSL path
$winPath = "C:\Users\<you>\data.csv"
$wslPath = wsl wslpath -u $winPath
wsl -- cat $wslPath | wsl -- grep "ERROR"
```

### Access Windows drive from WSL
```powershell
# Windows C: drive is mounted at /mnt/c inside WSL
wsl -- ls /mnt/c/Users/<you>/Documents
```

### List installed WSL distributions
```powershell
wsl --list --verbose
```

### Check WSL version and status
```powershell
wsl --status
wsl --version
```

### Shutdown WSL (frees memory)
```powershell
wsl --shutdown
```

### Set default WSL distribution
```powershell
wsl --set-default Ubuntu-22.04
```

### Run a specific distro
```powershell
wsl -d Ubuntu-22.04 -- python3 --version
```

### Forward a port from WSL to Windows
```powershell
# Get WSL IP
$wslIp = (wsl -- hostname -I).Trim()
Write-Host "WSL IP: $wslIp"
# Use netsh to forward (requires elevated session)
# netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=$wslIp
```

## Examples

**"Run grep on a log file using WSL"**
→ `wsl -- grep -i "error" /mnt/c/logs/app.log | wsl -- tail -n 50`

**"What WSL distros do I have installed?"**
→ `wsl --list --verbose` — shows name, state, and WSL version for each distro.

**"Use awk to sum a column in a CSV"**
→ `wsl -- awk -F',' '{sum += $3} END {print sum}' /mnt/c/Users/<you>/data.csv`

## Cautions

- WSL 2 uses a virtual machine — memory is not immediately released on process exit; use `wsl --shutdown` to reclaim RAM
- File I/O across the Windows/WSL boundary (/mnt/c/) is slower than native Linux filesystem operations
- Some Linux tools behave differently on WSL vs native Linux (e.g., systemd, Docker daemon)
- Port forwarding between WSL and Windows host may require adjustments after each WSL restart
