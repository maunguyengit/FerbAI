#!/usr/bin/env python
"""Warm local embedding worker for FerbAI.

Reads newline-delimited JSON requests from stdin:
  {"id": "req_1", "text": "...", "model": "sentence-transformers/all-MiniLM-L6-v2"}

Writes newline-delimited JSON responses to stdout:
  {"id": "req_1", "embedding": [...], "model": "...", "dims": 384}

The process stays alive so RedisVL / sentence-transformers load once and are
reused for subsequent embedding requests.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from functools import lru_cache
from typing import Any


DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


@lru_cache(maxsize=2)
def _vectorizer(model: str):
    from redisvl.utils.vectorize import HFTextVectorizer

    try:
        return HFTextVectorizer(model=model)
    except TypeError:
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


def _write(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> None:
    default_model = os.environ.get("MEMORY_HF_MODEL") or DEFAULT_MODEL
    _write({"type": "ready", "model": default_model})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
            request_id = str(payload.get("id") or "")
            text = str(payload.get("text") or "")
            model = str(payload.get("model") or default_model)
            if not request_id:
                raise ValueError("Request is missing id.")
            if not text:
                raise ValueError("Request is missing text.")
            embedding = _embed(text, model)
            if not embedding:
                raise ValueError("Embedding model returned an empty vector.")
            _write({"id": request_id, "embedding": embedding, "model": model, "dims": len(embedding)})
        except Exception as exc:
            _write({
                "id": str(locals().get("request_id") or ""),
                "error": str(exc),
                "trace": traceback.format_exc(limit=4),
            })


if __name__ == "__main__":
    main()
