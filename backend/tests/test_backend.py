import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import ranker
from app.agent.loop import MAX_TURNS, run_agent
from app.agent.tools import openai_tool_specs
from app.data import get_data
from app.homes import estimate_homes_regex
from app.main import app

client = TestClient(app)


# ---------- data ----------

def test_status_groups():
    groups = get_data().permits["group"].value_counts().to_dict()
    assert groups["needs_decision"] == 86
    assert groups["hold"] == 123            # 124 minus 1 without coordinates
    assert groups["awaiting_release"] == 987
    assert groups["history"] == 799


def test_learned_targets():
    targets = get_data().targets
    assert targets["Residential - Multi-Family"] == 172
    assert targets["Residential - Secondary Suite"] == 42


@pytest.mark.parametrize("category,description,homes,stated", [
    ("Residential - Multi-Family", "NEW: ROWHOUSE BUILDING (6 BUILDINGS, 31 UNITS)", 31, True),
    ("Residential - Multi-Family", "NEW: MULTI-RESIDENTIAL DEVELOPMENT (2 BUILDINGS)", 16, False),
    ("Residential - Multi-Family", "NEW: MULTI-RESIDENTIAL DEVELOPMENT", 8, False),
    ("Residential - New Single / Semi / Duplex", "NEW: SEMI-DETACHED DWELLING", 2, False),
    ("Residential - Secondary Suite", "NEW: SECONDARY SUITE (BASEMENT)", 1, False),
])
def test_regex_matches_frontend(category, description, homes, stated):
    out = estimate_homes_regex(category, description)
    assert (out["homes"], out["stated"]) == (homes, stated)


# ---------- ranking ----------

def test_pilot_beats_fifo_on_homes():
    board = ranker.scoreboard(get_data(), 20, 20)
    assert board["pilot"]["homesInList"] > board["fifo"]["homesInList"]
    assert board["pilotCut"]["filesInList"] == 16
    assert len(board["pilotCut"]["droppedIds"]) == 4


def test_search_filters():
    df = ranker.search(get_data(), quadrant="NW", category="multi", sort="homes", limit=5)
    assert len(df) <= 5
    assert set(df["quadrant"]) <= {"NW"}
    assert list(df["homes"]) == sorted(df["homes"], reverse=True)


# ---------- API ----------

def test_api_endpoints():
    assert client.get("/api/health").json()["ok"] is True
    queue = client.get("/api/queue?mode=pilot&capacity=10").json()
    assert len(queue) == 10 and queue[0]["rank"] == 1
    assert client.get("/api/queue?mode=wrong").status_code == 422
    assert client.get("/api/permits/DP2025-02163").json()["group"] == "needs_decision"
    assert client.get("/api/permits/NOPE").status_code == 404


def test_chat_disabled_without_key(monkeypatch):
    monkeypatch.setattr("app.config.OPENAI_API_KEY", "")
    assert client.post("/api/chat", json={"message": "hi"}).status_code == 503


# ---------- agent loop with a fake OpenAI client ----------

def call(name, args, call_id="c1"):
    return SimpleNamespace(type="function_call", name=name, arguments=json.dumps(args), call_id=call_id)


class FakeClient:
    """Plays back scripted responses and records what the agent sent."""

    def __init__(self, scripted):
        self.scripted = list(scripted)
        self.sent = []
        self.responses = self

    def create(self, **kwargs):
        self.sent.append(kwargs)
        output, text = self.scripted.pop(0)
        return SimpleNamespace(output=output, output_text=text)


NULLS = {k: None for k in ["group", "quadrant", "community", "ward", "srg", "category", "min_homes", "sort", "limit"]}


def test_agent_top_50_multi_family():
    fake = FakeClient([
        ([call("search_permits", {**NULLS, "category": "multi", "sort": "homes", "limit": 50})], ""),
        ([], "Here are the multi-family files with the most homes."),
    ])
    out = run_agent("top 50 multi family files", get_data(), client=fake)
    assert out["mode"] == "filter"
    assert 0 < len(out["ids"]) <= 50
    assert out["actions"][0]["tool"] == "search_permits"
    tool_output = fake.sent[1]["input"][-1]
    assert tool_output["type"] == "function_call_output" and tool_output["call_id"] == "c1"


def test_agent_capacity_cut():
    fake = FakeClient([
        ([call("simulate_capacity_cut", {"capacity": 20, "cut_percent": 20})], ""),
        ([], "Four files move to next week."),
    ])
    out = run_agent("we lost two planners", get_data(), client=fake)
    assert len(out["ids"]) == 16


def test_agent_rejects_unknown_tool_and_bad_args():
    fake = FakeClient([
        ([call("delete_everything", {})], ""),
        ([call("rank_queue", {"mode": "random", "capacity": 20}, "c2")], ""),
        ([], "Sorry."),
    ])
    out = run_agent("do something odd", get_data(), client=fake)
    assert [a["ok"] for a in out["actions"]] == [False, False]
    assert out["mode"] == "clarify"


def test_agent_stops_after_max_turns():
    fake = FakeClient([([call("compare_rankings", {"capacity": 20}, f"c{i}")], "") for i in range(MAX_TURNS)])
    out = run_agent("loop forever", get_data(), client=fake)
    assert len(fake.sent) == MAX_TURNS
    assert "could not finish" in out["reply"]


def test_tool_schemas_are_strict():
    for spec in openai_tool_specs():
        params = spec["parameters"]
        assert spec["strict"] is True
        assert params["additionalProperties"] is False
        assert set(params["required"]) == set(params["properties"])


def test_corridor_distances():
    df = get_data().permits
    assert df["tuc_m"].notna().all()
    near = df[df["near_corridor"]]
    assert 50 < len(near) < 300  # a ring at the city edge, not the whole city
    belvedere = df[df["permitnum"] == "DP2026-01147"].iloc[0]
    assert 50 < belvedere["tuc_m"] < 150 and belvedere["near_corridor"]
    queue_near = ranker.search(get_data(), near_corridor=True)
    assert set(queue_near["group"]) == {"needs_decision"}
    client = TestClient(app)
    assert client.get("/api/corridor").json()["type"] == "FeatureCollection"
