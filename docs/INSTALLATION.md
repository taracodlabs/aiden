# Installing Aiden

## Get Started in 2 Minutes

```bash
# 1. Install
npm install -g aiden

# 2. Setup (~30 seconds)
aiden setup
# Pick "Together AI" when prompted, paste API key from together.ai

# 3. Run
aiden

# 4. Try something
> play me a popular song
```

That's it. You should hear music in your browser within 90 seconds of step 1.

For OAuth providers (ChatGPT Plus, Claude Pro), see [OAuth Setup](#oauth-setup) below. For advanced configuration, see [Advanced Setup](#advanced-setup) below.

---

## Advanced Setup

Aiden ships as an npm package. **Node 20.x or 22.x** (LTS) is required on every platform.

```bash
# Verify your Node version first.
node --version
```

If you don't have Node 20+, install it from [nodejs.org](https://nodejs.org/) or via your platform's package manager (sections below).

After install, run `aiden setup` to pick a provider and configure credentials. The setup wizard walks you through API-key and OAuth options.

---

## Windows

```powershell
npm install -g aiden
aiden setup
aiden
```

Aiden's user-data lives at `%LOCALAPPDATA%\aiden\` (e.g. `C:\Users\<you>\AppData\Local\aiden\`).

**Optional — Chrome for the CDP plugin:**
The bundled `aiden-plugin-cdp-browser` lets the agent control your real Chrome (used by the "play me a song" media-playback flow). Install Google Chrome from [google.com/chrome](https://www.google.com/chrome/) if not already present. Aiden auto-detects Chrome / Chromium / Brave / Edge in standard install paths.

**If `aiden` isn't found after install**, your global `npm bin` directory may not be on PATH. Print it with `npm config get prefix` and add `<prefix>` (PowerShell) or `<prefix>\bin` to your user PATH.

---

## macOS

```bash
# Install Node via Homebrew (recommended) or nodejs.org.
brew install node

npm install -g aiden
aiden setup
aiden
```

Aiden's user-data lives at `~/Library/Application Support/aiden/`.

**Optional — Chrome for the CDP plugin:**
Install Google Chrome from [google.com/chrome](https://www.google.com/chrome/). Aiden auto-detects Chrome / Chromium / Brave / Edge from `/Applications/`.

**If `npm install -g` fails with EACCES**, your Homebrew Node has a writeable global prefix; for system Node use a node-version manager (`nvm` / `volta`) or `sudo` (not recommended).

---

## Linux

```bash
# Install Node 20+ — varies by distribution.
# Ubuntu / Debian:
sudo apt install -y nodejs npm
# Or, for the latest LTS:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Arch:
sudo pacman -S nodejs npm

# Fedora:
sudo dnf install -y nodejs

npm install -g aiden
aiden setup
aiden
```

Aiden's user-data lives at:
- `$XDG_CONFIG_HOME/aiden/` if `XDG_CONFIG_HOME` is set, otherwise
- `~/.config/aiden/` (default per freedesktop spec).

If you're upgrading from a pre-XDG install at `~/.aiden/`, Aiden auto-detects and keeps using the legacy directory. To migrate, move the directory: `mv ~/.aiden ~/.config/aiden`.

**Optional — Chrome for the CDP plugin:**
Aiden's CDP plugin auto-detects the following on Linux:
- `apt` users: `sudo apt install google-chrome-stable` (binary at `/usr/bin/google-chrome-stable`).
- Snap (Ubuntu 22.04+): `sudo snap install chromium` (binary at `/snap/bin/chromium`).
- Flatpak: `flatpak install flathub com.google.Chrome` (binary at `/var/lib/flatpak/exports/bin/com.google.Chrome`).
- Arch (yay): `yay -S google-chrome`.
- Fedora (dnf): `sudo dnf install google-chrome-stable` (after enabling Google's RPM repo).

If no Chrome-family binary is found, the CDP plugin surfaces a clear "Install Google Chrome and re-run /plugins grant aiden-plugin-cdp-browser" message.

**If you see permission errors on `npm install -g`**, configure npm's prefix to a user-writable location:
```bash
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

---

## Override the user-data root

`AIDEN_HOME` env var overrides the platform default on every OS. Useful for portable installs, dev VMs, or shared profiles.

```bash
export AIDEN_HOME=/path/to/your/aiden-data
aiden
```

---

## Troubleshooting common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| `aiden: command not found` after `npm install -g` | `npm bin` dir not on PATH | Print `npm config get prefix` and add to PATH. |
| `cannot find module 'chrome-remote-interface'` | npm install was incomplete | Re-run `npm install -g aiden`. |
| `[plugins] aiden-plugin-cdp-browser: pending grant` on boot | First-run state — expected | Run `/plugins grant aiden-plugin-cdp-browser` once. |
| OAuth login (Claude Pro / ChatGPT Plus) fails with "Missing client_id" or "Workspaces not found" | Upstream / account-state issue (see Phase 18.1 diagnostic) | OAuth providers are **beta in v4.0**. Use API-key auth via `aiden setup`, or pick a different provider with `/model`. |
| `Error: EACCES` on Linux during `npm install -g` | System Node's global prefix is root-owned | See the user-prefix snippet in the Linux section. |
| Aiden boots but `[skills] 0 loaded` | Bundled skills missing from install | Re-run `npm install -g aiden`. The package ships ~72 skills under `skills/`; confirm with `ls $(npm root -g)/aiden/skills`. |

---

## Verifying the install

```bash
aiden doctor    # Diagnoses provider, paths, plugins, skills
aiden --version # Should print 4.0.x
```

Boot output you should see (paraphrased):
```
✓ Aiden v4.0.0 ready
[skills] 72 loaded, 0 skipped
[plugins] N loaded · M pending grant · 0 suspended
```

If `[plugins]` shows pending-grant entries, run `/plugins grant <name>` for each.
