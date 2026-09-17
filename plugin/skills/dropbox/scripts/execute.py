"""Execute the plan.json moves. Collision-safe, atomic-per-file."""

from __future__ import annotations

import io
import json
import shutil
import sys
from pathlib import Path

if sys.platform == "win32" and hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

MISC = Path(r"C:\Users\danie\Dropbox\Misc")
PLAN = Path.home() / ".claude" / "playground" / "misc_organize" / "plan.json"

plan = json.loads(PLAN.read_text(encoding="utf-8"))

moved, skipped, failed = [], [], []

for entry in plan:
    src = MISC / entry["source"]
    dest_dir = MISC / entry["folder"]
    dest = dest_dir / entry["source"]

    if not src.exists():
        failed.append((entry["source"], "source missing"))
        continue
    if not dest_dir.is_dir():
        failed.append((entry["source"], f"dest dir missing: {dest_dir}"))
        continue
    if dest.exists():
        skipped.append((entry["source"], f"already exists at {dest}"))
        continue

    try:
        shutil.move(str(src), str(dest))
        moved.append((entry["source"], entry["folder"]))
        print(f"[OK]   {entry['source']}")
        print(f"       -> {entry['folder']}/")
    except Exception as e:
        failed.append((entry["source"], str(e)))
        print(f"[FAIL] {entry['source']}: {e}")

print()
print(f"Moved:   {len(moved)}")
print(f"Skipped: {len(skipped)}")
print(f"Failed:  {len(failed)}")

if skipped:
    print("\nSkipped:")
    for name, reason in skipped:
        print(f"  - {name}: {reason}")

if failed:
    print("\nFailed:")
    for name, reason in failed:
        print(f"  - {name}: {reason}")

remaining = sorted(p.name for p in MISC.iterdir() if p.is_file() and p.suffix.lower() == ".pdf")
print(f"\nRemaining loose PDFs at Misc top level: {len(remaining)}")
for name in remaining:
    print(f"  - {name}")
