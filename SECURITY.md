# Security Policy

## Reporting a Vulnerability

**Preferred:** Use GitHub Private Vulnerability Reporting:
https://github.com/taracodlabs/aiden/security/advisories/new

This gives us a private thread, attachment support, and proper tracking.

**Email backup:** contact@taracod.com (monitored daily)

**Please do not open a public GitHub issue for security vulnerabilities.**

Email **contact@taracod.com** with:

- **Affected version** (from `aiden --version` or the About dialog)
- **Reproduction steps** — the minimal sequence of actions to trigger the issue
- **Potential impact** — what an attacker could achieve by exploiting this

You will receive an acknowledgment within **7 business days**. We prefer **coordinated disclosure**: please allow us reasonable time to patch before public disclosure. We will credit researchers in the release notes unless you prefer to remain anonymous.

---

## Supported Versions

Only the **latest minor version** receives security fixes. Older versions are not patched.

| Version | Supported |
|---------|-----------|
| v4.0.x  | ✅ Yes    |
| < v4.0  | ❌ No     |

If you are on an older version, upgrade first to confirm the issue is still present before reporting.

---

## Out of Scope

The following are **not** considered security vulnerabilities in Aiden:

- Vulnerabilities in **third-party dependencies** — please report these directly upstream (npm, GitHub advisories, etc.)
- Issues that require **physical access** to the machine running Aiden
- **Denial of service via resource exhaustion** on the user's own machine (Aiden runs locally with full trust)
- Behaviour that requires the attacker to already have **local admin rights** on the same machine
- Issues in **skills contributed by third parties** (report to the skill author)

---

## Security Design Notes

Aiden runs entirely on your local machine. By default:

- No telemetry is sent without explicit configuration
- API keys are stored in your local `.env` file, never transmitted to Taracod servers
- The API server and dashboard (`localhost:4200`) are bound to loopback only and not exposed to the network unless you explicitly bind to `0.0.0.0`
- The OpenAI-compatible API at `localhost:4200/v1` accepts unauthenticated requests by default (loopback-only); set `AIDEN_API_KEY` to require Bearer-token auth
- Shell execution and browser automation require explicit user commands — Aiden does not run arbitrary code autonomously without a user prompt
- A 10-module security moat (`moat/`) gates every tool call: tiered approval engine (safe / caution / dangerous), dangerous-command pattern classifier, SSRF-safe URL fetcher, secret/PII pre-write scanner, honesty enforcement post-loop scan, memory guard, planner-guard tool narrowing
- OAuth tokens for Claude Pro and ChatGPT Plus subscriptions are stored at `<aiden-home>/auth/<provider>.json` with 0600 file mode; never transmitted to Taracod servers

If you configure cloud provider API keys (OpenAI, Anthropic, Groq, etc.), requests to those providers are subject to their respective privacy policies.
