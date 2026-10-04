"""Home counts per permit.

`estimate_homes_regex` is a line-for-line port of frontend/src/homes.ts and is the
baseline. LLM extractions (built offline by app.extract) override it when present.
"""
import json
import re
from pathlib import Path


def estimate_homes_regex(category: str, description: str) -> dict:
    units = sum(int(m) for m in re.findall(r"(\d+)\s*units", description, flags=re.I))
    if units > 0:
        return {"homes": units, "stated": True, "basis": "Unit count is written on the file."}

    buildings = sum(int(m) for m in re.findall(r"(\d+)\s*buildings?", description, flags=re.I))
    desc = description.lower()
    cat = category.lower()
    multi = bool(
        re.search(r"multi-family|multi family|multi-residential|rowhouse|row house", desc)
        or re.search(r"multi-family|rowhouse", cat)
    )

    if multi and buildings > 0:
        plural = "" if buildings == 1 else "s"
        return {
            "homes": buildings * 8,
            "stated": False,
            "basis": f"{buildings} building{plural} on the file, units not stated. Counted as 8 homes per building.",
        }
    if multi:
        return {"homes": 8, "stated": False, "basis": "Multi-family file with no unit count. Counted as 8 homes."}
    if re.search(r"semi-detached|semi detached|\bduplex\b", desc):
        return {"homes": 2, "stated": False, "basis": "Semi-detached or duplex, counted as 2 homes."}
    return {"homes": 1, "stated": False, "basis": "Counted as 1 home."}


def load_extractions(path: Path) -> dict[str, dict]:
    """Cached LLM reads, keyed by the exact permit description text."""
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))
