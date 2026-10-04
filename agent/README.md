# PermitPilot agent (Python)

FastAPI service that ranks Calgary's housing-permit review queue and runs the PermitPilot AI agent.
Python does every count and ranking; the LLM only understands the question, picks tools, and explains the result.

## Run it (Windows PowerShell, from `agent/`)

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env        # then add OPENAI_API_KEY and OPENAI_MODEL
python -m uvicorn app.main:app --reload --port 8000
```
Open http://localhost:8000/docs to try every endpoint. Runs separately from the TypeScript server in `backend/`, which can forward chat to it via `HOSTED_AGENT_URL`.

Tests: `python -m pytest -q`

## Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | status, as-of date, whether the agent is enabled |
| GET | `/api/summary` | permit counts per status group + learned review targets |
| GET | `/api/permits` | every permit, in the frontend's `Permit` shape plus `group`, `daysOver`, `targetDays`, `needsReview`, `evidenceQuote`, `homesSource`, `isMulti` |
| GET | `/api/permits/{id}` | one permit, plus its `rank` if it is waiting for a planner |
| GET | `/api/queue?mode=pilot\|fifo&capacity=20` | this week's ranked review list |
| GET | `/api/scoreboard?capacity=20&cut=20` | oldest-first vs PermitPilot vs PermitPilot with fewer planners |
| POST | `/api/chat` `{message, history}` | the agent: `{mode, reply, ids, picks, actions}` (same shape as the frontend's `AgentResult`, plus the tool trace) |

`/api/chat` returns **503** when no OpenAI key is set, so the frontend can fall back to its local agent.

## How the data is used

- **Status groups.** Only `needs_decision` (New, In Circulation, Under Review, Pending Decision: 86 files) is a planner's queue. `hold` waits on the applicant. `awaiting_release` (Pending Release, In Advertising) already has a decision. `history` (Released) teaches real review times.
- **Review targets** are learned from released files: median days from application to decision per category (multi-family 172, secondary suite 42, ...). `daysOver` is measured against these, as of the pinned `AS_OF` date.
- **Home counts.** `app/homes.py` ports the frontend's regex estimate (the baseline). `python -m app.extract` reads every description once with the LLM, checks the evidence quote is really in the text, and caches results in `data/extractions.json`. Uncertain counts are flagged `needsReview`.
- **Ranking.** PermitPilot score = homes x (1 + days over target / target) x 1.1 in established areas.

## The agent (`app/agent/`)

Tools (read-only, allowlisted, arguments validated): `search_permits`, `rank_queue`, `simulate_capacity_cut`, `get_permit`, `compare_rankings`, `clear_map`. The loop stops after 6 model turns; unknown tools and bad arguments are rejected and reported back to the model.

Try: "Show me the top 50 multi-family files with the most homes", "Only the NW ones", "We lost two planners this week, what drops?", "Why is DP2025-02163 ranked where it is?"

## Home-count accuracy check

`data/ground_truth.csv` holds 46 descriptions for a human to label (`true_homes`). Then:
```powershell
python -m app.extract --eval
```
prints regex vs LLM accuracy, a number for the pitch.
