"""dbx_sync.py — bidirectional sync between local Dropbox and cloud.

A general-purpose tool consolidating the patterns built across the misc_organize
sync scripts (sync_misc_smart.py, sync_team_dc_smart.py, sync_team_dc_recursive.py,
reconcile_cloud_dupes.py, sync_cleanup_stale_root.py).

Usage
-----
    python -X utf8 dbx_sync.py PATH [options]

PATH: Cloud-side path. Local path is derived as ~/Dropbox<PATH>.
      Examples: "/Misc", "/Team DC", "/Github/beyond-the-bat"

Options
-------
    --recursive        Walk all nested subfolders. Default: shallow (one level).
    --execute          Apply the plan. Default: dry-run only.
    --conflict MODE    Conflict mode (default: flag_only):
                         flag_only  — report only, no auto-resolve
                         keep_newer — overwrite older side by mtime
                         keep_local — always overwrite cloud with local
                         keep_cloud — always overwrite local with cloud
    --no-moves         Disable cross-folder move detection. Default: enabled.
    --skip-larger N    Skip files larger than N bytes (use 0 for no limit).
                       Default: 0 (no limit) for shallow; 0 for recursive too.
                       Example: --skip-larger 100000000  (skips >100MB).
    --workers N        Parallel workers for downloads/uploads. Default: 8.
    --cleanup-failed-moves  After execute, delete cloud source paths for any
                       moves that failed because the destination already existed
                       (matches `sync_cleanup_stale_root.py` behavior).
                       Implied safe-mode: only deletes if no local file exists at
                       the same path.
    --plan-out PATH    JSON path for the action plan. Default: auto-generated.

Examples
--------
    # Shallow dry-run of /Misc
    python -X utf8 dbx_sync.py /Misc

    # Recursive sync of /Team DC, dry-run, flag conflicts
    python -X utf8 dbx_sync.py "/Team DC" --recursive

    # Recursive execute of /Team DC, auto-resolve conflicts by mtime,
    # skip files larger than 100 MB
    python -X utf8 dbx_sync.py "/Team DC" --recursive --execute \\
        --conflict keep_newer --skip-larger 100000000

    # Sync /Github/beyond-the-bat shallowly, executing, with cleanup
    python -X utf8 dbx_sync.py /Github/beyond-the-bat --execute \\
        --cleanup-failed-moves

Behavior
--------
- Case-insensitive path matching: Windows-friendly (treats `Foo/` ≡ `foo/`)
- Move detection: when a cloud file at /A/foo.pdf has a matching-size local
  copy at /B/foo.pdf (and no local at /A/foo.pdf), the script uses
  files_move_v2 on cloud to relocate instead of download+upload
- Skip-list: .git/, __pycache__/, .ruff_cache/, .playwright-mcp/, .claude/,
  .mcp.json, .dropboxignore, node_modules/, lockfiles (~$*, ~WRL*.tmp), OS
  metadata (.DS_Store, Thumbs.db, desktop.ini)
- Authentication: reads ~/.claude/channels/dropbox/.env for DROPBOX_APP_KEY,
  DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN
"""
from __future__ import annotations
import argparse, io, json, os, re, sys, time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

if sys.platform == "win32" and hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

import dropbox

# ---- Configuration ------------------------------------------------------

ENV_PATH = Path.home() / ".claude" / "channels" / "dropbox" / ".env"
DROPBOX_LOCAL_ROOT = Path.home() / "Dropbox"  # The "/" in Dropbox cloud namespace == this

SKIP_NAME_PARTS = {
    ".git", "__pycache__", ".ruff_cache", ".playwright-mcp",
    ".claude", ".mcp.json", ".dropboxignore",
    "Thumbs.db", "desktop.ini", ".DS_Store", "node_modules",
}

UPLOAD_SINGLE_SHOT_LIMIT = 150 * 1024 * 1024  # 150 MB — Dropbox API limit for non-session upload


