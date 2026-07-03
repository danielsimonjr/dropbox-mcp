"""Three follow-up actions after the main /Misc sync:

Action 1: Resolve the 3 ambiguous flagged files by moving cloud to the
  latest-modified local copy's location (where size matches cloud).

Action 2: Download the 2 cloud-only .gitignore files (PITS-MRAS and
  universal-physics-tensor) — these are legitimate project files
  Dropbox should have but my sync script's skip-list excluded.

Action 3: Add .dropboxignore (standard template) to the 4 git-repo
  folders under /Misc: PITS-MRAS, Mathjs/develop, Mathjs/master,
  Philosophy/Beyond the Bat. Stops Dropbox from syncing .git internals
  and other build/cache artifacts. Standard template copied from
  ~/Dropbox/Github/beyond-the-bat/.dropboxignore.
"""
from __future__ import annotations
import io, sys
from pathlib import Path

if sys.platform == "win32" and hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

import dropbox

ENV = Path.home() / ".claude" / "channels" / "dropbox" / ".env"
LOCAL_MISC = Path(r"C:\Users\danie\Dropbox\Misc")

env = {}
for line in ENV.read_text(encoding="utf-8").splitlines():
    s = line.strip()
    if s and not s.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()

dbx = dropbox.Dropbox(
    oauth2_refresh_token=env["DROPBOX_REFRESH_TOKEN"],
    app_key=env["DROPBOX_APP_KEY"],
    app_secret=env["DROPBOX_APP_SECRET"],
    timeout=120,
)

# ============================================================
# Action 1: Move 3 ambiguous cloud-root files to canonical local subdir
# ============================================================

ACTION_1_MOVES = [
    {
        "cloud_from": "/Misc/Towards Autonomous Mathematics Research.pdf",
        "cloud_to": "/Misc/AI-ML-Papers/Towards Autonomous Mathematics Research.pdf",
        "rationale": "AI-ML-Papers/ size (3.7MB) matches cloud and has the newer mtime; History-Politics/ has a 404KB different file with the same name (kept untouched).",
    },
    {
        "cloud_from": "/Misc/Disentangling Boltzmann Brains, the Time-Asymmetry of Memory, and the Second Law.pdf",
        "cloud_to": "/Misc/Physics/Disentangling Boltzmann Brains, the Time-Asymmetry of Memory, and the Second Law.pdf",
        "rationale": "Physics/ and Neuroscience/ both have size 369007 matching cloud; Physics/ has the newer mtime so cloud goes there. Neuroscience/ copy left as-is (presumed intentional cross-listing).",
    },
    {
        "cloud_from": "/Misc/Epistemological Fault Lines Between Human and Artificial Intelligence.pdf",
        "cloud_to": "/Misc/AI-ML-Papers/Epistemological Fault Lines Between Human and Artificial Intelligence.pdf",
        "rationale": "AI-ML-Papers/ size (579021) matches cloud and has the newer mtime; Philosophy/ has a 647061-byte different version with the same name (kept untouched).",
    },
]

print("=== Action 1: Move 3 ambiguous cloud-root files to canonical local subdirs ===\n", flush=True)
action1_ok = 0
action1_fail = 0
for m in ACTION_1_MOVES:
    try:
        dbx.files_move_v2(m["cloud_from"], m["cloud_to"], autorename=False)
        print(f"  OK   {m['cloud_from']}")
        print(f"       -> {m['cloud_to']}")
        action1_ok += 1
    except dropbox.exceptions.ApiError as e:
        err_str = str(e)
        if "to/conflict" in err_str or "WriteError('conflict'" in err_str:
            # Destination already exists — delete source
            try:
                dbx.files_delete_v2(m["cloud_from"])
                print(f"  OK   {m['cloud_from']} (dest existed; deleted source)")
                action1_ok += 1
            except Exception as e2:
                print(f"  FAIL {m['cloud_from']}: dest exists + delete failed: {e2}")
                action1_fail += 1
        else:
            print(f"  FAIL {m['cloud_from']}: {e}")
            action1_fail += 1
    except Exception as e:
        print(f"  FAIL {m['cloud_from']}: {e}")
        action1_fail += 1
