---
name: dropbox
description: "Tooling for bidirectional Dropbox cloud↔local sync, loose-file sorting into topic subdirs, cloud-PDF deduplication, and .dropboxignore installation. Use when the user says 'sync my dropbox folder', 'fix drift between local and cloud', 'my dropbox isn't syncing', 'sort the files in /Misc', 'remove dropbox duplicates', 'add .dropboxignore to my git repo', 'force-download cloud files that didn't sync locally', 'reconcile (cloud) suffixed files', 'organize loose files at root', or when a /Misc-style folder has accumulated unsorted files. Primary tool: dbx_sync.py (bidirectional sync, cross-folder move detection, conflict modes, --skip-larger for big media); also categorize/execute (sort loose PDFs), reconcile_cloud_dupes, and a sync_final_followups recipe. Does NOT cover Dropbox sharing/permissions, content indexing, or team-admin operations."
---

# Dropbox

A toolkit for keeping local Dropbox folders in sync with cloud, sorting accumulated loose files, deduplicating, and protecting git repos from being synced.

**Provenance**: Built across 2026-06-06 and 2026-06-07 to recover a 225-file drift in `/Misc` and then sync `/Team DC` (43 subdirs, 3,927 files) bidirectionally. Patterns proven on those folders and consolidated into `dbx_sync.py`.

**Skill root**: this skill ships inside the `dropbox-mcp` plugin (repo
`danielsimonjr/dropbox-mcp`, `skills/dropbox/`). Its scripts live in this
skill's own `scripts/` directory — resolve them relative to this SKILL.md's
location. Slash trigger: `/dropbox`.

## When to use this skill

Trigger this skill when the user wants any of:

- **Sync a Dropbox folder** with the cloud, possibly recursively, possibly bidirectionally
- **Diagnose drift** ("my dropbox isn't syncing", "files are out of sync") — start with a dry-run
- **Force-download cloud-only files** when the Dropbox client has stalled
- **Sort loose files** in a Dropbox subdirectory into existing topic subdirs (Sonnet-based categorization)
- **Reconcile (cloud)-suffixed duplicates** from a prior sort
- **Add .dropboxignore** to a git repo folder under Dropbox to stop `.git/` from syncing
- **Resolve same-name files in different folders** (move detection)

Do NOT use this skill for:
- Sharing/permissions changes (no API support in current toolkit)
- Content indexing for search (use `misc_indexer/build_index.py` separately)

## Tool selection: skill scripts vs. `dropbox-mcp` plugin

This skill's Python scripts and the `dropbox-mcp` plugin's MCP tools are **complementary, not redundant**. They share the same auth (`~/.claude/channels/dropbox/.env`) but serve different shapes of work. Pick by the shape of the task, not by habit.

**One-line heuristic: one file (any operation) or recovery → MCP tool. Many files, or a multi-phase plan → skill script.**

The `dropbox-mcp` plugin exposes 11 atomic tools (as of plugin v0.3.0): four read-only (`search`, `file_info`, `list_revisions`, `list_deleted`), four mutating (`download`, `upload`, `move`, `delete`), and three recovery (`restore`, `restore_batch`, `restore_revision`). The skill scripts orchestrate those same primitives in bulk with a dry-run-then-execute plan.

| The task | Reach for | Why |
|---|---|---|
| "Where does file X live / what's its latest version?" | **MCP** `dropbox_search`, `dropbox_file_info` | Single lookup, conversational, no plan |
| "Pull / push / move / delete THIS ONE file" | **MCP** `dropbox_download` / `dropbox_upload` / `dropbox_move` / `dropbox_delete` | Atomic single-file op; a whole sync plan is overkill |
| "Restore a deleted file" | **MCP** `dropbox_restore` / `dropbox_restore_batch` | **Recovery is MCP-only** — the skill scripts have no access to server-side history |
| "Roll a file back to an older revision" | **MCP** `dropbox_list_revisions` → `dropbox_restore_revision` | Same — revision history is MCP-only |
| "What got deleted from this folder recently?" | **MCP** `dropbox_list_deleted` | Read-only history query |
| "Sync this whole folder / fix drift" | **Skill** `dbx_sync.py` | Bulk, multi-phase, dry-run discipline, move detection |
| "Push/pull MANY files (client stalled)" | **Skill** `dbx_sync.py` | Batch; the MCP up/download tools are one-at-a-time |
| "Sort 200 loose files into topic subdirs" | **Skill** `categorize.py` + `execute.py` | Sonnet classification + collision-safe moves |
| "Reconcile (cloud)-suffixed dupes" | **Skill** `reconcile_cloud_dupes.py` | Batch promote-and-backup |
| "Add .dropboxignore to a repo" | **Skill** `sync_final_followups.py` template | Bundled recipe |

