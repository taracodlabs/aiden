# Running the Aiden daemon on Windows

The v4.5 daemon foundation works on Windows the same as Linux/macOS —
file watchers, webhook triggers, email IMAP polling, and the daemon
HTTP API all function identically. What's **different** on Windows is
how you keep the daemon **alive across reboots and logouts**.

On Linux/macOS, `aiden daemon install` writes a systemd / launchd unit
that the OS auto-restarts. **There is no equivalent auto-installer in
Aiden v4.5 for Windows** — the variance across NSSM, the Service
Control Manager, Task Scheduler, plus the admin-privilege requirements,
makes a one-button auto-installer too risky to ship.

Pick one of the patterns below.

---

## Option 1 — Foreground (zero install)

The simplest path. Open a PowerShell window and run:

```powershell
$env:AIDEN_DAEMON = "1"
aiden daemon start
```

`aiden daemon start` brings up the internal supervisor (Phase 1
`startSupervisor`). The supervisor spawns the actual daemon child,
watches it, and respawns with exponential backoff on non-graceful
exit. Closing the window stops everything.

This is good for development + occasional use. It does NOT survive
logout or reboot.

---

## Option 2 — `pm2` (recommended for "always on")

[`pm2`](https://pm2.keymetrics.io/) is a battle-tested Node process
manager. It handles auto-restart, log rotation, and Windows
"start-on-login" registration cleanly.

```powershell
npm install -g pm2 pm2-windows-startup
pm2-startup install                                    # registers pm2 with Task Scheduler
pm2 start aiden --name aiden-daemon -- daemon start
pm2 save                                               # persist process list
```

To check status / view logs:

```powershell
pm2 status
pm2 logs aiden-daemon
```

To remove:

```powershell
pm2 stop aiden-daemon
pm2 delete aiden-daemon
pm2 save
```

`pm2` survives reboot once `pm2-startup install` has been run.

---

## Option 3 — NSSM (Windows Service wrapper)

[NSSM](https://nssm.cc/) wraps any executable as a Windows Service.
Requires admin rights to install + manage services.

```powershell
# As Administrator:
nssm install AidenDaemon "C:\path\to\node.exe" "C:\path\to\aiden\dist-bundle\index.js"
nssm set    AidenDaemon AppEnvironmentExtra `
            "AIDEN_DAEMON=1" `
            "AIDEN_DAEMON_AUTO_RESTART=0"
nssm set    AidenDaemon AppStdout       "C:\Users\<you>\AppData\Local\aiden\logs\daemon.out.log"
nssm set    AidenDaemon AppStderr       "C:\Users\<you>\AppData\Local\aiden\logs\daemon.err.log"
nssm set    AidenDaemon AppRotateFiles  1
nssm set    AidenDaemon Start           SERVICE_AUTO_START
nssm start  AidenDaemon
```

To check / restart / remove:

```powershell
nssm status   AidenDaemon
nssm restart  AidenDaemon
nssm stop     AidenDaemon
nssm remove   AidenDaemon confirm
```

`AIDEN_DAEMON_AUTO_RESTART=0` disables Aiden's internal supervisor
since NSSM is now doing supervision externally. Without that flag
you'd end up with supervisor-in-supervisor recursion (NSSM restarts
the supervisor, supervisor restarts the daemon).

---

## Option 4 — Task Scheduler (built-in, no extra install)

Windows Task Scheduler can run the daemon at login. The downside is
that the daemon runs in the user session (so it stops if you log out
without "Run whether user is logged on or not" + a stored password).

Create the task via PowerShell:

```powershell
$action  = New-ScheduledTaskAction `
            -Execute  "C:\path\to\node.exe" `
            -Argument "C:\path\to\aiden\dist-bundle\index.js"
$trigger = New-ScheduledTaskTrigger -AtLogon
$settings = New-ScheduledTaskSettingsSet `
            -ExecutionTimeLimit (New-TimeSpan -Days 0) `
            -RestartOnFailure -RestartInterval (New-TimeSpan -Minutes 1) `
            -RestartCount 5
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive
$env:AIDEN_DAEMON = "1"   # ensure the task inherits this
Register-ScheduledTask -TaskName "AidenDaemon" `
            -Action $action -Trigger $trigger -Settings $settings -Principal $principal
```

To check / remove:

```powershell
Get-ScheduledTask -TaskName AidenDaemon
Stop-ScheduledTask  -TaskName AidenDaemon
Unregister-ScheduledTask -TaskName AidenDaemon -Confirm:$false
```

---

## `aiden daemon` CLI behavior on Windows

| Command | Behavior |
|---|---|
| `aiden daemon install`   | Prints this guidance + exits 0. Does NOT write any system unit. |
| `aiden daemon uninstall` | Reports nothing-to-do (no auto-install path). |
| `aiden daemon start`     | Runs the internal supervisor (Phase 1 `startSupervisor`) in the foreground. |
| `aiden daemon stop`      | Sends SIGTERM to the PID in `runtime.lock`. (Node's SIGTERM polyfill on Windows is a forced kill — graceful drain still runs because the daemon's own SIGTERM handler is installed by the foundation.) |
| `aiden daemon restart`   | SIGUSR1 is not available on Windows — falls back to **stop + sleep 2s + spawn detached**. |
| `aiden daemon status`    | Queries `http://127.0.0.1:<AIDEN_DAEMON_PORT>/api/daemon/status`. |
| `aiden daemon logs`      | Prints a "log destination unknown" notice. Logs come from whatever wrapper you used (pm2 logs, NSSM stdout file, Task Scheduler doesn't capture stdout by default). |

---

## Picking between options

- Dev / occasional use → **Option 1 (foreground)**.
- Personal machine, want always-on but don't want admin rights → **Option 2 (`pm2`)**.
- Server / shared workstation with admin rights, want a proper service → **Option 3 (NSSM)**.
- Single-user desktop, want simplest "start at login" without extra installs → **Option 4 (Task Scheduler)**.

`AIDEN_DAEMON_BIND` (default `127.0.0.1`) controls which interface the
daemon HTTP server binds to. **Leave it at loopback** unless you have
a specific need for remote access AND have set `AIDEN_API_KEY`
(refusal-to-start guard from Phase 3 will block public bind without
an API key).