def load_env() -> dict:
    env = {}
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s and not s.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def make_client(env: dict, timeout: int = 240) -> dropbox.Dropbox:
    return dropbox.Dropbox(
        oauth2_refresh_token=env["DROPBOX_REFRESH_TOKEN"],
        app_key=env["DROPBOX_APP_KEY"],
        app_secret=env["DROPBOX_APP_SECRET"],
        timeout=timeout,
    )


def should_skip_path_component(component: str) -> bool:
    if component in SKIP_NAME_PARTS:
        return True
    if component.startswith("~$") or component.startswith("~WRL") or component.endswith(".tmp"):
        return True
    return False


def should_skip_path(rel_path: str) -> bool:
    return any(should_skip_path_component(p) for p in rel_path.split("/") if p)


def slug_from_path(cloud_path: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", cloud_path.strip("/")).strip("_").lower() or "root"


# ---- Cloud listing ------------------------------------------------------

def list_cloud(dbx, cloud_path: str, recursive: bool, retries: int = 3) -> dict[str, dict]:
    """Returns {rel_path: {size, modified, content_hash, full_path}}.
       rel_path is relative to cloud_path, forward-slash separated, no leading slash.
       Files only (no folders)."""
    out = {}
    last_exc = None
    for attempt in range(retries):
        try:
            res = dbx.files_list_folder(cloud_path, recursive=recursive)
            break
        except dropbox.exceptions.ApiError as e:
            if "not_found" in str(e):
                return out
            last_exc = e
        except Exception as e:
            last_exc = e
            time.sleep(2 ** attempt)
    else:
        raise last_exc

    while True:
        for entry in res.entries:
            if not isinstance(entry, dropbox.files.FileMetadata):
                continue
            full_path = entry.path_display
            if full_path.startswith(cloud_path + "/"):
                rel_path = full_path[len(cloud_path) + 1:]
            elif full_path == cloud_path:
                continue
            else:
                continue
            if should_skip_path(rel_path):
                continue
            mod = entry.client_modified or entry.server_modified
            if mod.tzinfo is None:
                mod = mod.replace(tzinfo=timezone.utc)
            out[rel_path] = {
                "size": entry.size,
                "modified": mod,
                "content_hash": entry.content_hash,
                "full_path": full_path,
            }
        if not res.has_more:
            break
        last_exc = None
        for attempt in range(retries):
            try:
                res = dbx.files_list_folder_continue(res.cursor)
                break
            except Exception as e:
                last_exc = e
                time.sleep(2 ** attempt)
        else:
            raise last_exc
    return out


def list_cloud_immediate_subdirs(dbx, cloud_path: str) -> list[str]:
    """Return immediate-subdir names (one level) on cloud."""
    out = []
    try:
        res = dbx.files_list_folder(cloud_path, recursive=False)
    except dropbox.exceptions.ApiError:
        return out
    while True:
        for entry in res.entries:
            if isinstance(entry, dropbox.files.FolderMetadata):
                out.append(entry.name)
        if not res.has_more:
            break
        res = dbx.files_list_folder_continue(res.cursor)
    return sorted(out)


# ---- Local listing ------------------------------------------------------

def list_local(local_path: Path, recursive: bool) -> dict[str, dict]:
    """Returns {rel_path: {size, mtime, full_path}}."""
    out = {}
    if not local_path.exists():
        return out
    walker = local_path.rglob("*") if recursive else local_path.iterdir()
    for p in walker:
        try:
            if not p.is_file():
                continue
        except OSError:
            continue
        rel_path = p.relative_to(local_path).as_posix()
        if should_skip_path(rel_path):
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        out[rel_path] = {
            "size": st.st_size,
            "mtime": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc),
            "full_path": p,
        }
    return out


def list_local_immediate_subdirs(local_path: Path) -> list[str]:
    out = []
    if not local_path.exists():
        return out
    for p in local_path.iterdir():
        if p.is_dir() and not should_skip_path_component(p.name) and not p.name.startswith("."):
            out.append(p.name)
    return sorted(out)


