"""Gemini on Vertex AI: the one place the backend talks to the LLM.

Only aggregates and column-level statistics are ever sent; student rows and IDs never leave the backend.
Callers get None back when the model is unavailable and fall back to deterministic logic.
"""

import json
import logging
from typing import Any, Callable

from ..config import settings
from . import usage

log = logging.getLogger(__name__)
_client = None
_working: str | None = None  # the model that last answered; tried first next time


def client():
    global _client
    if _client is None:
        from google import genai
        from google.genai import types

        _client = genai.Client(vertexai=True, project=settings().gcp_project or None, location=settings().gemini_location,
                               http_options=types.HttpOptions(timeout=60_000))
    return _client


def _models() -> list[str]:
    s = settings()
    return [m for m in dict.fromkeys([_working, s.gemini_model, *s.gemini_fallbacks.split(",")]) if m]


def generate(
    prompt: str,
    *,
    system: str,
    schema: Any = None,
    tools: list[Callable] | None = None,
    thinking: int = 0,
    max_tokens: int = 2048,
    temperature: float = 0.2,
    on_text: Callable[[str], None] | None = None,
    fast: bool = False,
    purpose: str = "other",
) -> Any:
    """Text, or parsed JSON when a response schema is given. Tools are plain Python functions Gemini may call.
    With on_text, the answer is streamed and on_text gets the text received so far (for live progress).
    purpose says what the call was for, in the usage ledger."""
    from google.genai import types

    cfg: dict = {
        "system_instruction": system,
        "temperature": temperature,
        "max_output_tokens": max_tokens + thinking,
        "thinking_config": {"thinking_budget": thinking},
    }
    if schema is not None:
        cfg.update(response_mime_type="application/json", response_schema=schema)
    if tools:
        cfg.update(tools=tools, automatic_function_calling={"maximum_remote_calls": 8})
    global _working
    for model in ([settings().gemini_fast_model] if fast else []) + _models():
        try:
            if on_text is None:
                reply = client().models.generate_content(model=model, contents=prompt, config=types.GenerateContentConfig(**cfg))
                text, tokens = reply.text or "", reply.usage_metadata
            else:
                text, tokens = "", None
                for chunk in client().models.generate_content_stream(model=model, contents=prompt, config=types.GenerateContentConfig(**cfg)):
                    text += chunk.text or ""
                    tokens = chunk.usage_metadata or tokens
                    on_text(text)
        except Exception as e:  # retired, not served here, or too slow: try the next model
            log.warning("gemini %s failed: %s", model, str(e)[:200])
            continue
        if not fast:
            _working = model
        if tokens is not None:  # as billed: thinking counts as output. With tools this is the last turn, whose prompt holds the earlier ones
            usage.record("ai", purpose, model=model, input_tokens=tokens.prompt_token_count or 0,
                         output_tokens=(tokens.candidates_token_count or 0) + (tokens.thoughts_token_count or 0))
        text = text.strip()
        if not text:
            return None
        try:
            return json.loads(text) if schema is not None else text
        except json.JSONDecodeError:
            log.warning("gemini %s returned malformed JSON", model)
            return None
    return None
