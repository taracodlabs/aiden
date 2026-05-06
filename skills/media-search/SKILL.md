---
name: media-search
description: Find and play music/videos via web_search + open_url
category: media
version: 1.0.0
origin: aiden
license: Apache-2.0
tags: music, video, youtube, play, song, listen, media, autoplay
required_tools: [web_search, open_url]
---

# Media Search & Play

Resolve "play X" / "listen to X" / "find me a song" requests by chaining
`web_search` → `open_url` to a specific autoplay-friendly URL. The user
hears the song in their default browser without you having to drive a
controlled browser session.

## REQUIRED tool sequence (read this first)

Every successful run of this skill calls **exactly two** tools, in order:

1. `web_search` — exactly **once**.
2. `open_url` — exactly **once** (with a `youtube.com/watch?v=` URL).

Then you report. **A run that stops after `web_search` is a FAILED run** —
the user does not hear anything until `open_url` fires. Do NOT report
"I found the song" or "now playing" without calling `open_url` first;
that is a fabrication this skill specifically exists to prevent.

Anti-patterns the planner sometimes drifts into — do NOT do these:

- ❌ Calling `web_search` twice "to be sure" — pick the first
  `/watch?v=` URL from the first call and move on.
- ❌ Re-entering the `media_search` skill mid-run after `web_search`
  returned. The skill is already loaded; re-viewing it wastes a turn
  and signals a hung agent. Just call `open_url`.
- ❌ Stopping after the search and asking the user to confirm. The
  user's "play me a song" request is the consent — proceed to
  `open_url`.

## When to use

The user's request matches any of these patterns:

- **Direct play:** "play Despacito", "play Bohemian Rhapsody"
- **Fuzzy play:** "play me a popular song", "play something upbeat",
  "play a sad song"
- **Listen intent:** "I want to listen to jazz", "put on some music"
- **Video intent:** "show me the latest Marvel trailer", "play that
  cooking video about ramen"

If the user says "open spotify" or "open youtube" without a specific
piece, that's an `open_url` direct call — not this skill.

## How to use

### Specific song or video (artist + title given)

1. **CALL `web_search`** for `<title> youtube watch` (the literal
   `youtube watch` keywords bias results toward YouTube `/watch?v=` URLs).
2. **PARSE the search results** — find the FIRST result whose URL
   contains `youtube.com/watch?v=`. Skip channel pages, playlists, and
   `/results?` URLs — they don't autoplay reliably. This is a parse
   step inside your reasoning; it does not call any tool.
3. **CALL `open_url`** with that watch URL — exactly once. YouTube's
   `/watch?v=` pages autoplay in the user's browser (no click needed).
   This step is REQUIRED. Do not skip it.
4. **Report**: "Now playing: `<video title>` — `<url>`"

### Fuzzy intent (no specific title)

The user said "popular song" or "something upbeat" — they expect you
to PICK a real song, not search verbatim.

1. **Substitute** the fuzzy phrase with a current chart-topper or genre
   exemplar. Examples:
   - "popular song" → search `Billboard Hot 100 #1 youtube watch`
     OR pick a known chart-topper for the current week
   - "something upbeat" → pick a known dance/pop track
   - "sad song" → pick a known ballad
   - "jazz" → pick a known standard ("Take Five", "So What", etc.)
2. Then run the specific-song flow above.
3. In the report, **note your choice transparently**: "I picked '<title>'
   because <reason>. Now playing: <url>"

### Fallback: no `/watch?v=` in search results

If the top 3 search results don't have a `youtube.com/watch?v=` URL:

1. `open_url` to `https://www.youtube.com/results?search_query=<query>`
   (URL-encoded).
2. Report **honestly**: "Opened YouTube to results for `<query>` — autoplay
   doesn't fire on results pages, so click a video to start playback."
   Do NOT claim "now playing" — that would be fabrication.

## Examples

### Example 1 — fuzzy intent

User prompt: "play me a popular song"

Expected flow:
- Aiden runs: `web_search("Billboard Hot 100 #1 song this week youtube watch")`
- Aiden picks first `/watch?v=` result, e.g.
  `https://www.youtube.com/watch?v=abc123` titled "Espresso — Sabrina Carpenter"
- Aiden runs: `open_url("https://www.youtube.com/watch?v=abc123")`
- Aiden reports: "I picked 'Espresso' by Sabrina Carpenter — currently
  #1 on Billboard Hot 100. Now playing in your browser."

### Example 2 — specific title

User prompt: "play Despacito"

Expected flow:
- Aiden runs: `web_search("Despacito youtube watch")`
- Aiden picks first `/watch?v=` result (the official video, billions of views)
- Aiden runs: `open_url("https://www.youtube.com/watch?v=kJQP7kiw5Fk")`
- Aiden reports: "Now playing: Luis Fonsi — Despacito ft. Daddy Yankee
  (Official Video)."

### Example 3 — fallback to results page

User prompt: "play that lo-fi beats stream"

Expected flow:
- Aiden runs: `web_search("lo-fi beats live stream youtube watch")`
- Top 3 results are channel pages (`/c/lofigirl`), not `/watch?v=`
- Aiden runs: `open_url("https://www.youtube.com/results?search_query=lo-fi+beats+live+stream")`
- Aiden reports: "Opened YouTube search for lo-fi beats live streams —
  click any to start; results pages don't autoplay."

## Cautions

- **Never call `open_url` more than once per request.** If the first
  call succeeded, the URL is open in the user's browser. Re-launching
  is duplicate noise.
- **`/watch?v=` autoplays; `/results?` and `/c/` do NOT.** Only claim
  "now playing" when you launched a watch URL.
- **Don't search verbatim for fuzzy phrases.** "popular song" verbatim
  returns articles ABOUT popular songs, not the songs themselves. The
  whole point of this skill is to substitute fuzzy → specific BEFORE
  searching.
- **No Spotify integration in v4.0.** If the user explicitly asks for
  Spotify ("play X on spotify"), tell them: "Spotify integration ships
  in v4.1. For now I can open the song on YouTube instead — want me
  to?"

## Requirements

- `web_search` tool (always available — registered at boot)
- `open_url` tool (always available, BUILTIN_SAFE_TOOLS, auto-approves)
- The user's default browser must be installed (every desktop has one).
- No API keys, no credentials, no plugins.
