"""PermitPilot API. Run: uvicorn app.main:app --reload --port 8000 (from backend/)."""
import json
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import config, ranker
from .agent.loop import run_agent
from .data import get_data, to_api

app = FastAPI(title="PermitPilot API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    data = get_data()
    return {
        "ok": True,
        "asOf": data.as_of.strftime("%Y-%m-%d"),
        "permits": int(len(data.permits)),
        "skippedNoLocation": data.skipped_no_location,
        "agentEnabled": bool(config.OPENAI_API_KEY and config.OPENAI_MODEL),
    }


@app.get("/api/summary")
def summary() -> dict:
    """Counts per status group and the learned review targets (for the dashboard strip)."""
    data = get_data()
    return {
        "groups": data.permits["group"].value_counts().to_dict(),
        "targetDays": {k: int(v) for k, v in sorted(data.targets.items(), key=lambda kv: -kv[1])},
        "defaultTargetDays": int(data.default_target),
    }


@app.get("/api/permits")
def permits() -> list[dict]:
    data = get_data()
    return [to_api(row) for _, row in data.permits.iterrows()]


@app.get("/api/permits/{permit_id}")
def permit(permit_id: str) -> dict:
    data = get_data()
    hit = data.permits[data.permits["permitnum"] == permit_id]
    if hit.empty:
        raise HTTPException(status_code=404, detail=f"No permit {permit_id}")
    record = to_api(hit.iloc[0])
    if record["group"] == "needs_decision":
        ranked = ranker.rank(data, "pilot")
        record["rank"] = int(ranked.loc[ranked["permitnum"] == permit_id, "rank"].iloc[0])
        record["queueSize"] = int(len(ranked))
    return record


@app.get("/api/queue")
def queue(
    mode: Literal["fifo", "pilot"] = "pilot",
    capacity: int = Query(20, ge=1, le=500),
) -> list[dict]:
    rows = ranker.rank(get_data(), mode, capacity)
    return [{**to_api(row), "rank": int(row["rank"]), "score": round(float(row["score"]), 2)} for _, row in rows.iterrows()]


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    history: list[dict] = Field(default_factory=list, description="Earlier {role, content} turns, oldest first.")


@app.post("/api/chat")
def chat(body: ChatRequest) -> dict:
    """The AI agent. 503 means no OpenAI key is set; the frontend falls back to its local agent."""
    if not (config.OPENAI_API_KEY and config.OPENAI_MODEL):
        raise HTTPException(status_code=503, detail="Agent disabled: set OPENAI_API_KEY and OPENAI_MODEL in backend/.env")
    history = [
        {"role": turn["role"], "content": str(turn["content"])}
        for turn in body.history[-10:]
        if turn.get("role") in ("user", "assistant") and turn.get("content")
    ]
    try:
        return run_agent(body.message, get_data(), history)
    except Exception as exc:  # network, auth or rate-limit errors from OpenAI
        raise HTTPException(status_code=502, detail=f"Agent error: {type(exc).__name__}") from exc


@app.get("/api/corridor")
def corridor() -> dict:
    """Transportation Utility Corridor shapes (GeoJSON) for a map layer."""
    if not config.TUC_GEOJSON.exists():
        raise HTTPException(status_code=404, detail="No corridor file")
    return json.loads(config.TUC_GEOJSON.read_text(encoding="utf-8"))


@app.get("/api/scoreboard")
def scoreboard(
    capacity: int = Query(20, ge=1, le=500),
    cut: float = Query(20, ge=0, le=90),
) -> dict:
    return ranker.scoreboard(get_data(), capacity, cut)
