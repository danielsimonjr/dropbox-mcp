# dropbox

Developer notes for a private skill. Not published to the marketplace.

## Purpose

Bidirectional cloud↔local sync, loose-file sorting, deduplication, and `.dropboxignore` installation for any Dropbox folder under `~/Dropbox/`.

Replaces the previous per-folder scripts at `~/.claude/playground/misc_organize/` (kept for historical reference).

## Files

| File | Purpose |
|---|---|
| `SKILL.md` | Skill definition, workflow recipes, when-to-use guidance |
| `scripts/dbx_sync.py` | **Primary tool** — bidirectional sync CLI |
| `scripts/categorize.py` | Sonnet-categorize loose PDFs at `/Misc` root into existing subdirs |
| `scripts/execute.py` | Apply moves per `plan.json` (collision-safe) |
| `scripts/reconcile_cloud_dupes.py` | Promote `(cloud)`-suffixed larger PDFs to canonical names |
| `scripts/sync_final_followups.py` | Recipe template — move + download + `.dropboxignore` install |

## Triggers

Auto-loads on user queries mentioning:
- "sync dropbox", "dropbox sync", "fix dropbox drift"
- "my dropbox isn't syncing"
- "force-download cloud files"
- "sort files in /Misc", "categorize loose files"
- "remove dropbox duplicates", "reconcile cloud dupes"
- "add .dropboxignore"

Explicit slash trigger: `/dropbox`.

## Authentication

Reads `~/.claude/channels/dropbox/.env` for `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` — same setup as `dropbox-mcp`. If missing, run `python ~/.claude/channels/dropbox/get_refresh_token.py` interactively (one-time browser auth).

## Install / sync

```bash
# Canonical home is this folder. To install or update the live skill:
cp -rf ~/Dropbox/Github/skills/dropbox/* ~/.claude/skills/dropbox/
```

## Provenance

Built across 2026-06-06 and 2026-06-07 to recover a 225-file drift in `/Misc` (Dropbox client had stalled silently for weeks) and then bidirectionally sync `/Team DC` (43 subdirs, 3,927 files, mostly clean). Patterns proven on those folders and consolidated into `dbx_sync.py`.

## Related

- **`dropbox-mcp` plugin** — atomic operations: `dropbox_search`, `dropbox_file_info`, `dropbox_download`, `dropbox_list_revisions`, `dropbox_list_deleted`, `dropbox_restore`, `dropbox_restore_batch`, `dropbox_restore_revision`. **Complementary, not redundant** — SKILL.md carries the full "scripts vs. MCP" decision matrix. Key split: the MCP is the *only* path to Dropbox's server-side version history (restore deleted, roll back revisions), which the scripts cannot do. Heuristic: one file or recovery → MCP; many files or a plan → skill script.
- `rlm` skill — for content extraction from PDFs (used by `categorize.py` via Sonnet)
- `misc_indexer` (separate, at `~/.claude/playground/misc_indexer/`) — produces per-folder `_index.json` with extracted titles/abstracts/keywords; complementary to but not part of this skill

## Known caveats (see SKILL.md for details)

1. Git Bash MSYS path conversion can mangle paths — auto-fixed by `normalize_path_arg()` in `dbx_sync.py`
2. Dropbox API listing can throttle on 4000+ file folders, producing false drift signals on verification re-runs
3. `keep_newer` conflict mode depends on mtime accuracy
4. Files >150 MB are skipped on upload (Dropbox API limit; use `dropbox_download` MCP tool to pull such files manually if needed)
