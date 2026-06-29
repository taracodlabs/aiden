---
name: clipboard-history
description: Read/write Windows clipboard text, HTML, images, history (PowerShell)
category: windows
version: 1.0.0
platform: windows
tags: clipboard, copy, paste, history, windows, powershell, text
license: Apache-2.0
---

# Clipboard History

Read and write Windows clipboard content, access clipboard history (Win+V), and manipulate clipboard data — text, HTML, and file lists — via PowerShell.

## When to Use

- User wants to read what's currently on the clipboard
- User asks Aiden to set or overwrite clipboard content
- User wants to pipe command output directly to the clipboard
- User needs to clear the clipboard or check clipboard history
- User wants to copy a file path, URL, or code snippet to clipboard

## How to Use

### Read current clipboard text
```powershell
Get-Clipboard
```

### Write text to clipboard
```powershell
Set-Clipboard -Value "Hello from Aiden!"
```

### Pipe command output to clipboard
```powershell
Get-Process | Out-String | Set-Clipboard
```

### Copy a file path to clipboard
```powershell
Set-Clipboard -Value "C:\Users\<you>\Documents\report.pdf"
```

### Clear the clipboard
```powershell
Set-Clipboard -Value $null
```

### Read clipboard as HTML (if HTML is on clipboard)
```powershell
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::Html)
```

### Check if clipboard contains an image
```powershell
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::ContainsImage()
```

### Save clipboard image to file
```powershell
Add-Type -AssemblyName System.Windows.Forms
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img) {
  $img.Save("$env:USERPROFILE\Desktop\clipboard-image.png")
  Write-Host "Saved to Desktop"
} else {
  Write-Host "No image on clipboard"
}
```

### Access clipboard history entries (Win+V API)
```powershell
# Clipboard history requires Windows 10 1809+ and history enabled in Settings
# Use the ContentDeliveryManager workaround or UWP API via PowerShell
Add-Type -AssemblyName Windows.ApplicationModel
$history = [Windows.ApplicationModel.DataTransfer.Clipboard,Windows.ApplicationModel,ContentType=WindowsRuntime]
# Note: full UWP clipboard history requires a packaged app context
# For CLI use, pipe history via the built-in Win+V UI or a third-party tool
Write-Host "Open Win+V to view clipboard history interactively"
```

## Examples

**"Copy the output of dir to clipboard"**
→ `Get-ChildItem | Out-String | Set-Clipboard`

**"Put my public IP address on the clipboard"**
→ `(Invoke-RestMethod -Uri 'https://api.ipify.org').Trim() | Set-Clipboard`

**"Clear whatever is on the clipboard"**
→ `Set-Clipboard -Value $null`

## Cautions

- `Set-Clipboard` requires PowerShell 5.1+ on Windows; earlier versions use `clip.exe` as fallback
- Clipboard history (Win+V) requires it to be enabled in Settings → System → Clipboard
- Image and HTML clipboard operations require `System.Windows.Forms` assembly — only available on Windows
- Clipboard contents are not persisted across reboots unless pinned in the clipboard history UI
