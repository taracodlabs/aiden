// core/statusVerbs.ts — Rotating verb vocabulary for streaming status events.
// Phase 2: rotating status verbs while a turn streams — keeps Aiden feeling alive.

export const STATUS_VERBS: Record<string, string[]> = {
  thinking: [
    'Pondering...', 'Thinking...', 'Mulling it over...', 'Figuring this out...',
    'Reasoning through...', 'Working it out...', 'On it...',
    'Processing...', 'Considering...'
  ],
  searching: [
    'Hunting...', 'Searching...', 'Digging...', 'Looking it up...',
    'Scouring the web...', 'On the hunt...', 'Tracking it down...',
    'Scanning...', 'Fetching...'
  ],
  reading: [
    'Reading...', 'Skimming...', 'Studying...', 'Going through this...',
    'Checking...', 'Scanning the page...', 'Absorbing...'
  ],
  coding: [
    'Coding...', 'Writing the script...', 'Crafting...', 'Building...',
    'Scripting...', 'Putting it together...', 'Tinkering...',
    'Hammering it out...'
  ],
  browsing: [
    'Opening...', 'Navigating...', 'Pulling up...', 'Launching...',
    'Loading the page...', 'Heading there now...'
  ],
  writing: [
    'Writing...', 'Composing...', 'Crafting your response...',
    'Putting this together...', 'Almost done...', 'Wrapping up...'
  ],
  tooling: [
    'Working on it...', 'Handling this...', 'Running the tool...',
    'Executing...', 'Taking care of it...'
  ],
}

export function getVerb(action: string): string {
  const verbs = STATUS_VERBS[action] ?? STATUS_VERBS.tooling
  return verbs[Math.floor(Math.random() * verbs.length)]
}
