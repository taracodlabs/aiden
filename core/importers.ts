// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/importers.ts — Import conversation history from ChatGPT
// (conversations.json export) and OpenClaw (memory.md files)
// into Aiden's Knowledge Base and workspace memory.

import fs   from 'fs'
import path from 'path'
import { knowledgeBase } from './knowledgeBase'

const WORKSPACE_ROOT = process.env.AIDEN_USER_DATA || process.cwd()
const MEMORY_DIR     = path.join(WORKSPACE_ROOT, 'workspace', 'memory')

// ── Types ──────────────────────────────────────────────────────

export interface ImportResult {
  source:                string
  conversationsImported: number
  memoriesExtracted:     number
  errors:                string[]
}

// ── ChatGPT importer ──────────────────────────────────────────
// Parses the conversations.json from a ChatGPT data export.
//
// Export format:
//   Array<{ title: string, mapping: Record<id, { message: {
//     author: { role: 'user'|'assistant' },
//     content: { parts: string[] }
//   }}> }>

export async function importConversationArchive(filePath: string): Promise<ImportResult> {
  const result: ImportResult = {
    source:                'chatgpt',
    conversationsImported: 0,
    memoriesExtracted:     0,
    errors:                [],
  }

  try {
    const raw           = fs.readFileSync(filePath, 'utf8')
    const conversations = JSON.parse(raw)

    if (!Array.isArray(conversations)) {
      result.errors.push('Invalid format: expected array of conversations')
      return result
    }

    for (const convo of conversations) {
      try {
        const messages: string[] = []

        if (convo.mapping && typeof convo.mapping === 'object') {
          for (const entry of Object.values(convo.mapping) as any[]) {
            const msg = entry?.message
            if (!msg) continue

            const parts = msg?.content?.parts
            if (!Array.isArray(parts) || typeof parts[0] !== 'string') continue

            const text = parts[0].trim()
            if (text.length <= 10) continue

            const role = msg.author?.role || 'unknown'
            messages.push(`${role}: ${text}`)
          }
        }

        if (messages.length === 0) continue

        const content  = messages.join('\n\n').substring(0, 50000)
        const title    = String(convo.title || 'ChatGPT Import').replace(/[^a-zA-Z0-9._\- ]/g, '_').slice(0, 80)
        const filename = `conversation_${title}.txt`

        const ingestResult = knowledgeBase.ingestText(
          content,
          filename,
          'conversation',
          ['chatgpt', 'imported', 'conversation'],
          'public',
        )

        if (ingestResult.success) {
          result.conversationsImported++
        } else {
          result.errors.push(`Ingestion failed for: ${title}`)
        }
      } catch (err) {
        result.errors.push(`Failed to import: ${String(convo.title || 'unknown')}`)
      }
    }

    console.log(`[Import] ChatGPT: ${result.conversationsImported} conversations imported`)
  } catch (err) {
    result.errors.push(`Parse error: ${String(err)}`)
  }

  return result
}

// ── OpenClaw importer ─────────────────────────────────────────
// Walks an OpenClaw workspace directory, ingests every .md file
// into the Knowledge Base, and copies memory/lessons files into
// workspace/memory/ so Aiden can surface them during planning.

function findMdFiles(dir: string): string[] {
  const files: string[] = []
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        files.push(...findMdFiles(fullPath))
      } else if (entry.name.endsWith('.md')) {
        files.push(fullPath)
      }
    }
  } catch {}
  return files
}

export async function importOpenClaw(directoryPath: string): Promise<ImportResult> {
  const result: ImportResult = {
    source:                'openclaw',
    conversationsImported: 0,
    memoriesExtracted:     0,
    errors:                [],
  }

  if (!fs.existsSync(directoryPath)) {
    result.errors.push(`Directory not found: ${directoryPath}`)
    return result
  }

  const mdFiles = findMdFiles(directoryPath)

  for (const file of mdFiles) {
    try {
      const content = fs.readFileSync(file, 'utf8')
      if (content.trim().length < 50) continue  // skip empty/trivial files

      const basename = path.basename(file, '.md')
      const lower    = file.toLowerCase()
      const isMemory = lower.includes('memory')
      const isLesson = lower.includes('lesson')
      const isDaily  = /\d{4}[-_]\d{2}[-_]\d{2}/.test(basename)

      const category = isMemory ? 'memory'
        : isLesson               ? 'lessons'
        : isDaily                ? 'daily-log'
        : 'document'

      const filename = `openclaw_${basename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)}.md`

      const ingestResult = knowledgeBase.ingestText(
        content.substring(0, 50000),
        filename,
        category,
        ['openclaw', 'imported', category],
        'public',
      )

      if (ingestResult.success) {
        result.conversationsImported++
      } else {
        result.errors.push(`Ingestion failed: ${basename}`)
      }

      // Copy memory and lesson files into workspace/memory/ so the
      // memory recall system can surface them during planning
      if (isMemory || isLesson) {
        try {
          fs.mkdirSync(MEMORY_DIR, { recursive: true })
          const destName = `imported_${basename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)}.md`
          const destPath = path.join(MEMORY_DIR, destName)
          // Only write if not already present (avoid duplicate on re-import)
          if (!fs.existsSync(destPath)) {
            fs.writeFileSync(
              destPath,
              `<!-- source: openclaw_import | confidence: 0.7 -->\n${content}`,
              'utf8',
            )
            result.memoriesExtracted++
          }
        } catch (memErr) {
          result.errors.push(`Memory copy failed: ${basename} — ${String(memErr)}`)
        }
      }
    } catch (err) {
      result.errors.push(`Failed: ${path.basename(file)}`)
    }
  }

  console.log(
    `[Import] OpenClaw: ${result.conversationsImported} files ingested, ` +
    `${result.memoriesExtracted} memories extracted`,
  )

  return result
}
