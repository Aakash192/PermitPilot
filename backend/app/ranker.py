"""Ranking and filtering. All numbers the agent reports come from here, never from the LLM."""
from typing import Literal

import pandas as pd

from .data import PermitData

Mode = Literal["fifo", "pilot"]
ESTABLISHED_WEIGHT = 1.1


def pilot_score(df: pd.DataFrame) -> pd.Series:
    """Homes created, boosted by how far past the learned target the file is."""
    overdue_ratio = df["days_over"].fillna(0) / df["target_days"].clip(lower=1)
    area = df["srg"].map({"ESTABLISHED": ESTABLISHED_WEIGHT}).fillna(1.0)
    return df["homes"] * (1 + overdue_ratio) * area


def rank(data: PermitData, mode: Mode = "pilot", capacity: int | None = None) -> pd.DataFrame:
    """Order the files that need a planner decision. `capacity` keeps the top N."""
    queue = data.permits[data.permits["group"] == "needs_decision"].copy()
    if mode == "fifo":
        queue = queue.sort_values(["applieddate", "permitnum"])
        queue["score"] = 0.0
    else:
        queue["score"] = pilot_score(queue)
        queue = queue.sort_values(["score", "applieddate"], ascending=[False, True])
    queue["rank"] = range(1, len(queue) + 1)
    return queue.head(capacity) if capacity else queue


def metrics(rows: pd.DataFrame) -> dict:
    return {
        "filesInList": int(len(rows)),
        "homesInList": int(rows["homes"].sum()),
        "multifamilyFiles": int(rows["is_multi"].sum()),
        "overdueDaysCleared": int(rows["days_over"].fillna(0).sum()),
        "needsReview": int(rows["needs_review"].sum()),
    }


def capacity_cut(data: PermitData, capacity: int, cut_percent: float) -> dict:
    """What happens to this week's list when planner capacity drops."""
    before = rank(data, "pilot", capacity)
    reduced = max(1, round(capacity * (1 - cut_percent / 100)))
    after = rank(data, "pilot", reduced)
    dropped = before[~before["permitnum"].isin(after["permitnum"])]
    return {"capacityBefore": capacity, "capacityAfter": reduced, "before": before, "after": after, "dropped": dropped}


def scoreboard(data: PermitData, capacity: int = 20, cut_percent: float = 20) -> dict:
    fifo = rank(data, "fifo", capacity)
    pilot = rank(data, "pilot", capacity)
    cut = capacity_cut(data, capacity, cut_percent)
    return {
        "capacity": capacity,
        "queueSize": int((data.permits["group"] == "needs_decision").sum()),
        "fifo": metrics(fifo),
        "pilot": metrics(pilot),
        "pilotCut": {**metrics(cut["after"]), "capacity": cut["capacityAfter"],
                     "droppedIds": cut["dropped"]["permitnum"].tolist()},
    }


CATEGORY_PATTERNS = {
    "multi": r"multi-family|multi family|multi-residential|rowhouse|row house|townhouse",
    "suite": r"suite|secondary",
    "single": r"single|semi|duplex|contextual",
}


def search(
    data: PermitData,
    *,
    group: str | None = "needs_decision",
    quadrant: str | None = None,
    community: str | None = None,
    ward: str | None = None,
    srg: str | None = None,
    category: str | None = None,
    status: str | None = None,
    min_homes: int | None = None,
    sort: str = "pilot",
    limit: int | None = None,
) -> pd.DataFrame:
    """Filter and sort permits. `group=None` searches every status."""
    df = data.permits
    if group:
        df = df[df["group"] == group]
    if quadrant:
        df = df[df["quadrant"] == quadrant.upper()]
    if community:
        df = df[df["communityname"].str.lower() == community.lower()]
    if ward:
        df = df[df["ward"] == str(ward)]
    if srg:
        df = df[df["srg"] == srg.upper()]
    if category in CATEGORY_PATTERNS:
        blob = (df["category"] + " " + df["description"]).str.lower()
        df = df[blob.str.contains(CATEGORY_PATTERNS[category], regex=True)]
    if status:
        df = df[df["statuscurrent"].str.lower() == status.lower()]
    if min_homes:
        df = df[df["homes"] >= min_homes]

    df = df.copy()
    if sort == "homes":
        df = df.sort_values(["homes", "days_over"], ascending=[False, False])
    elif sort == "oldest":
        df = df.sort_values("applieddate")
    elif sort == "newest":
        df = df.sort_values("applieddate", ascending=False)
    elif sort == "overdue":
        df = df.sort_values("days_over", ascending=False)
    else:
        df["score"] = pilot_score(df)
        df = df.sort_values(["score", "applieddate"], ascending=[False, True])
    return df.head(limit) if limit else df
