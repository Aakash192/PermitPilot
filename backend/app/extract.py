"""Read every permit description once with an LLM and cache the home counts.

Run from backend/:  python -m app.extract            (only new descriptions are sent)
                    python -m app.extract --eval      (accuracy vs data/ground_truth.csv)

Cost: about 740 short descriptions, a few cents with a small model. Results are written to
data/extractions.json, which is committed so the demo never depends on the API.
"""
import argparse
import json
import sys

import pandas as pd
from pydantic import BaseModel, Field

from . import config
from .homes import estimate_homes_regex, load_extractions

PROMPT = """You read City of Calgary development-permit descriptions and count the homes (dwelling units) each one creates.
Rules:
- A secondary suite or backyard suite is 1 home. A single-detached house is 1. Semi-detached or duplex is 2.
- Rowhouse/townhouse buildings with suites: each suite sits inside a dwelling, so count dwellings plus suites.
- Additions, renovations, garages, decks and balconies create 0 new homes.
- If the text states a unit count, use it.
- If you cannot tell the count from the text (e.g. "2 BUILDINGS" with no units), give your best estimate and set needs_review to true.
- evidence_quote must be copied exactly, character for character, from the description."""


class HomeRead(BaseModel):
    housing_type: str = Field(description="Short label, e.g. 'rowhouse with suites', 'basement suite', 'addition'.")
    homes: int = Field(description="Number of new homes this permit creates.")
    is_new_housing: bool
    evidence_quote: str = Field(description="Exact substring of the description that supports the count.")
    needs_review: bool = Field(description="True if the count is an estimate a planner should confirm.")
    reasoning: str = Field(description="One short sentence explaining the count.")


def read_one(client, description: str, category: str) -> dict:
    response = client.responses.parse(
        model=config.OPENAI_MODEL,
        instructions=PROMPT,
        input=f"Category: {category}\nDescription: {description}",
        text_format=HomeRead,
        store=False,
    )
    parsed = response.output_parsed
    if parsed is None:  # refusal or empty output
        return {"error": "no parsed output", "needs_review": True}
    result = parsed.model_dump()
    # Evidence check: the quote must really be in the text, otherwise we do not trust the count.
    if not result["evidence_quote"] or result["evidence_quote"] not in description:
        result["needs_review"] = True
        result["evidence_ok"] = False
    else:
        result["evidence_ok"] = True
    return result


def run_extraction() -> None:
    if not (config.OPENAI_API_KEY and config.OPENAI_MODEL):
        sys.exit("Set OPENAI_API_KEY and OPENAI_MODEL in backend/.env first.")
    from openai import OpenAI

    client = OpenAI(api_key=config.OPENAI_API_KEY)
    df = pd.read_csv(config.PERMITS_CSV).dropna(subset=["description"])
    unique = df.drop_duplicates("description")[["description", "category"]]
    cache = load_extractions(config.EXTRACTIONS_JSON)
    todo = [(d, c) for d, c in zip(unique["description"], unique["category"]) if d not in cache]
    print(f"{len(unique)} unique descriptions, {len(cache)} cached, {len(todo)} to read.")

    for i, (description, category) in enumerate(todo, 1):
        try:
            cache[description] = read_one(client, description, category)
        except Exception as exc:  # keep going; failed rows fall back to the regex estimate
            if getattr(exc, "code", None) in ("insufficient_quota", "credit_balance_exhausted"):
                config.EXTRACTIONS_JSON.write_text(json.dumps(cache, indent=1, ensure_ascii=False), encoding="utf-8")
                sys.exit(f"OpenAI account is out of credits ({exc.code}). Add credits, then rerun; {len(cache)} reads saved.")
            print(f"  failed: {description[:60]}... ({type(exc).__name__})")
            continue
        if i % 25 == 0 or i == len(todo):
            config.EXTRACTIONS_JSON.write_text(json.dumps(cache, indent=1, ensure_ascii=False), encoding="utf-8")
            print(f"  {i}/{len(todo)} saved")


def run_eval() -> None:
    """Compare regex and LLM home counts against KM's hand-checked sheet."""
    truth_path = config.DATA_DIR / "ground_truth.csv"
    truth = pd.read_csv(truth_path).dropna(subset=["true_homes"])
    if truth.empty:
        sys.exit(f"Fill in the true_homes column in {truth_path} first.")
    cache = load_extractions(config.EXTRACTIONS_JSON)
    rows = []
    for _, r in truth.iterrows():
        regex = estimate_homes_regex(r["category"], r["description"])["homes"]
        llm = cache.get(r["description"], {}).get("homes")
        rows.append({"true": int(r["true_homes"]), "regex": regex, "llm": llm})
    res = pd.DataFrame(rows)
    print(f"Checked rows: {len(res)}")
    print(f"Regex exact matches: {(res['regex'] == res['true']).mean():.0%}  mean error {abs(res['regex'] - res['true']).mean():.1f} homes")
    scored = res.dropna(subset=["llm"])
    if len(scored):
        print(f"LLM exact matches:   {(scored['llm'] == scored['true']).mean():.0%}  mean error {abs(scored['llm'] - scored['true']).mean():.1f} homes  ({len(scored)} rows read)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--eval", action="store_true")
    args = parser.parse_args()
    run_eval() if args.eval else run_extraction()