# ---- Planning ----------------------------------------------------------

def plan_actions(cloud: dict, local: dict, *, local_root: Path, cloud_root: str,
                 enable_moves: bool, conflict_mode: str, skip_larger: int):
    moves, downloads, uploads = [], [], []
    conflicts_keep_local, conflicts_keep_cloud, conflicts_flagged = [], [], []
    flags = []

    # Case-insensitive lookups
    cloud_lower_to_orig = {rel.lower(): rel for rel in cloud}
    local_lower_to_orig = {rel.lower(): rel for rel in local}
    cloud_by_name = defaultdict(list)
    local_by_name = defaultdict(list)
    for rel in cloud:
        cloud_by_name[Path(rel).name.lower()].append(rel.lower())
    for rel in local:
        local_by_name[Path(rel).name.lower()].append(rel.lower())

    handled_local = set()

    def get_local(lower_rel):
        return local[local_lower_to_orig[lower_rel]] if lower_rel in local_lower_to_orig else None

    for rel, cinfo in cloud.items():
        rel_lower = rel.lower()
        if skip_larger and cinfo["size"] > skip_larger:
            continue
        if rel_lower in local_lower_to_orig:
            linfo = get_local(rel_lower)
            if cinfo["size"] == linfo["size"]:
                continue
            cdata = {
                "rel_path": rel,
                "cloud_path": cinfo["full_path"], "local_path": str(linfo["full_path"]),
                "cloud_size": cinfo["size"], "local_size": linfo["size"],
                "cloud_mod": cinfo["modified"].isoformat(), "local_mod": linfo["mtime"].isoformat(),
            }
            if conflict_mode == "flag_only":
                conflicts_flagged.append(cdata)
            elif conflict_mode == "keep_newer":
                if cinfo["modified"] > linfo["mtime"]:
                    conflicts_keep_cloud.append(cdata)
                else:
                    conflicts_keep_local.append(cdata)
            elif conflict_mode == "keep_local":
                conflicts_keep_local.append(cdata)
            elif conflict_mode == "keep_cloud":
                conflicts_keep_cloud.append(cdata)
        else:
            # Cloud has it; local doesn't have at same path
            if enable_moves:
                name_lower = Path(rel).name.lower()
                local_candidates_lower = [l for l in local_by_name.get(name_lower, []) if l != rel_lower]
            else:
                local_candidates_lower = []

            if not local_candidates_lower:
                downloads.append({
                    "rel_path": rel, "cloud_path": cinfo["full_path"],
                    "local_dest": str(local_root / rel),
                    "size": cinfo["size"],
                })
            elif len(local_candidates_lower) == 1:
                other_rel_lower = local_candidates_lower[0]
                other_info = get_local(other_rel_lower)
                other_rel_orig = local_lower_to_orig[other_rel_lower]
                if other_info["size"] == cinfo["size"]:
                    target_cloud_path = f"{cloud_root}/{other_rel_orig}"
                    moves.append({
                        "name": Path(rel).name, "from": cinfo["full_path"], "to": target_cloud_path,
                        "from_rel": rel, "to_rel": other_rel_orig, "size": cinfo["size"],
                    })
                    handled_local.add(other_rel_lower)
                else:
                    flags.append({
                        "reason": "same name but size mismatch with local copy elsewhere",
                        "name": Path(rel).name,
                        "cloud": {"path": cinfo["full_path"], "size": cinfo["size"]},
                        "local_elsewhere": [{"rel": other_rel_orig, "size": other_info["size"]}],
                    })
            else:
                size_matches = [l for l in local_candidates_lower if get_local(l)["size"] == cinfo["size"]]
                if len(size_matches) == 1:
                    other_rel_lower = size_matches[0]
                    other_rel_orig = local_lower_to_orig[other_rel_lower]
                    target_cloud_path = f"{cloud_root}/{other_rel_orig}"
                    moves.append({
                        "name": Path(rel).name, "from": cinfo["full_path"], "to": target_cloud_path,
                        "from_rel": rel, "to_rel": other_rel_orig, "size": cinfo["size"],
                    })
                    handled_local.add(other_rel_lower)
                else:
                    flags.append({
                        "reason": f"multiple local matches ({len(local_candidates_lower)})",
                        "name": Path(rel).name,
                        "cloud": {"path": cinfo["full_path"], "size": cinfo["size"]},
                        "local_candidates": [{"rel": local_lower_to_orig[l], "size": get_local(l)["size"]}
                                             for l in local_candidates_lower],
                    })

    for rel, linfo in local.items():
        rel_lower = rel.lower()
        if skip_larger and linfo["size"] > skip_larger:
            continue
        if rel_lower in cloud_lower_to_orig:
            continue
        if rel_lower in handled_local:
            continue
        if enable_moves:
            name_lower = Path(rel).name.lower()
            cloud_candidates_lower = [c for c in cloud_by_name.get(name_lower, []) if c != rel_lower]
        else:
            cloud_candidates_lower = []
        if not cloud_candidates_lower:
            uploads.append({
                "rel_path": rel, "local_path": str(linfo["full_path"]),
                "cloud_dest": f"{cloud_root}/{rel}",
                "size": linfo["size"],
            })

    def serialize(x):
        if isinstance(x, datetime): return x.isoformat()
        if isinstance(x, Path): return str(x)
        if isinstance(x, dict): return {k: serialize(v) for k, v in x.items()}
        if isinstance(x, list): return [serialize(v) for v in x]
        return x

    return serialize({
        "moves": moves, "downloads": downloads, "uploads": uploads,
        "conflicts_keep_local": conflicts_keep_local,
        "conflicts_keep_cloud": conflicts_keep_cloud,
        "conflicts_flagged": conflicts_flagged,
        "flags": flags,
    })


