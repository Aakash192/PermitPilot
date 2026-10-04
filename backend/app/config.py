"""Settings read from the environment (backend/.env in development)."""
import os
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BACKEND_DIR / "data"

load_dotenv(BACKEND_DIR / ".env")

PERMITS_CSV = Path(os.getenv("PERMITS_CSV", DATA_DIR / "permits.csv"))
EXTRACTIONS_JSON = Path(os.getenv("EXTRACTIONS_JSON", DATA_DIR / "extractions.json"))

# Pinned "today" so rankings are reproducible from run to run.
AS_OF = os.getenv("AS_OF", "2026-10-03")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "")
OPENAI_EMBED_MODEL = os.getenv("OPENAI_EMBED_MODEL", "")

CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]
