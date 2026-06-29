---
name: defender-quickscan
description: "Windows Defender: scans, threat history, signatures (PowerShell)"
category: windows
version: 1.0.0
platform: windows
tags: defender, antivirus, security, scan, threat, malware, windows, powershell
license: Apache-2.0
---

# Defender Quick Scan

Trigger Windows Defender antivirus scans, inspect threat history, update virus definitions, and check real-time protection status — all via PowerShell cmdlets.

## When to Use

- User wants to run a quick or full antivirus scan
- User asks about recent threats detected by Defender
- User wants to check if real-time protection is enabled
- User needs to update virus/malware signatures
- User wants to know the current Defender protection status

## How to Use

### Check Windows Defender status
```powershell
Get-MpComputerStatus | Select-Object AMServiceEnabled, AntispywareEnabled,
  AntivirusEnabled, RealTimeProtectionEnabled,
  AntispywareSignatureAge, AntivirusSignatureAge, QuickScanAge
```

### Run a quick or full scan
```powershell
Start-MpScan -ScanType QuickScan   # fast scan of likely threat locations
Start-MpScan -ScanType FullScan    # thorough scan of all files (30-60 min)
```

### Scan a specific file or folder
```powershell
Start-MpScan -ScanType CustomScan -ScanPath "C:\Users\<you>\Downloads"
```

### Update virus definitions
```powershell
Update-MpSignature
```

### View threat detection history
```powershell
Get-MpThreatDetection | Select-Object ThreatID, ActionSuccess,
  DetectionSourceTypeID, Resources, InitialDetectionTime |
  Sort-Object InitialDetectionTime -Descending |
  Select-Object -First 10
```

### View active threats
```powershell
Get-MpThreat | Select-Object ThreatID, ThreatName, SeverityID,
  CategoryID, IsActive, Resources
```

### Remove a detected threat
```powershell
Remove-MpThreat -ThreatID 12345
```

### Check exclusion list
```powershell
(Get-MpPreference).ExclusionPath
(Get-MpPreference).ExclusionExtension
```

### Add a scan exclusion (path)
```powershell
Add-MpPreference -ExclusionPath "C:\DevTools\node_modules"
```

## Examples

**"Scan my Downloads folder for threats"**
→ `Start-MpScan -ScanType CustomScan -ScanPath "$env:USERPROFILE\Downloads"` — Defender scans the folder and logs any detections.

**"Are my virus definitions up to date?"**
→ `Get-MpComputerStatus | Select-Object AntivirusSignatureAge, AntivirusSignatureLastUpdated` — signature age of 0 means updated today.

**"Show me the last 5 threats Defender found"**
→ `Get-MpThreatDetection | Sort-Object InitialDetectionTime -Descending | Select-Object -First 5`

## Cautions

- Full scans can take 30-60 minutes and consume significant CPU/IO — warn the user before running
- `Start-MpScan` requires Windows Defender to be the active antivirus — third-party AV may disable these cmdlets
- Removing a threat with `Remove-MpThreat` is permanent; confirm with the user before executing
- Adding exclusions reduces protection coverage — only exclude paths you're certain are safe
