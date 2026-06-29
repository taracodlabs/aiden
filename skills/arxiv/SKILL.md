---
name: arxiv
description: Search and download arXiv papers (no API key needed)
category: research
version: 1.0.0
origin: aiden
license: Apache-2.0
tags: arxiv, research, papers, academic, ai, ml, science, pdf, preprint, citations
---

# arXiv Paper Search and Download

Search and retrieve academic papers from arXiv using the free public REST API. No API key or authentication required.

## When to Use

- User wants to find recent ML/AI/CS papers on a topic
- User wants to read the abstract of a specific paper
- User wants to download a paper PDF
- User wants to find papers by a specific author
- User wants to stay up-to-date on a research area

## How to Use

### 1. Search papers by keyword

The arXiv API uses Atom XML — parse with PowerShell or Python.

```powershell
$query   = [Uri]::EscapeDataString("attention mechanism transformer")
$url     = "http://export.arxiv.org/api/query?search_query=all:$query&start=0&max_results=5&sortBy=lastUpdatedDate&sortOrder=descending"
$resp    = Invoke-RestMethod -Uri $url
$resp.feed.entry | ForEach-Object {
  [PSCustomObject]@{
    Title   = $_.title
    Authors = ($_.author | ForEach-Object { $_.name }) -join ", "
    Date    = $_.published
    Id      = $_.id
  }
} | Format-Table -AutoSize
```

### 2. Search by category (cs.AI, cs.LG, stat.ML, etc.)

```powershell
$cat   = "cs.LG"
$query = [Uri]::EscapeDataString("large language models")
$url   = "http://export.arxiv.org/api/query?search_query=cat:$cat+AND+all:$query&max_results=10&sortBy=submittedDate&sortOrder=descending"
$resp  = Invoke-RestMethod -Uri $url
$resp.feed.entry | Select-Object title, published
```

### 3. Fetch a specific paper by arXiv ID

```powershell
$arxivId = "2305.17333"   # from URL: arxiv.org/abs/2305.17333
$url     = "http://export.arxiv.org/api/query?id_list=$arxivId"
$resp    = Invoke-RestMethod -Uri $url
$entry   = $resp.feed.entry
Write-Host "Title:   " $entry.title
Write-Host "Authors: " (($entry.author | ForEach-Object { $_.name }) -join ", ")
Write-Host "Abstract:" $entry.summary
```

### 4. Download a paper PDF

```powershell
$arxivId = "2305.17333"
$pdfUrl  = "https://arxiv.org/pdf/$arxivId.pdf"
$outPath = "C:\Users\<you>\Downloads\paper_$arxivId.pdf"
Invoke-WebRequest -Uri $pdfUrl -OutFile $outPath
Write-Host "Downloaded to $outPath"
```

### 5. Search papers with Python

```python
import urllib.request, urllib.parse, xml.etree.ElementTree as ET

def search_arxiv(query, max_results=5, category="cs.LG"):
  params = urllib.parse.urlencode({
    "search_query": f"cat:{category} AND all:{query}",
    "max_results": max_results,
    "sortBy": "submittedDate",
    "sortOrder": "descending"
  })
  url  = f"http://export.arxiv.org/api/query?{params}"
  resp = urllib.request.urlopen(url).read()
  root = ET.fromstring(resp)
  ns   = {"a": "http://www.w3.org/2005/Atom"}
  for entry in root.findall("a:entry", ns):
    print(entry.find("a:title", ns).text.strip())
    print(entry.find("a:id", ns).text.strip())
    print()

search_arxiv("chain of thought reasoning", max_results=5)
```

### 6. Find papers by author

```powershell
$author  = [Uri]::EscapeDataString("Andrej Karpathy")
$url     = "http://export.arxiv.org/api/query?search_query=au:$author&max_results=10&sortBy=submittedDate&sortOrder=descending"
$resp    = Invoke-RestMethod -Uri $url
$resp.feed.entry | Select-Object title, published | Format-Table
```

## Examples

**"Find the 5 most recent papers on retrieval-augmented generation"**
→ Use step 2 with query `retrieval augmented generation` and category `cs.CL` or `cs.AI`.

**"Get me the abstract of paper 2305.17333"**
→ Use step 3 with the arXiv ID.

**"Download the Attention Is All You Need paper"**
→ arXiv ID is `1706.03762`. Use step 4 to download the PDF.

## Cautions

- arXiv API rate limit is 3 requests per second — add a 1-second delay between calls for bulk operations
- Papers on arXiv are preprints and have not necessarily been peer-reviewed
- arXiv IDs changed format in 2007 — old IDs use `category/YYMMNNN` format; new ones use `YYMM.NNNNN`
- PDF download uses the standard `arxiv.org/pdf/<id>.pdf` URL — some papers have versioned PDFs at `arxiv.org/pdf/<id>v1.pdf`
