#!/usr/bin/env python
"""Local RedisVL / Hugging Face embedding helper for FerbAI.

Reads JSON from stdin:
  {"text": "...", "model": "sentence-transformers/all-MiniLM-L6-v2"}

Writes JSON to stdout:
  {"embedding": [...], "model": "...", "dims": 384}
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from functools import lru_cache
from typing import Any


DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


def _error(message: str, code: int = 1) -> None:
    print(json.dumps({"error": message}), file=sys.stderr)
    raise SystemExit(code)


@lru_cache(maxsize=2)
def _vectorizer(model: str):
    try:
        from redisvl.utils.vectorize import HFTextVectorizer
    except Exception as exc:  # pragma: no cover - depends on local Python env
        _error(
            "Missing RedisVL sentence-transformers dependencies. "
            "Install with: pip install -r requirements.txt. "
            f"Import error: {exc}"
        )

    try:
        return HFTextVectorizer(model=model)
    except TypeError:
        # Older RedisVL versions used model_name for Hugging Face vectorizers.
        return HFTextVectorizer(model_name=model)


def _embed(text: str, model: str) -> list[float]:
    vectorizer = _vectorizer(model)
    try:
        embedding = vectorizer.embed(text)
    except TypeError:
        embedding = vectorizer.embed(text, as_buffer=False)

    if hasattr(embedding, "tolist"):
        embedding = embedding.tolist()
    return [float(value) for value in embedding]


def _read_payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        _error(f"Invalid JSON payload: {exc}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate local text embeddings with RedisVL HFTextVectorizer.")
    parser.add_argument("--health", action="store_true", help="Load the model and return metadata.")
    args = parser.parse_args()

    payload = _read_payload()
    model = payload.get("model") or os.environ.get("MEMORY_HF_MODEL") or DEFAULT_MODEL
    text = payload.get("text") or ("FerbAI local embedding health check." if args.health else "")
    if not text:
        _error("Payload must include non-empty text.")

    embedding = _embed(str(text), str(model))
    if not embedding:
        _error("Embedding model returned an empty vector.")

    if args.health:
        print(json.dumps({"ok": True, "model": model, "dims": len(embedding)}))
        return

    print(json.dumps({"embedding": embedding, "model": model, "dims": len(embedding)}))


if __name__ == "__main__":
    main()
