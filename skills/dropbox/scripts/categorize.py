"""Categorize loose top-level PDFs in Dropbox/Misc into existing subdirs.

RLM pattern: LOAD each PDF into memory -> EXAMINE first page (title+abstract)
-> PROCESS each one with llm_query (Sonnet), forced to pick from the existing
taxonomy -> AGGREGATE into a JSON plan. Dry-run only; no moves."""

from __future__ import annotations

import io
import json
import re
import sys
from pathlib import Path

# Console UTF-8 for em-dashes in titles
if sys.platform == "win32" and hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

SCRIPTS = Path.home() / ".claude" / "skills" / "rlm" / "scripts"
sys.path.insert(0, str(SCRIPTS))
from rlm_query import llm_query  # noqa: E402

import pdfplumber  # auto-installed by rlm scripts on first use

MISC = Path(r"C:\Users\danie\Dropbox\Misc")

# Allowed destinations = every immediate subdir of Misc that exists now.
# We snapshot this list so the model is forced to pick an existing folder.
ALLOWED = sorted(
    p.name for p in MISC.iterdir()
    if p.is_dir() and not p.name.startswith(".") and p.name != "createfileglobal"
)

SYSTEM = (
    "You categorize a single PDF into exactly one folder from a fixed list. "
    "Respond with ONLY a JSON object: "
    '{"folder": "<exact folder name from allowed list>", '
    '"confidence": "high"|"medium"|"low", '
    '"reason": "<one short sentence>"}'
)


def extract_first_pages(pdf_path: Path, n_pages: int = 2, max_chars: int = 6000) -> str:
    """Extract text from the first few pages (where title + abstract live)."""
    try:
        with pdfplumber.open(pdf_path) as pdf:
            chunks = []
            for page in pdf.pages[:n_pages]:
                txt = page.extract_text() or ""
                chunks.append(txt)
            text = "\n\n".join(chunks)
            return text[:max_chars]
    except Exception as e:
        return f"[extract failed: {e}]"


def build_prompt(filename: str, first_page_text: str) -> str:
    allowed_list = "\n".join(f"  - {name}" for name in ALLOWED)
    return (
        f"FILENAME: {filename}\n\n"
        f"FIRST-PAGE TEXT (title + abstract + intro):\n"
        f"---\n{first_page_text}\n---\n\n"
        f"ALLOWED FOLDERS (pick exactly one, by exact name):\n{allowed_list}\n\n"
        f"Pick the single best folder for this PDF based on its actual topic. "
        f"If the PDF is about LLMs, transformers, RL for AI models, or AI agents, "
        f"use AI-ML-Papers. If it is a personal letter, use Personal-Documents. "
        f"Return ONLY the JSON object, no prose."
    )


def categorize_one(pdf: Path) -> dict:
    text = extract_first_pages(pdf)
    prompt = build_prompt(pdf.name, text)
    raw = llm_query(prompt, system=SYSTEM, max_tokens=300, temperature=0.0)
    # Strip possible code fences
    raw_clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip(), flags=re.MULTILINE)
    try:
        data = json.loads(raw_clean)
    except json.JSONDecodeError:
        # Fallback: find first {...} block
        m = re.search(r"\{.*\}", raw_clean, re.DOTALL)
        data = json.loads(m.group(0)) if m else {"folder": "Uncategorized-Papers", "confidence": "low", "reason": f"parse error: {raw[:100]}"}
    data["source"] = pdf.name
    data["dest"] = str(MISC / data["folder"] / pdf.name)
    # Validate folder exists
    if data["folder"] not in ALLOWED:
        data["_warning"] = f"model picked non-existent folder '{data['folder']}'; falling back"
        data["folder"] = "Uncategorized-Papers"
        data["dest"] = str(MISC / "Uncategorized-Papers" / pdf.name)
    return data


def main() -> None:
    loose_pdfs = sorted(
        p for p in MISC.iterdir()
        if p.is_file() and p.suffix.lower() == ".pdf"
    )
    print(f"Found {len(loose_pdfs)} loose PDF(s) at top level.")
    print(f"Allowed destinations: {len(ALLOWED)} subdirs.\n")

    plan = []
    for i, pdf in enumerate(loose_pdfs, 1):
        print(f"[{i}/{len(loose_pdfs)}] {pdf.name}")
        result = categorize_one(pdf)
        plan.append(result)
        warn = f"  !! {result.get('_warning')}" if "_warning" in result else ""
        print(f"    -> {result['folder']} ({result['confidence']}): {result['reason']}{warn}\n")

    out = Path.home() / ".claude" / "playground" / "misc_organize" / "plan.json"
    out.write_text(json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Plan written: {out}")


if __name__ == "__main__":
    main()