# ---- Execution ---------------------------------------------------------

def execute_plan(dbx, plan: dict, workers: int) -> dict:
    results = {
        "moves_ok": 0, "moves_fail": 0, "moves_failed_dest_exists": [],
        "downloads_ok": 0, "downloads_fail": 0,
        "uploads_ok": 0, "uploads_fail": 0, "skipped_large": 0,
        "conflicts_ok": 0, "conflicts_fail": 0,
        "errors": [],
    }

    # Phase A: moves (sequential to avoid races)
    if plan["moves"]:
        print(f"\nPhase A: {len(plan['moves'])} cross-folder cloud moves (sequential)...", flush=True)
    for i, m in enumerate(plan["moves"], 1):
        try:
            dbx.files_move_v2(m["from"], m["to"], autorename=False)
            results["moves_ok"] += 1
        except dropbox.exceptions.ApiError as e:
            err_str = str(e)
            if "to/conflict" in err_str or "WriteError('conflict'" in err_str:
                results["moves_failed_dest_exists"].append(m)
                results["moves_fail"] += 1
            else:
                results["moves_fail"] += 1
                results["errors"].append(f"move {m['name']}: {e}")
        except Exception as e:
            results["moves_fail"] += 1
            results["errors"].append(f"move {m['name']}: {e}")
        if i % 25 == 0 or i == len(plan["moves"]):
            print(f"  [{i}/{len(plan['moves'])}] done", flush=True)

    def do_download(d):
        try:
            dest = Path(d["local_dest"])
            dest.parent.mkdir(parents=True, exist_ok=True)
            _, resp = dbx.files_download(d["cloud_path"])
            dest.write_bytes(resp.content)
            return ("download_ok", d["rel_path"])
        except Exception as e:
            return ("download_fail", f"{d['rel_path']}: {e}")

    def do_upload(u):
        try:
            src = Path(u["local_path"])
            if u["size"] > UPLOAD_SINGLE_SHOT_LIMIT:
                return ("upload_skipped_large", f"{u['rel_path']}: {u['size']/(1024*1024):.0f}MB > 150MB limit")
            with open(src, "rb") as f:
                data = f.read()
            dbx.files_upload(data, u["cloud_dest"], mode=dropbox.files.WriteMode.add)
            return ("upload_ok", u["rel_path"])
        except Exception as e:
            return ("upload_fail", f"{u['rel_path']}: {e}")

    def do_conflict(c, side):
        try:
            if side == "keep_local":
                src = Path(c["local_path"])
                if src.stat().st_size > UPLOAD_SINGLE_SHOT_LIMIT:
                    return ("conflict_fail", f"{c['rel_path']}: too large")
                with open(src, "rb") as f:
                    data = f.read()
                dbx.files_upload(data, c["cloud_path"], mode=dropbox.files.WriteMode.overwrite)
            else:
                _, resp = dbx.files_download(c["cloud_path"])
                Path(c["local_path"]).write_bytes(resp.content)
            return ("conflict_ok", c["rel_path"])
        except Exception as e:
            return ("conflict_fail", f"{c['rel_path']}: {e}")

    tasks = []
    tasks.extend([("download", d) for d in plan["downloads"]])
    tasks.extend([("upload", u) for u in plan["uploads"]])
    tasks.extend([("conflict_keep_local", c) for c in plan["conflicts_keep_local"]])
    tasks.extend([("conflict_keep_cloud", c) for c in plan["conflicts_keep_cloud"]])

    if tasks:
        print(f"\nPhase B: {len(plan['downloads'])}↓ + {len(plan['uploads'])}↑ + "
              f"{len(plan['conflicts_keep_local']) + len(plan['conflicts_keep_cloud'])} resolves "
              f"({workers} parallel workers)...", flush=True)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = []
        for kind, item in tasks:
            if kind == "download":
                futs.append(ex.submit(do_download, item))
            elif kind == "upload":
                futs.append(ex.submit(do_upload, item))
            elif kind == "conflict_keep_local":
                futs.append(ex.submit(do_conflict, item, "keep_local"))
            elif kind == "conflict_keep_cloud":
                futs.append(ex.submit(do_conflict, item, "keep_cloud"))
        for i, fut in enumerate(as_completed(futs), 1):
            try:
                status, msg = fut.result()
                if status == "download_ok":     results["downloads_ok"] += 1
                elif status == "download_fail": results["downloads_fail"] += 1; results["errors"].append(f"download {msg}")
                elif status == "upload_ok":     results["uploads_ok"] += 1
                elif status == "upload_fail":   results["uploads_fail"] += 1; results["errors"].append(f"upload {msg}")
                elif status == "upload_skipped_large": results["skipped_large"] += 1; results["errors"].append(f"large {msg}")
                elif status == "conflict_ok":   results["conflicts_ok"] += 1
                elif status == "conflict_fail": results["conflicts_fail"] += 1; results["errors"].append(f"conflict {msg}")
            except Exception as e:
                results["errors"].append(f"task: {e}")
            if i % 50 == 0 or i == len(futs):
                print(f"  [{i}/{len(futs)}] done", flush=True)

    return results


