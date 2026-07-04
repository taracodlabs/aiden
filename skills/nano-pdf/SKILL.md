---
name: nano-pdf
description: Edit PDFs with natural-language instructions using the nano-pdf CLI tool
category: productivity
version: 1.0.0
origin: aiden
license: Apache-2.0
tags: pdf, edit, merge, split, compress, redact, nano-pdf, cli, document, watermark
metadata:
  aiden:
    required_binaries:
      - name: nano-pdf
        help: Install the nano-pdf CLI — npm i -g nano-pdf
---

# nano-pdf — Natural-Language PDF Editing

Use the `nano-pdf` CLI to perform common PDF operations — merge, split, compress, add watermarks, redact text, and more — via simple natural-language or flag-based commands.

## When to Use

- User wants to merge multiple PDFs into one
- User wants to split a PDF into individual pages or page ranges
- User wants to compress a large PDF to reduce file size
- User wants to add a watermark or page numbers to a PDF
- User wants to redact or remove specific pages

## How to Use

### 1. Install nano-pdf

```powershell
pip install nano-pdf
# Verify installation
nano-pdf --version
```

### 2. Merge multiple PDFs

```powershell
nano-pdf merge report1.pdf report2.pdf appendix.pdf --output merged.pdf
```

### 3. Split a PDF into individual pages

```powershell
# Split every page into a separate file
nano-pdf split document.pdf --output ./pages/

# Split a specific range into a new file
nano-pdf split document.pdf --pages 1-5 --output extract.pdf
```

### 4. Compress a PDF

```powershell
# Default compression
nano-pdf compress large_file.pdf --output compressed.pdf

# Aggressive compression (lower image quality)
nano-pdf compress large_file.pdf --level high --output compressed.pdf
```

### 5. Add a watermark

```powershell
nano-pdf watermark input.pdf --text "CONFIDENTIAL" --output watermarked.pdf
# Custom font size and opacity
nano-pdf watermark input.pdf --text "DRAFT" --size 60 --opacity 0.3 --output draft.pdf
```

### 6. Add page numbers

```powershell
nano-pdf number input.pdf --position bottom-right --output numbered.pdf
```

### 7. Remove specific pages

```powershell
# Remove pages 3 and 7 from a 10-page PDF
nano-pdf remove input.pdf --pages 3,7 --output trimmed.pdf
```

### 8. Rotate pages

```powershell
# Rotate all pages 90 degrees clockwise
nano-pdf rotate input.pdf --degrees 90 --output rotated.pdf

# Rotate only page 2
nano-pdf rotate input.pdf --degrees 180 --pages 2 --output rotated.pdf
```

### 9. Extract images from a PDF

```powershell
nano-pdf extract-images input.pdf --output ./images/
```

## Examples

**"Merge contract.pdf and appendix.pdf into one file"**
→ Use step 2: `nano-pdf merge contract.pdf appendix.pdf --output final_contract.pdf`

**"Compress this 50MB report so I can email it"**
→ Use step 4 with `--level high` to aggressively reduce size.

**"Split the quarterly report — I only need pages 10 to 15"**
→ Use step 3 with `--pages 10-15`.

## Cautions

- nano-pdf preserves PDF/A compliance when the input is already PDF/A — check if needed for legal documents
- Aggressive compression (`--level high`) reduces image resolution — not suitable for print-quality output
- Encrypted or password-protected PDFs cannot be processed without first removing the password
- Very large PDFs (> 200 MB) may require chunked processing — split first, process, then merge
- nano-pdf is a Python package — confirm it is installed before use (`pip show nano-pdf`)