print(f"\nAction 1: ok={action1_ok} fail={action1_fail}\n")

# ============================================================
# Action 2: Download 2 .gitignore files
# ============================================================

ACTION_2_DOWNLOADS = [
    {"cloud": "/Misc/PITS-MRAS/.gitignore", "local": LOCAL_MISC / "PITS-MRAS" / ".gitignore"},
    {"cloud": "/Misc/universal-physics-tensor/.gitignore", "local": LOCAL_MISC / "universal-physics-tensor" / ".gitignore"},
]

print("=== Action 2: Download 2 .gitignore files ===\n", flush=True)
action2_ok = 0
action2_fail = 0
for d in ACTION_2_DOWNLOADS:
    try:
        if d["local"].exists():
            print(f"  SKIP {d['local']} (already exists locally)")
            action2_ok += 1
            continue
        d["local"].parent.mkdir(parents=True, exist_ok=True)
        _, resp = dbx.files_download(d["cloud"])
        d["local"].write_bytes(resp.content)
        print(f"  OK   {d['cloud']} -> {d['local']}")
        action2_ok += 1
    except Exception as e:
        print(f"  FAIL {d['cloud']}: {e}")
        action2_fail += 1
print(f"\nAction 2: ok={action2_ok} fail={action2_fail}\n")

# ============================================================
# Action 3: Add .dropboxignore to git-repo folders under /Misc
# ============================================================

DROPBOXIGNORE_TEMPLATE = """# Git internals — keeps Dropbox out of .git so git operations don't get blocked
.git/

# Dependencies
node_modules/
__pycache__/
*.py[cod]
.venv/
venv/
env/

# Build artifacts
dist/
build/
*.egg-info/

# Caches
.pytest_cache/
.mypy_cache/
.ruff_cache/
.cache/
.parcel-cache/

# Coverage
coverage/
.coverage
.nyc_output/

# Secrets / env
.env
.env.local
.env.*.local

# OS / editors
.DS_Store
Thumbs.db
*.swp
.vscode/
.idea/
"""

ACTION_3_FOLDERS = [
    LOCAL_MISC / "PITS-MRAS",
    LOCAL_MISC / "Mathjs" / "develop",
    LOCAL_MISC / "Mathjs" / "master",
    LOCAL_MISC / "Philosophy" / "Beyond the Bat",
]

print("=== Action 3: Add .dropboxignore to 4 git-repo folders under /Misc ===\n", flush=True)
action3_ok = 0
action3_fail = 0
for folder in ACTION_3_FOLDERS:
    target = folder / ".dropboxignore"
    try:
        if not folder.exists():
            print(f"  SKIP {folder} (folder does not exist locally)")
            continue
        if target.exists():
            existing = target.read_text(encoding="utf-8")
            if existing.strip() == DROPBOXIGNORE_TEMPLATE.strip():
                print(f"  SKIP {target} (already matches template)")
            else:
                print(f"  SKIP {target} (already exists with different content — not overwriting)")
            action3_ok += 1
            continue
        target.write_text(DROPBOXIGNORE_TEMPLATE, encoding="utf-8")
        print(f"  OK   wrote {target}")
        action3_ok += 1
    except Exception as e:
        print(f"  FAIL {target}: {e}")
        action3_fail += 1
print(f"\nAction 3: ok={action3_ok} fail={action3_fail}\n")

print("=== DONE ===")
print(f"Action 1 (cloud moves):       ok={action1_ok} fail={action1_fail}")
print(f"Action 2 (gitignore download): ok={action2_ok} fail={action2_fail}")
print(f"Action 3 (.dropboxignore):    ok={action3_ok} fail={action3_fail}")
