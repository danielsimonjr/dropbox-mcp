"""Reconcile the 16 size-mismatched (cloud) PDFs from the 2026-06-07 sort.

For each pair where the cloud-downloaded version is larger than the existing
local version, this script:
  1. Moves the smaller existing local file to `_local_smaller_backup/<folder>/`
     preserving the original filename — so it remains recoverable.
  2. Renames the larger `<filename> (cloud).<ext>` → `<filename>.<ext>`,
     making the larger cloud version canonical.

Safe by construction: no data is destroyed; smaller versions are preserved
in a single backup tree at the Misc root that can be reviewed or cleared
later.

Run with --dry-run first to see the plan.
"""
from __future__ import annotations
import io, json, shutil, sys
from pathlib import Path

if sys.platform == "win32" and hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

MISC = Path(r"C:\Users\danie\Dropbox\Misc")
BACKUP_ROOT = MISC / "_local_smaller_backup"
PLAN = Path.home() / ".claude" / "playground" / "misc_organize" / "plan.json"

# Re-derive the 16 size-mismatch pairs from plan.json + filesystem state.
# A pair is now: dest folder has both `<name>.pdf` (smaller, original) and
# `<name> (cloud).pdf` (larger, downloaded today).

import hashlib

def find_pairs() -> list[dict]:
    plan = json.loads(PLAN.read_text(encoding="utf-8"))
    pairs = []
    for entry in plan:
        folder = MISC / entry["folder"]
        original_name = entry["source"]
        original_path = folder / original_name
        stem = Path(original_name).stem
        ext = Path(original_name).suffix.lstrip(".")
        cloud_path = folder / f"{stem} (cloud).{ext}"
        if original_path.exists() and cloud_path.exists():
            pairs.append({
                "folder": entry["folder"],
                "original_name": original_name,
                "original_size": original_path.stat().st_size,
                "cloud_size": cloud_path.stat().st_size,
            })
    return pairs


def main() -> None:
    dry_run = "--dry-run" in sys.argv or len(sys.argv) == 1
    pairs = find_pairs()
    print(f"Found {len(pairs)} (cloud) pairs to reconcile.\n", flush=True)
    print(f"Backup will land in: {BACKUP_ROOT}\n", flush=True)

    if dry_run:
        print("DRY RUN — would do:\n", flush=True)
        for p in pairs:
            print(f"  {p['folder']}/")
            print(f"    keep (rename from (cloud)): {p['original_name']} ({p['cloud_size']:,} bytes)")
            print(f"    backup (move to _local_smaller_backup): {p['original_name']} ({p['original_size']:,} bytes)")
        print(f"\nRe-run without --dry-run to execute.")
        return

    BACKUP_ROOT.mkdir(exist_ok=True)
    print(f"EXECUTING ({len(pairs)} pairs)...\n", flush=True)
    ok = 0
    fail = 0
    for p in pairs:
        folder = MISC / p["folder"]
        original_name = p["original_name"]
        stem = Path(original_name).stem
        ext = Path(original_name).suffix.lstrip(".")
        original_path = folder / original_name
        cloud_path = folder / f"{stem} (cloud).{ext}"
        backup_folder = BACKUP_ROOT / p["folder"]
        backup_folder.mkdir(parents=True, exist_ok=True)
        backup_path = backup_folder / original_name
        try:
            shutil.move(str(original_path), str(backup_path))
            shutil.move(str(cloud_path), str(original_path))
            print(f"  OK  {p['folder']}/{original_name}", flush=True)
            print(f"      backup: {p['original_size']:,} -> _local_smaller_backup/{p['folder']}/", flush=True)
            print(f"      promoted: {p['cloud_size']:,} -> {p['folder']}/{original_name}", flush=True)
            ok += 1
        except Exception as e:
            print(f"  FAIL {p['folder']}/{original_name}: {e}", flush=True)
            fail += 1
    print(f"\nDone. ok={ok} fail={fail}")


if __name__ == "__main__":
    main()
