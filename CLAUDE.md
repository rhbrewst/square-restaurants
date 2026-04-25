# Claude Code — project instructions

**Read [ARCHITECTURE.md](ARCHITECTURE.md) before making non-trivial changes.** It describes the call lifecycle, module layout, DB schema, external services, and invariants that are easy to break.

**Keep ARCHITECTURE.md current.** If your change alters any of the following, update that doc in the same commit:

- Call flow or module boundaries
- DB schema, triggers, NOTIFY channels, or pg_cron jobs
- External services or required environment variables
- Any invariant listed in §7 of that doc
- Phase status in §8

Stale architecture docs are worse than none. If the code and the doc disagree, the code wins — fix the doc.

## Other references in this repo

- **[PRODUCTION_PLAN.md](PRODUCTION_PLAN.md)** — the task-by-task playbook for phases 1–6. Describes the *plan*, not the current state.
- **[KNOWN_ISSUES.md](KNOWN_ISSUES.md)** — bugs and design limitations that are surfaced and understood but not yet fixed. **Check this before filing or fixing a bug** — the entry's "Fix sketch" may already exist. When a fix lands, the PR deletes the entry in the same diff.
- **[README.md](README.md)** — first-time setup (accounts, env vars, dev loop).