def cleanup_failed_moves(dbx, results: dict, local_root: Path) -> dict:
    """For each move that failed because the destination already existed (move's
    'to/conflict'), delete the cloud source path IF local doesn't have a file at
    that path. Mirrors sync_cleanup_stale_root.py."""
    cleanup = {"deleted": 0, "skipped_local_has": 0, "fail": 0, "errors": []}
    for m in results.get("moves_failed_dest_exists", []):
        # Source local equivalent: local_root + from_rel (case-sensitive on disk but
        # Windows is case-insensitive, so .exists() handles aliasing correctly)
        local_at_source = local_root / m["from_rel"]
        if local_at_source.exists():
            cleanup["skipped_local_has"] += 1
            continue
        try:
            dbx.files_delete_v2(m["from"])
            cleanup["deleted"] += 1
        except Exception as e:
            cleanup["fail"] += 1
            cleanup["errors"].append(f"delete {m['from']}: {e}")
    return cleanup


# ---- Driver -------------------------------------------------------------

def normalize_path_arg(raw: str) -> str:
    """Convert any user-supplied path form to a cloud path like '/Misc' or '/Team DC'.
    Handles:
      - '/Misc'                                         → '/Misc'
      - 'Misc'                                          → '/Misc'
      - 'C:\\Users\\danie\\Dropbox\\Misc'                → '/Misc'
      - '/C:/Program Files/Git/Misc'                    → '/Misc'  (Git Bash MSYS conversion)
      - 'C:/Program Files/Git/Misc'                     → '/Misc'  (same w/o leading /)
      - 'C:/Users/danie/Dropbox/Team DC'                → '/Team DC'
    """
    s = raw.replace("\\", "/")
    # Git Bash MSYS conversion (`/Team DC` becomes Git install path + Team DC)
    m = re.match(r"^/?[A-Za-z]:/Program Files/Git/(.*)$", s, re.IGNORECASE)
    if m:
        s = "/" + m.group(1)
    # Strip local Dropbox prefix if present
    local_prefix = str(DROPBOX_LOCAL_ROOT).replace("\\", "/")
    for candidate in (local_prefix, local_prefix.replace("C:/", "/c/", 1)):
        if s.lower().startswith(candidate.lower() + "/"):
            s = s[len(candidate):]
            break
        if s.lower() == candidate.lower():
            s = "/"
            break
    # Ensure single leading slash
    s = "/" + s.lstrip("/")
    return s


