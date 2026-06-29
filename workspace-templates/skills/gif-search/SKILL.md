---
name: gif-search
description: Search and fetch GIFs from Tenor using the public API with curl or PowerShell — requires a free Tenor API key
category: media
version: 1.0.1
origin: aiden
license: Apache-2.0
tags: gif, tenor, giphy, search, media, animation, image, reaction, fun
---

# GIF Search via Tenor

Search and fetch GIFs using the Tenor API. Obtain a free API key at
https://developers.google.com/tenor/guides/quickstart (takes 2 minutes) and set it as
the `TENOR_API_KEY` environment variable. All examples below use `$env:TENOR_API_KEY`
(PowerShell) or `os.environ["TENOR_API_KEY"]` (Python).

## When to Use

- User wants to find a GIF for a given mood, reaction, or topic
- User wants to share a GIF URL in a chat or document
- User wants to download a GIF file locally
- User wants to embed a GIF in a web page or email

## How to Use

### 1. Search GIFs with PowerShell (no API key needed)

```powershell
function Search-Gif($query, $limit = 5) {
  $q    = [Uri]::EscapeDataString($query)
  $url  = "https://tenor.googleapis.com/v2/search?q=$q&limit=$limit&key=$env:TENOR_API_KEY"
  $resp = Invoke-RestMethod -Uri $url
  $resp.results | ForEach-Object {
    [PSCustomObject]@{
      Title    = $_.title
      GifUrl   = $_.media_formats.gif.url
      PreviewUrl = $_.media_formats.tinygif.url
    }
  }
}

# Usage
Search-Gif "excited celebration" | Format-Table -AutoSize
```

### 2. Search GIFs with Python

```python
import requests, urllib.parse

def search_gif(query, limit=5, api_key=None):
  api_key = api_key or os.environ.get("TENOR_API_KEY", "")
  params = {"q": query, "limit": limit, "key": api_key}
  resp   = requests.get("https://tenor.googleapis.com/v2/search", params=params)
  resp.raise_for_status()
  results = resp.json().get("results", [])
  return [{"title": r["title"], "url": r["media_formats"]["gif"]["url"]} for r in results]

gifs = search_gif("happy dancing")
for g in gifs:
  print(g["title"])
  print(g["url"])
  print()
```

### 3. Get trending GIFs

```powershell
$url  = "https://tenor.googleapis.com/v2/featured?limit=10&key=$env:TENOR_API_KEY"
$resp = Invoke-RestMethod -Uri $url
$resp.results | Select-Object title, @{N="url";E={$_.media_formats.gif.url}}
```

### 4. Download a GIF to disk

```powershell
$gifUrl   = "https://media.tenor.com/your-gif.gif"
$outPath  = "C:\Users\<you>\Downloads\reaction.gif"
Invoke-WebRequest -Uri $gifUrl -OutFile $outPath
Write-Host "Downloaded: $outPath"
```

### 5. Get a GIF by category (reaction types)

```powershell
# Categories: happy, sad, angry, love, funny, wow, thumbsup, facepalm, etc.
$category = "facepalm"
Search-Gif $category -limit 3 | Select-Object GifUrl
```

### 6. Use your own Tenor API key (higher rate limits)

Register at https://developers.google.com/tenor/guides/quickstart — free, takes 2 minutes.

```powershell
$env:TENOR_API_KEY = "your_api_key_here"

function Search-Gif($query, $limit = 5) {
  $q   = [Uri]::EscapeDataString($query)
  $url = "https://tenor.googleapis.com/v2/search?q=$q&limit=$limit&key=$env:TENOR_API_KEY"
  (Invoke-RestMethod -Uri $url).results | Select-Object title, @{N="url";E={$_.media_formats.gif.url}}
}
```

## Examples

**"Find me a GIF for when tests are passing"**
→ Use step 2 with query `"success celebration cheering"` and return the top result URL.

**"What are trending GIFs right now?"**
→ Use step 3 to fetch featured/trending GIFs.

**"Download the first result for 'thumbs up'"**
→ Use step 1 to search, then step 4 to download the `GifUrl` of the first result.

## Cautions

- The demo API key used in examples has low rate limits — register your own free key for production use
- Tenor GIF URLs are CDN links and may not be permanently stable — don't store them long-term
- GIF files can be large (1-20 MB) — check size before downloading in bulk
- Always attribute Tenor as the source when displaying GIFs publicly
