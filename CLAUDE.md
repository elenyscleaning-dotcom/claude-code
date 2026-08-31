# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is the public-facing repository for Claude Code (the CLI), not its implementation. **The CLI source code is not here** — the product ships via installer/npm. What lives here:

- `CHANGELOG.md` + `feed.xml` — release notes, published as an Atom feed
- `plugins/` + `.claude-plugin/marketplace.json` — the bundled plugin marketplace
- `examples/` — settings, MDM deployment templates, LLM gateway (Terraform), hook examples
- `scripts/` + `.github/workflows/` — issue-tracker automation for the GitHub repo
- `.claude/commands/` — slash commands that the CI workflows invoke

There is no root `package.json`, build, test suite, or linter. Most changes are Markdown/JSON/YAML, and correctness is verified by reading, not by running a test.

## Running the automation scripts

`scripts/*.ts` run under **Bun** (workflows install it via `oven-sh/setup-bun`), not Node:

```bash
bun run scripts/sweep.ts --dry-run   # preview lifecycle enforcement; omit the flag to act
bun run scripts/auto-close-duplicates.ts
GITHUB_TOKEN=... GITHUB_REPOSITORY_OWNER=... GITHUB_REPOSITORY_NAME=... bun run scripts/sweep.ts
```

All of them require `GITHUB_TOKEN`; most also read `GITHUB_REPOSITORY_OWNER` / `GITHUB_REPOSITORY_NAME`. The `.sh` scripts read the issue number from the workflow event payload (`GITHUB_EVENT_PATH`), so they only run meaningfully inside Actions.

## Architecture

### Issue lifecycle automation

`scripts/issue-lifecycle.ts` is the **single source of truth** for label names, timeout days, close reasons, and nudge text (`invalid` 3d, `needs-repro`/`needs-info` 7d, `stale`/`autoclose` 14d, plus `STALE_UPVOTE_THRESHOLD`). Change policy there, never in the consumers:

- `sweep.ts` (cron, 2x/day) — marks stale, escalates to `autoclose`, closes past-timeout issues
- `lifecycle-comment.ts` (on `issues: labeled`) — posts the nudge for whichever label was applied
- `remove-autoclose-label.yml` / `lock-closed-issues.yml` — reverse the flow on human activity, lock 7 days after close
- `auto-close-duplicates.ts`, `backfill-duplicate-comments.ts` — duplicate handling

### Claude running in CI (the sandboxed-tool pattern)

`claude.yml`, `claude-dedupe-issues.yml`, and `claude-issue-triage.yml` run `anthropics/claude-code-action@v1` with a `prompt` of `/dedupe …` or `/triage-issue …`, which resolves to the matching file in `.claude/commands/`. Auth is Workload Identity Federation (`anthropic_federation_rule_id` / `anthropic_organization_id` vars + `id-token: write`), not a static API key.

These commands deliberately run with a *very* narrow tool surface, and that design is the thing to preserve when editing them:

- `scripts/gh.sh` is an allowlisting wrapper over `gh`: only `issue view`, `issue list`, `search issues`, `label list`, and only the `--comments/--state/--limit/--label` flags. Everything is scoped to `GH_REPO`/`GITHUB_REPOSITORY`.
- `edit-issue-labels.sh` and `comment-on-duplicates.sh` take **no issue number** — it is read from the event payload so a prompt-injected issue body cannot retarget another issue.
- `CLAUDE_CODE_SCRIPT_CAPS` in the workflow (e.g. `'{"edit-issue-labels.sh":2}'`) caps how many times a script may be invoked per run.

So: to give a command a new capability, extend the wrapper's allowlist — do not loosen `allowed-tools` to raw `gh`, `WebFetch`, or file edits. Adding `allowed_non_write_users` to any workflow trips `non-write-users-check.yml`, which comments a security warning on the PR.

### Plugins

Each plugin is self-contained under `plugins/<name>/` with `.claude-plugin/plugin.json` plus optional `commands/`, `agents/`, `skills/<name>/SKILL.md`, and `hooks/hooks.json`. Hook commands reference files via `${CLAUDE_PLUGIN_ROOT}`; Python-based plugins (`hookify`, `security-guidance`) ship their own module tree and a `sh` shim to pick an interpreter.

Adding or renaming a plugin means updating **three** places, which drift easily:
1. the plugin's own `.claude-plugin/plugin.json` (note: `plugin-dev` currently has none)
2. the `plugins` array in `/.claude-plugin/marketplace.json`
3. the table in `plugins/README.md`

`hookify` is the most code-heavy plugin: `core/config_loader.py` parses user rules from `.claude/hookify.*.local.md`, `core/rule_engine.py` evaluates them against hook input, and the per-event entrypoints in `hooks/` are thin wrappers over that engine.

### CHANGELOG and feed.xml

These are updated together by release automation (`chore: Update CHANGELOG.md and feed.xml` commits) and must stay in sync — `feed.xml` mirrors each `CHANGELOG.md` version as an Atom entry. Prefer not to hand-edit them.

## Repo-specific gotchas

- `.gitattributes` forces LF endings on everything, including `*.sh`.
- `scripts/comment-on-duplicates.sh` hardcodes `REPO="anthropics/claude-code"` for the links it posts, unlike the other scripts which take the repo from the environment.
- `.github/workflows/python-package-conda.yml` runs on every push but expects an `environment.yml` that does not exist in this repo, so it fails; it is unrelated to the rest of the automation.