**The boundary is volume + orchestration, not capability.** Since plugin v0.3.0 the MCP can write (`upload`), relocate (`move`), and remove (`delete`) — so a *single* such operation no longer needs a script. The scripts still own anything that is (a) many files at once, (b) needs a reviewable dry-run plan first, or (c) needs cross-folder move *detection* (figuring out which files moved where). For one known file, prefer the atomic MCP tool — it's faster and needs no plan.

**The two interlock.** The MCP's read/restore tools are the natural companions to the skill's bulk operations:
- Before resolving a flagged conflict, use `dropbox_list_revisions` to inspect the cloud file's history (see the conflict-handling note in the standard workflow below).
- After a sync you regret, `dropbox_restore` / `dropbox_restore_revision` is the undo path — the scripts have no rollback of their own.
- When `dbx_sync.py` reports a file you don't recognize, `dropbox_file_info` confirms its size/hash/revision before you decide to keep or delete it.
- To fix up a single stray file after a sync (one move, one delete, one re-upload), reach for `dropbox_move` / `dropbox_delete` / `dropbox_upload` rather than re-running a whole folder sync.

If the `dropbox-mcp` tools are not loaded in the session, fetch their schemas via ToolSearch (`select:mcp__plugin_dropbox-mcp_dropbox-mcp__dropbox_upload,mcp__plugin_dropbox-mcp_dropbox-mcp__dropbox_move,mcp__plugin_dropbox-mcp_dropbox-mcp__dropbox_delete`, etc.) — they share this skill's auth and need no extra setup.

## Recovery & restore (MCP-only — the scripts cannot do this)

The sync/sort scripts move and overwrite files but have **no access to Dropbox's server-side version history**. Any "undo", "restore deleted", or "roll back to an earlier version" request must go through the `dropbox-mcp` tools. This is the single most important capability split to remember: a bad `--execute` is recoverable, but only via the MCP.

**Restore a deleted file:**
```
dropbox_list_deleted(path="/Misc/SomeFolder", recursive=true)   # find what's recoverable
dropbox_restore(path="/Misc/SomeFolder/lost-file.pdf")           # restores most-recent revision
```

**Roll a file back to an older version** (e.g., a sync overwrote the wrong side):
```
dropbox_list_revisions(path="/Misc/paper.pdf", limit=20)         # list revisions with IDs + dates
dropbox_restore_revision(path="/Misc/paper.pdf", rev="<rev_id>") # restore a specific one
```

**Batch-restore several deleted files:**
```
dropbox_restore_batch(paths=["/A/one.pdf", "/A/two.pdf", ...])
```

When a sync `--execute` resolved a conflict the wrong way (e.g., `keep_newer` kept a cloud version that was actually a regression), the recovery is: `dropbox_list_revisions` on that path → identify the pre-sync revision by its date → `dropbox_restore_revision`. Dropbox retains 30 days of history on standard accounts (longer on some plans), so this window is finite — recover promptly.

## Authentication

All scripts read `~/.claude/channels/dropbox/.env` for `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`. This is the same setup as the `dropbox-mcp` plugin uses — no new tokens needed.

If `.env` is missing, the user must run `python ~/.claude/channels/dropbox/get_refresh_token.py` once to set it up.

## Primary tool: `dbx_sync.py`

Bidirectional sync between any local Dropbox folder and its cloud equivalent.

```bash
python -X utf8 scripts/dbx_sync.py PATH [options]
```

Where `scripts/` is this skill's own `scripts/` directory, resolved relative to this SKILL.md's location.

**PATH** accepts many forms (auto-normalized to a cloud path):
- `/Misc`, `"/Team DC"`, `/Github/beyond-the-bat` — cloud paths
- `Misc`, `Team DC` — relative; same effect
- `C:\Users\danie\Dropbox\Misc` — full Windows local path
- `/C:/Program Files/Git/Team DC` — Git-Bash MSYS-mangled form (auto-fixed)

**Key flags**:

| Flag | Default | Effect |
|---|---|---|
| `--recursive` | shallow | Walk all nested subfolders |
| `--execute` | dry-run | Apply the plan |
| `--conflict MODE` | `flag_only` | `flag_only` / `keep_newer` / `keep_local` / `keep_cloud` |
| `--skip-larger N` | 0 (no limit) | Skip files >N bytes (use for big media/installers) |
| `--cleanup-failed-moves` | off | After execute, delete cloud sources for moves whose dest already existed |
| `--no-moves` | enabled | Disable cross-folder move detection |
| `--workers N` | 8 | Parallel workers |

