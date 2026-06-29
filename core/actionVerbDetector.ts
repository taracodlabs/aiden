// Detects whether a user message expresses an action intent (vs. a question or
// conversational turn). Used by the PlannerGuard to reject respond-only plans
// that were generated in response to clear action requests.
//
// Anchored at start of message, allows optional polite prefixes and leading
// whitespace. Add new verbs here — keep sorted for readability.

const ACTION_VERB_RE =
  /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?(append|capture|close|copy|delete|download|edit|execute|fetch|forget|get|kill|launch|lock|move|mute|note|open|pause|play|prepend|read|reboot|record|remember|remind|remove|rename|replace|restart|resume|run|save|schedule|screenshot|send|set\s+timer|shutdown|skip|speak|start|stop|store|track|transcribe|unlock|unmute|upload|volume|write)\b/i

export function isActionIntent(message: string): boolean {
  return ACTION_VERB_RE.test(message)
}

// Narrower set: verbs that specifically mean "persist to Aiden's memory system".
// Used by MemoryGuard to override wrong-tool plans (e.g. file_write) for memory intents.
const MEMORY_VERB_RE =
  /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?(remember|track|note|store|keep\s+track|forget|remove\s+from\s+memory|delete\s+from\s+memory)\b/i

export function isMemoryIntent(message: string): boolean {
  return MEMORY_VERB_RE.test(message)
}

/** Extract the fact payload from a memory-intent message.
 *  Strips the leading verb+prefix and returns the remainder, trimmed.
 *  Falls back to the full message if no verb is stripped. */
export function extractMemoryFact(message: string): string {
  return message
    .replace(/^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:remember|track|note|store|keep\s+track\s+of?|forget|forget\s+about|remove\s+from\s+memory|delete\s+from\s+memory)\b[:—\s]*/i, '')
    .trim() || message.trim()
}

// C11: Narrow subset of memory verbs that mean "delete from memory".
const FORGET_VERB_RE =
  /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?(forget|remove\s+from\s+memory|delete\s+from\s+memory)\b/i

export function isForgetIntent(message: string): boolean {
  return FORGET_VERB_RE.test(message)
}

export function detectActionVerb(message: string): string {
  const m = message.match(ACTION_VERB_RE)
  return m ? m[1].replace(/\s+/g, ' ').toLowerCase() : ''
}

/*
 * Unit assertions (run manually: npx tsx core/actionVerbDetector.ts)
 *
 * Expect true:
 *   isActionIntent('open notepad')              // bare verb
 *   isActionIntent('please open notepad')       // polite prefix
 *   isActionIntent('can you launch chrome')     // can you
 *   isActionIntent('could you mute')            // could you
 *   isActionIntent('screenshot')                // single word
 *   isActionIntent('set timer for 5 minutes')   // two-word verb
 *   isActionIntent('  volume up')               // leading whitespace
 *   isActionIntent('Close all windows')         // capitalised
 *   isActionIntent('remember my color is purple')  // C5: memory verb
 *   isActionIntent('track my water intake')        // C5: memory verb
 *   isActionIntent('note that my name is Alex')    // C5: memory verb
 *   isActionIntent('store this fact')              // C5: memory verb
 *
 * Expect false:
 *   isActionIntent('what can you do')           // question — no action verb at start
 *   isActionIntent("what's 2+2")                // math question
 *   isActionIntent('tell me about open source') // 'open' not at intent position
 *   isActionIntent('how do I start a project')  // 'start' after 'how do I'
 *   isActionIntent('')                          // empty
 *   isActionIntent('remembered yesterday I bought milk') // C5: past-tense narrative — anchor prevents match
 */
