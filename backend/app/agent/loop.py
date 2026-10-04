"""The agent loop: model picks tools, we run them, the model explains the result.

Returns the shape of frontend/src/types.ts `AgentResult` ({mode, reply, ids, picks})
plus `actions` (tool trace) so the chat panel can show what the agent did.
"""
import json
from typing import Any

from pydantic import ValidationError

from .. import config
from ..data import PermitData
from .tools import TOOLS, openai_tool_specs

MAX_TURNS = 6

INSTRUCTIONS = """You are PermitPilot, an assistant for City of Calgary development-permit planners.
You help decide which residential permit files to review first so more homes get approved sooner.

Rules:
- Always use the tools to get permits, rankings and numbers. Never invent permit ids, counts or dates.
- "The queue" means files that need a planner decision (group needs_decision) unless the user asks otherwise.
- Home counts marked homesNeedReview are estimates; say "about" and mention a planner should confirm them.
- If the user asks for a list (e.g. "top 50 multi-family"), call search_permits with a limit and the right filters.
- If the user mentions losing planners or staff, call simulate_capacity_cut right away. Unless the user says otherwise, assume a team of 10 planners clearing 20 files a week, so each planner lost is 10% (two planners = cut_percent 20). State that assumption in one short phrase in the reply.
- Keep replies short: 2 to 4 sentences, plain language, then the key numbers. The map shows the list, so do not repeat every permit.
- If a request is unclear, ask one short clarifying question without calling tools."""


def _client():
    from openai import OpenAI  # imported lazily so the API runs without the package configured
    return OpenAI(api_key=config.OPENAI_API_KEY)


def run_agent(message: str, data: PermitData, history: list[dict] | None = None, client: Any = None) -> dict:
    client = client or _client()
    tools = openai_tool_specs()
    items: list[Any] = [*(history or []), {"role": "user", "content": message}]
    actions: list[dict] = []
    ids: list[str] | None = None
    reset = False

    for _ in range(MAX_TURNS):
        response = client.responses.create(
            model=config.OPENAI_MODEL,
            instructions=INSTRUCTIONS,
            input=items,
            tools=tools,
            store=False,
        )
        calls = [item for item in response.output if getattr(item, "type", None) == "function_call"]
        if not calls:
            return _result(response.output_text, ids, reset, actions, data)

        items.extend(response.output)
        for call in calls:
            output, call_ids = _dispatch(call.name, call.arguments, data, actions)
            if call.name == "clear_map":
                reset, ids = True, None
            elif call_ids is not None:
                reset, ids = False, call_ids
            items.append({"type": "function_call_output", "call_id": call.call_id, "output": json.dumps(output, default=str)})

    return _result("I could not finish that request. Try asking in a simpler way.", ids, reset, actions, data)


def _dispatch(name: str, raw_args: str, data: PermitData, actions: list[dict]) -> tuple[dict, list[str] | None]:
    if name not in TOOLS:
        actions.append({"tool": name, "ok": False, "error": "unknown tool"})
        return {"error": f"Unknown tool {name}"}, None
    model, fn = TOOLS[name]
    try:
        args = model.model_validate_json(raw_args or "{}")
    except ValidationError as exc:
        actions.append({"tool": name, "ok": False, "error": "invalid arguments"})
        return {"error": "Invalid arguments", "details": exc.errors(include_url=False)}, None
    result, call_ids = fn(data, args)
    actions.append({"tool": name, "ok": "error" not in result, "args": args.model_dump(exclude_none=True)})
    return result, call_ids


def _result(reply: str, ids: list[str] | None, reset: bool, actions: list[dict], data: PermitData) -> dict:
    if reset:
        mode = "reset"
    elif ids is not None:
        mode = "filter"
    else:
        mode = "clarify"
    picks = []
    if ids:
        by_id = data.permits.set_index("permitnum")
        for pid in ids[:6]:
            r = by_id.loc[pid]
            picks.append({
                "id": pid,
                "homes": int(r["homes"]),
                "stated": bool(r["stated"]),
                "address": r["address"],
                "community": r["communityname"],
                "status": r["statuscurrent"],
            })
    return {"mode": mode, "reply": reply.strip(), "ids": ids or [], "picks": picks, "actions": actions}
