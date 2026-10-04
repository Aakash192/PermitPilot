"""Tools the agent may call. Read-only, allowlisted, arguments validated with Pydantic.

Every tool returns (result_for_model, ids_for_map). The model sees a compact JSON
result; the map gets the full list of permit ids the tool produced.
"""
from typing import Literal, Optional

import pandas as pd
from pydantic import BaseModel, Field

from .. import ranker
from ..data import PermitData

MAX_ROWS_TO_MODEL = 25


def _row(r: pd.Series) -> dict:
    return {
        "id": r["permitnum"],
        "address": r["address"],
        "community": r["communityname"],
        "quadrant": r["quadrant"],
        "type": r["category"].replace("Residential - ", ""),
        "status": r["statuscurrent"],
        "homes": int(r["homes"]),
        "homesStated": bool(r["stated"]),
        "homesNeedReview": bool(r["needs_review"]),
        "daysOverTarget": None if pd.isna(r["days_over"]) else int(r["days_over"]),
        "applied": r["applieddate"].strftime("%Y-%m-%d") if pd.notna(r["applieddate"]) else None,
    }


def _rows(df: pd.DataFrame) -> list[dict]:
    return [_row(r) for _, r in df.head(MAX_ROWS_TO_MODEL).iterrows()]


# ---------- argument models (also used to build the JSON schemas) ----------

class SearchPermitsArgs(BaseModel):
    """Find permits by place, type, status or size and sort them."""
    group: Optional[Literal["needs_decision", "hold", "awaiting_release", "history", "all"]] = Field(
        None, description="Queue group. Default needs_decision (files waiting for a planner). 'all' searches everything.")
    quadrant: Optional[Literal["NW", "NE", "SW", "SE"]] = None
    community: Optional[str] = Field(None, description="Community name, e.g. 'Highland Park'.")
    ward: Optional[str] = None
    srg: Optional[Literal["ESTABLISHED", "DEVELOPING", "COMPLETE"]] = Field(None, description="Area type.")
    category: Optional[Literal["multi", "suite", "single"]] = Field(
        None, description="multi = multi-family/rowhouse/townhouse, suite = secondary suites, single = single/semi/duplex.")
    min_homes: Optional[int] = None
    sort: Optional[Literal["pilot", "homes", "oldest", "newest", "overdue"]] = Field(
        None, description="pilot = PermitPilot priority (default), homes = most homes first, oldest = first in first out.")
    limit: Optional[int] = Field(None, description="How many files to return, e.g. 50.")


class RankQueueArgs(BaseModel):
    """Rank this week's review list of files that need a planner decision."""
    mode: Literal["pilot", "fifo"] = Field(description="pilot = PermitPilot priority, fifo = oldest first.")
    capacity: int = Field(description="How many files the team can review this week. Usually 20.")


class CapacityCutArgs(BaseModel):
    """Re-plan the week when planners are lost; returns which files drop out."""
    capacity: int = Field(description="Normal weekly capacity, usually 20.")
    cut_percent: float = Field(description="Percent of capacity lost, e.g. 20 for one in five planners away.")


class GetPermitArgs(BaseModel):
    """Full details of one permit and why it is ranked where it is."""
    permit_id: str = Field(description="Permit number, e.g. DP2025-02163.")


class CompareArgs(BaseModel):
    """Compare oldest-first with PermitPilot for this week's list."""
    capacity: int = Field(description="Weekly capacity, usually 20.")


class ClearMapArgs(BaseModel):
    """Show every permit on the map again."""


# ---------- implementations ----------

def search_permits(data: PermitData, a: SearchPermitsArgs):
    group = None if a.group == "all" else (a.group or "needs_decision")
    df = ranker.search(
        data, group=group, quadrant=a.quadrant, community=a.community, ward=a.ward, srg=a.srg,
        category=a.category, min_homes=a.min_homes, sort=a.sort or "pilot", limit=a.limit,
    )
    result = {
        "matched": int(len(df)),
        "totalHomes": int(df["homes"].sum()),
        "homesNeedReview": int(df["needs_review"].sum()),
        "permits": _rows(df),
    }
    return result, df["permitnum"].tolist()


def rank_queue(data: PermitData, a: RankQueueArgs):
    df = ranker.rank(data, a.mode, a.capacity)
    return {"mode": a.mode, "metrics": ranker.metrics(df), "permits": _rows(df)}, df["permitnum"].tolist()


def simulate_capacity_cut(data: PermitData, a: CapacityCutArgs):
    cut = ranker.capacity_cut(data, a.capacity, a.cut_percent)
    result = {
        "capacityBefore": cut["capacityBefore"],
        "capacityAfter": cut["capacityAfter"],
        "before": ranker.metrics(cut["before"]),
        "after": ranker.metrics(cut["after"]),
        "dropped": _rows(cut["dropped"]),
    }
    return result, cut["after"]["permitnum"].tolist()


def get_permit(data: PermitData, a: GetPermitArgs):
    hit = data.permits[data.permits["permitnum"].str.upper() == a.permit_id.strip().upper()]
    if hit.empty:
        return {"error": f"No permit {a.permit_id}"}, []
    r = hit.iloc[0]
    detail = {
        **_row(r),
        "description": r["description"],
        "srg": r["srg"],
        "group": r["group"],
        "homesBasis": r["basis"],
        "evidenceQuote": r["evidence_quote"],
        "ageDays": None if pd.isna(r["age_days"]) else int(r["age_days"]),
        "targetDays": int(r["target_days"]),
    }
    if r["group"] == "needs_decision":
        ranked = ranker.rank(data, "pilot")
        detail["pilotRank"] = int(ranked.loc[ranked["permitnum"] == r["permitnum"], "rank"].iloc[0])
        detail["queueSize"] = int(len(ranked))
    return detail, [r["permitnum"]]


def compare_rankings(data: PermitData, a: CompareArgs):
    board = ranker.scoreboard(data, a.capacity)
    return board, ranker.rank(data, "pilot", a.capacity)["permitnum"].tolist()


def clear_map(data: PermitData, a: ClearMapArgs):
    return {"ok": True, "message": "Map shows every permit again."}, None


TOOLS = {
    "search_permits": (SearchPermitsArgs, search_permits),
    "rank_queue": (RankQueueArgs, rank_queue),
    "simulate_capacity_cut": (CapacityCutArgs, simulate_capacity_cut),
    "get_permit": (GetPermitArgs, get_permit),
    "compare_rankings": (CompareArgs, compare_rankings),
    "clear_map": (ClearMapArgs, clear_map),
}


def _strict_schema(model: type[BaseModel]) -> dict:
    """OpenAI strict mode: every property required, optional ones nullable, no extras."""
    schema = model.model_json_schema()
    props = {}
    for name, prop in schema.get("properties", {}).items():
        prop = dict(prop)
        prop.pop("default", None)
        prop.pop("title", None)
        if "anyOf" in prop:  # Optional[X] -> X or null
            options = [o for o in prop.pop("anyOf") if o.get("type") != "null"]
            base = options[0]
            prop = {**prop, **base}
            prop["type"] = [base["type"], "null"]
            if "enum" in prop:
                prop["enum"] = [*prop["enum"], None]
        props[name] = prop
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


def openai_tool_specs() -> list[dict]:
    return [
        {
            "type": "function",
            "name": name,
            "description": (model.__doc__ or "").strip(),
            "parameters": _strict_schema(model),
            "strict": True,
        }
        for name, (model, _) in TOOLS.items()
    ]