def derive_local_path(cloud_path: str) -> Path:
    rel = cloud_path.strip("/").replace("/", os.sep)
    return DROPBOX_LOCAL_ROOT / rel


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("Usage")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help="Cloud path under Dropbox root, e.g. /Misc or '/Team DC'")
    ap.add_argument("--recursive", action="store_true", help="Walk all nested subfolders (default: shallow)")
    ap.add_argument("--execute", action="store_true", help="Apply the plan (default: dry-run)")
    ap.add_argument("--conflict", choices=["flag_only", "keep_newer", "keep_local", "keep_cloud"],
                    default="flag_only", help="Conflict resolution mode (default: flag_only)")
    ap.add_argument("--no-moves", action="store_true", help="Disable cross-folder move detection")
    ap.add_argument("--skip-larger", type=int, default=0,
                    help="Skip files larger than N bytes. 0 = no limit. Useful with --execute.")
    ap.add_argument("--workers", type=int, default=8, help="Parallel workers (default: 8)")
    ap.add_argument("--cleanup-failed-moves", action="store_true",
                    help="After execute, delete cloud sources for moves that failed because dest existed")
    ap.add_argument("--plan-out", default=None, help="JSON path for action plan (default: auto)")
    args = ap.parse_args()

    cloud_root = normalize_path_arg(args.path)
    local_root = derive_local_path(cloud_root)
    slug = slug_from_path(cloud_root)
    mode_tag = "recursive" if args.recursive else "shallow"
    out_dir = Path(__file__).parent
    plan_out = Path(args.plan_out) if args.plan_out else out_dir / f"dbx_sync_{slug}_{mode_tag}_{'execute' if args.execute else 'dryrun'}.json"

    print(f"=== dbx_sync ({'EXECUTE' if args.execute else 'DRY RUN'}, {mode_tag}) ===")
    print(f"  cloud:        {cloud_root}")
    print(f"  local:        {local_root}")
    print(f"  recursive:    {args.recursive}")
    print(f"  conflict:     {args.conflict}")
    print(f"  moves:        {'disabled' if args.no_moves else 'enabled'}")
    if args.skip_larger:
        print(f"  skip-larger:  {args.skip_larger:,} bytes ({args.skip_larger/(1024*1024):.0f} MB)")
    print(f"  workers:      {args.workers}")
    print(f"  plan-out:     {plan_out}")
    print()

    if not local_root.exists():
        print(f"ERROR: local path does not exist: {local_root}")
        return 1

    env = load_env()
    dbx = make_client(env)

    print("Phase 1: enumerating cloud + local in parallel...", flush=True)
    start = time.time()
    with ThreadPoolExecutor(max_workers=2) as ex:
        cloud_fut = ex.submit(list_cloud, dbx, cloud_root, args.recursive)
        local_fut = ex.submit(list_local, local_root, args.recursive)
        cloud = cloud_fut.result()
        local = local_fut.result()
    print(f"  cloud: {len(cloud)} files; local: {len(local)} files (filtered)")
    print(f"  Phase 1 done in {time.time()-start:.0f}s\n")

    print("Phase 2: computing action plan...", flush=True)
    plan = plan_actions(cloud, local, local_root=local_root, cloud_root=cloud_root,
                        enable_moves=not args.no_moves, conflict_mode=args.conflict,
                        skip_larger=args.skip_larger)

    print(f"\n=== ACTION PLAN ===")
    print(f"  Moves:                {len(plan['moves'])}")
    print(f"  Downloads:            {len(plan['downloads'])}")
    print(f"  Uploads:              {len(plan['uploads'])}")
    if args.conflict == "flag_only":
        print(f"  Conflicts (flagged):  {len(plan['conflicts_flagged'])}")
    else:
        print(f"  Conflicts keep-local: {len(plan['conflicts_keep_local'])}")
        print(f"  Conflicts keep-cloud: {len(plan['conflicts_keep_cloud'])}")
    print(f"  Flags (manual):       {len(plan['flags'])}")
    dl_bytes = sum(d["size"] for d in plan["downloads"])
    up_bytes = sum(u["size"] for u in plan["uploads"])
    print(f"  Download volume:      {dl_bytes/(1024*1024):,.1f} MB")
    print(f"  Upload volume:        {up_bytes/(1024*1024):,.1f} MB")

    plan_out.parent.mkdir(parents=True, exist_ok=True)
    plan_out.write_text(json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  Plan JSON: {plan_out}")

    if not args.execute:
        print("\nDRY RUN — no changes. Re-run with --execute to apply.")
        return 0

    print(f"\n=== EXECUTING ===")
    start = time.time()
    results = execute_plan(dbx, plan, workers=args.workers)
    elapsed = time.time() - start

    print(f"\n=== RESULTS ===")
    print(f"  Moves:     ok={results['moves_ok']} fail={results['moves_fail']}")
    print(f"             ({len(results['moves_failed_dest_exists'])} of fail = dest already existed)")
    print(f"  Downloads: ok={results['downloads_ok']} fail={results['downloads_fail']}")
    print(f"  Uploads:   ok={results['uploads_ok']} fail={results['uploads_fail']} skipped_large={results['skipped_large']}")
    print(f"  Conflicts: ok={results['conflicts_ok']} fail={results['conflicts_fail']}")
    print(f"  Total errors: {len(results['errors'])}")
    print(f"  Elapsed:   {elapsed:.1f}s")

    if args.cleanup_failed_moves and results.get("moves_failed_dest_exists"):
        print(f"\n=== CLEANUP (failed moves) ===")
        c = cleanup_failed_moves(dbx, results, local_root)
        print(f"  Deleted from cloud:    {c['deleted']}")
        print(f"  Skipped (local has):   {c['skipped_local_has']}")
        print(f"  Failed:                {c['fail']}")
        results["cleanup"] = c

    result_out = out_dir / f"dbx_sync_{slug}_{mode_tag}_result.json"
    result_out.write_text(json.dumps(results, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    print(f"\n  Result JSON: {result_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
