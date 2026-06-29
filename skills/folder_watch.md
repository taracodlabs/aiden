---
name: folder_watch
description: Watch folders for new files and automate reactions
version: 1.0.0
---

# Folder Watch Skill

tags: watch, folder, files, automation, downloads, monitor

## When to use
- User says "whenever a new file appears in X, do Y"
- User says "watch my Downloads folder"
- User says "monitor a folder"
- User wants automatic file categorisation or processing

## Tools
- `watch_folder` — Start watching a folder; when a new file appears, Aiden executes the given goal
- `watch_folder_list` — Show all active folder watchers

## Inputs for watch_folder
| Field    | Required | Description |
|----------|----------|-------------|
| `folder` | yes      | Absolute path or `%USERPROFILE%\Downloads` style |
| `goal`   | yes (unless `stop: true`) | Natural language goal to run when a new file arrives |
| `stop`   | no       | Set `true` to stop watching the folder |

## Examples

### Watch Downloads, summarise every new PDF
```json
{
  "tool": "watch_folder",
  "input": {
    "folder": "%USERPROFILE%\\Downloads",
    "goal": "If the new file is a PDF, read it and send a desktop notification with a one-sentence summary"
  }
}
```

### Watch a work inbox folder
```json
{
  "tool": "watch_folder",
  "input": {
    "folder": "C:\\Users\\<you>\\Documents\\Inbox",
    "goal": "Move the new file to the correct subfolder based on its name and extension"
  }
}
```

### Stop watching a folder
```json
{
  "tool": "watch_folder",
  "input": {
    "folder": "%USERPROFILE%\\Downloads",
    "stop": true
  }
}
```

### List active watchers
```json
{ "tool": "watch_folder_list", "input": {} }
```

## Approach
1. Resolve the folder path (expand `%USERPROFILE%` / `~`)
2. Confirm the folder exists before starting
3. Set up the watcher with a clear, actionable goal
4. Inform the user what will happen and how to stop it (`stop: true`)
5. Use `watch_folder_list` to verify or audit active watchers

## Notes
- Watchers are in-process; they stop if Aiden/the API server is restarted
- `watch_folder` on an already-watched path replaces the previous watcher
- The 500 ms delay after a `rename` event gives the OS time to finish writing the file
- Only reacts to files (not subdirectory creation)