**Behaviors baked in** (these took multiple iterations to get right; they're now defaults):
- **Case-insensitive path matching**: Windows treats `Foo/` ≡ `foo/`, so cloud `camille & daniel wedding/` and local `Camille & Daniel Wedding/` match correctly
- **Cross-folder move detection**: when a cloud file at `/A/foo.pdf` has a same-size local copy at `/B/foo.pdf` and no local at `/A/foo.pdf`, the script uses `files_move_v2` on cloud to relocate instead of re-downloading
- **Standard skip-list**: `.git/`, `__pycache__/`, `.ruff_cache/`, `.playwright-mcp/`, `.claude/`, `.mcp.json`, `.dropboxignore`, `node_modules/`, OS metadata (`.DS_Store`, `Thumbs.db`, `desktop.ini`), lockfiles (`~$*`, `~WRL*.tmp`)
- **Files >150 MB skipped** with warning (Dropbox API requires upload_session; not implemented here)
- **Plan + result JSON** saved to script dir as `dbx_sync_<slug>_<mode>_<phase>.json`

## Standard workflow: drift check → review → execute

The right pattern for any non-trivial sync is **dry-run first**, present the plan, get user approval, execute.

```bash
# Phase 1: dry-run
python -X utf8 scripts/dbx_sync.py "/Team DC" --recursive

# Phase 2: review the output. Look at:
#   - Total counts (moves, downloads, uploads, conflicts, flags)
#   - Volume of downloads (any unusually large files? skip them?)
#   - Number of conflicts (mode is flag_only by default — they require user input)
#   - Flags (ambiguous moves with multiple local matches) — usually skip auto-resolution

# Phase 3: execute, possibly with --skip-larger for big media
python -X utf8 scripts/dbx_sync.py "/Team DC" --recursive --execute \
    --conflict keep_newer --skip-larger 104857600 \
    --cleanup-failed-moves

# Phase 4: optional verification dry-run (caveat: Dropbox API can throttle
# on large folders like AI-ML-Papers 4,711 files, producing false-drift
# signals — verify directly if numbers look wrong)
python -X utf8 scripts/dbx_sync.py "/Team DC" --recursive
```

**Conflict modes** (choose based on data sensitivity):
- `flag_only` (default) — report differences, take no action. Safest. Best for unfamiliar folders.
- `keep_newer` — overwrite the older side by modified date. Good for actively-edited content.
- `keep_local` / `keep_cloud` — overwrite one side unconditionally. Use rarely; usually after you've already decided which side is canonical.

**Inspecting a conflict before resolving** (skill × MCP synergy): when a conflict is flagged and you're unsure which side is canonical, use the MCP `dropbox_list_revisions(path=...)` to see the cloud file's revision history — dates and sizes — before choosing a mode. If the cloud side turns out to hold an edit you want to preserve, restore it with `dropbox_restore_revision` rather than letting `keep_local` clobber it. The scripts decide by size + mtime only; the MCP gives you the full server-side history to decide with.

**`--skip-larger`** is the escape valve for big media/installers. Use 100 MB (104857600) to skip phone backups, ISO images, raw video. The script reports skipped files but doesn't transfer them.

**`--cleanup-failed-moves`** addresses a real edge case: when the script tries to move a cloud file to a destination that already has a copy (because the Dropbox client previously uploaded the local version), the move fails. With this flag, the script falls back to deleting the source after verifying local doesn't have a file at the source path. Without this flag, you'd see "fail=N" in the moves report and need to clean up manually.

## Common workflows by use case

### "My Dropbox folder is out of sync — fix it"

```bash
python -X utf8 scripts/dbx_sync.py /Misc --recursive
# Review the plan
python -X utf8 scripts/dbx_sync.py /Misc --recursive --execute --cleanup-failed-moves
```

### "I have 200+ loose files in /Misc root — sort them into topic subdirs"

The toolkit treats this as a separate concern from sync. Workflow:

```bash
# 1. Sonnet-categorize each loose PDF using existing subdirs as the allowed set
cd scripts  # this skill's own scripts/ directory (relative to SKILL.md)
python -X utf8 categorize.py
# Writes ~/.claude/playground/misc_organize/plan.json

# 2. Review plan.json
cat ~/.claude/playground/misc_organize/plan.json | jq '.[] | .folder' | sort | uniq -c

# 3. Execute the moves (collision-safe; won't overwrite existing files)
python -X utf8 execute.py

# 4. If any "(cloud)"-suffixed duplicates landed in dest folders, reconcile them
python -X utf8 reconcile_cloud_dupes.py --dry-run
python -X utf8 reconcile_cloud_dupes.py --execute

# 5. Then sync to cloud
python -X utf8 dbx_sync.py /Misc --execute --cleanup-failed-moves
```

The `categorize.py` and `execute.py` scripts are scoped to `~/Dropbox/Misc/` by default. Edit the `MISC` constant in `categorize.py` to retarget elsewhere.

### "Add .dropboxignore to my git repo so .git/ doesn't sync to cloud"

```bash
# Hand-write or use the template from any of these existing files
ls ~/Dropbox/Github/*/.dropboxignore | head -3
```

The standard template covers: `.git/`, `node_modules/`, `__pycache__/`, build artifacts, caches, secrets (`*.env`), and OS metadata. See `sync_final_followups.py` for the embedded template (`DROPBOXIGNORE_TEMPLATE` constant) and an example multi-repo installer.

### "Force-download cloud-only files that local doesn't have"

When the Dropbox client stalls and many cloud-only files accumulate at a root folder:

```bash
# dbx_sync.py handles this as part of normal sync — just run a dry-run first
python -X utf8 scripts/dbx_sync.py /Misc --recursive
# Review the "downloads" count and total volume
python -X utf8 scripts/dbx_sync.py /Misc --recursive --execute --skip-larger 104857600
```

Historical context: the morning of 2026-06-07, `/Misc` had 226 files on cloud root vs 2 local. The Dropbox client had been failing for weeks. A force-download via direct Dropbox SDK call (`sync_cloud_root.py`, kept in `~/.claude/playground/misc_organize/` for reference) pulled the missing 225 files in ~3 min. The integrated `dbx_sync.py` now handles this case as part of normal sync.

### "I added files from another device — pull just those to local"

```bash
# Dry-run shows what's cloud-only
python -X utf8 scripts/dbx_sync.py "/Team DC" --recursive
# If only downloads (no uploads/conflicts) make sense, execute
python -X utf8 scripts/dbx_sync.py "/Team DC" --recursive --execute
```

## Known caveats

1. **Git Bash MSYS path conversion**: `/Team DC` may be mangled to `/C:/Program Files/Git/Team DC` before the script sees it. The script auto-fixes this via `normalize_path_arg()`. If you see "ERROR: local path does not exist" with a Git-install-like path, the normalizer isn't matching — quote the path or use the relative form (`"Team DC"` without leading slash).

2. **Dropbox API listing throttles on big folders**: folders with ~4000+ files (e.g., `/Misc/AI-ML-Papers`) can return incomplete pagination on listing, producing false "thousands of uploads needed" signals on verification dry-runs. If a dry-run after a successful execute shows surprisingly large drift, verify a specific folder with a direct API call before re-running.

3. **Conflict mode `keep_newer` requires mtime accuracy**: Windows mtime can be unreliable in some cases (FAT32 mounts, cloud-rehydrated files). When in doubt, use `flag_only` and resolve conflicts manually.

4. **`(cloud)`-suffix reconciliation is a one-shot pattern**: only run `reconcile_cloud_dupes.py` immediately after `execute.py` produces collision-resolved files. Re-running on already-reconciled folders is safe but no-op.

5. **Phone backups, ISO images, video files**: these are typically the biggest items and rarely need to be local. Use `--skip-larger 104857600` (100 MB) routinely; the user can always pull specific large files manually via `dropbox_download` MCP tool.

## Output discipline

After running any sync, give the user a clean summary that includes:
- Total counts of each action category (moves, downloads, uploads, conflicts)
- Any failures, organized by category, with the most likely root cause
- The location of the plan JSON for re-inspection
- One-line recommendation for next step (e.g., "rerun verification dry-run", "manually review the 5 flags", "the sync is complete")

Surface flagged items (`reason` field on each flag) so the user can decide which to act on — these are deliberately not auto-resolved.

## Provenance and changelog

- **2026-06-06** — Built `sync_misc_smart.py` for the initial `/Misc` cleanup. Discovered move detection was needed; added it. Built `sync_cleanup_stale_root.py` for the dest-already-exists case.
- **2026-06-07** — Forked for `/Team DC` recursive sync. Discovered the case-sensitivity bug (Windows vs Dropbox cloud preserve case differently); fixed it. Consolidated all patterns into `dbx_sync.py` with parameterized path + recursive flag + conflict modes + cleanup-failed-moves flag.
- **2026-06-08** — Packaged as this skill + slash command `/dropbox`. Same day: `dropbox-mcp` plugin extended to v0.3.0 with atomic `upload`/`move`/`delete` tools (11 total); skill's scripts-vs-MCP matrix updated to reflect the MCP now covering single-file mutations.

The original per-folder scripts (`sync_misc_smart.py`, `sync_team_dc_*.py`, `sync_cleanup_stale_root.py`, `sync_cloud_root.py`) are kept at `~/.claude/playground/misc_organize/` for historical reference but are superseded by `dbx_sync.py`.
