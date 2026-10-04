"""Load the permit file and derive everything the ranker and agent need.

Status groups (only `needs_decision` is a planner's queue):
  needs_decision    New, In Circulation, Under Review, Pending Decision
  hold              Hold (waiting on the applicant)
  awaiting_release  Pending Release, In Advertising (already decided, paperwork left)
  history           Released (used to learn real review times)
"""
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import pandas as pd

from . import config
from .corridor import distances_m, load_polygons
from .homes import estimate_homes_regex, load_extractions

STATUS_GROUP = {
    "new": "needs_decision",
    "in circulation": "needs_decision",
    "under review": "needs_decision",
    "pending decision": "needs_decision",
    "hold": "hold",
    "pending release": "awaiting_release",
    "in advertising": "awaiting_release",
    "released": "history",
    "cancelled": "history",
}

MULTI_PATTERN = r"multi-family|multi family|multi-residential|rowhouse|row house|townhouse"


@dataclass
class PermitData:
    permits: pd.DataFrame          # one row per permit, ready to serve
    targets: dict[str, float]      # learned median review days per category
    default_target: float
    skipped_no_location: int
    as_of: pd.Timestamp


def _is_multi(category: str, description: str) -> bool:
    return bool(re.search(MULTI_PATTERN, f"{category} {description}".lower()))


def build(csv_path: Path, extractions_path: Path, as_of: str) -> PermitData:
    df = pd.read_csv(csv_path)
    df["applieddate"] = pd.to_datetime(df["applieddate"], errors="coerce")
    df["decisiondate"] = pd.to_datetime(df["decisiondate"], errors="coerce")

    has_location = df["latitude"].notna() & df["longitude"].notna()
    skipped = int((~has_location).sum())
    df = df[has_location].copy()

    for col in ["address", "category", "description", "statuscurrent", "communityname", "quadrant", "sector", "srg"]:
        df[col] = df[col].fillna("").astype(str).str.strip()
    df["srg"] = df["srg"].str.upper().replace("", "UNKNOWN")
    df["quadrant"] = df["quadrant"].str.upper()
    df["sector"] = df["sector"].str.upper()
    df["ward"] = df["ward"].apply(lambda w: "" if pd.isna(w) else str(int(w)))
    df["group"] = df["statuscurrent"].str.lower().map(STATUS_GROUP).fillna("other")

    # Real review times from finished files.
    hist = df[(df["group"] == "history") & df["decisiondate"].notna()]
    review_days = (hist["decisiondate"] - hist["applieddate"]).dt.days
    targets = review_days.groupby(hist["category"]).median().to_dict()
    default_target = float(review_days.median()) if len(review_days) else 70.0

    as_of_ts = pd.Timestamp(as_of)
    df["age_days"] = (as_of_ts - df["applieddate"]).dt.days.clip(lower=0)
    df["target_days"] = df["category"].map(targets).fillna(default_target)
    df["days_over"] = (df["age_days"] - df["target_days"]).clip(lower=0)

    # Homes: cached LLM read when available, regex baseline otherwise.
    extractions = load_extractions(extractions_path)
    homes_rows = []
    for category, description in zip(df["category"], df["description"]):
        regex = estimate_homes_regex(category, description)
        llm = extractions.get(description)
        if llm and not llm.get("needs_review"):
            homes_rows.append({
                "homes": int(llm["homes"]),
                "stated": regex["stated"],
                "basis": llm.get("reasoning") or "Read from the permit description.",
                "evidence_quote": llm.get("evidence_quote", ""),
                "needs_review": False,
                "homes_source": "llm",
            })
        else:
            homes_rows.append({
                **regex,
                "evidence_quote": (llm or {}).get("evidence_quote", ""),
                "needs_review": bool(llm and llm.get("needs_review")) or (not regex["stated"] and _is_multi(category, description)),
                "homes_source": "regex",
            })
    homes_df = pd.DataFrame(homes_rows, index=df.index)
    df = pd.concat([df, homes_df], axis=1)
    df["is_multi"] = [_is_multi(c, d) for c, d in zip(df["category"], df["description"])]

    # Distance to the Transportation Utility Corridor (ring road + major utilities).
    df["tuc_m"] = distances_m(df["longitude"], df["latitude"], load_polygons(config.TUC_GEOJSON))
    df["near_corridor"] = df["tuc_m"] <= config.CORRIDOR_NEAR_M

    return PermitData(df, targets, default_target, skipped, as_of_ts)


@lru_cache(maxsize=1)
def get_data() -> PermitData:
    return build(config.PERMITS_CSV, config.EXTRACTIONS_JSON, config.AS_OF)


def to_api(row: pd.Series) -> dict:
    """One permit in the shape of frontend/src/types.ts `Permit`, plus backend extras."""
    applied = row["applieddate"]
    return {
        "id": row["permitnum"],
        "address": row["address"],
        "category": row["category"],
        "description": row["description"],
        "status": row["statuscurrent"],
        "applied": applied.strftime("%Y-%m-%d") if pd.notna(applied) else "",
        "community": row["communityname"],
        "ward": row["ward"],
        "quadrant": row["quadrant"],
        "sector": row["sector"],
        "srg": row["srg"],
        "lat": float(row["latitude"]),
        "lng": float(row["longitude"]),
        "homes": int(row["homes"]),
        "stated": bool(row["stated"]),
        "basis": row["basis"],
        "ageDays": None if pd.isna(row["age_days"]) else int(row["age_days"]),
        "group": row["group"],
        "targetDays": int(row["target_days"]),
        "daysOver": None if pd.isna(row["days_over"]) else int(row["days_over"]),
        "needsReview": bool(row["needs_review"]),
        "evidenceQuote": row["evidence_quote"],
        "homesSource": row["homes_source"],
        "isMulti": bool(row["is_multi"]),
        "corridorMeters": None if pd.isna(row["tuc_m"]) else int(round(row["tuc_m"])),
        "nearCorridor": bool(row["near_corridor"]),
    }
