"""Final answer validation and repair for agent execution.

Implements the structured finalizer protocol (plan step 6):
- Validates model output against Pydantic schema
- Allows one compact repair turn containing only validation errors
- Rejects coercion of top-level arrays into arbitrary objects
- Emits typed output_invalid failure if the second attempt fails
"""

from __future__ import annotations

import json
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from src.agents.runtime.models import parse_json_object

T = TypeVar("T", bound=BaseModel)


def validate_agent_output(
    raw_text: str,
    schema: type[T] | None = None,
) -> tuple[T | dict[str, Any] | None, str | None]:
    """Parse and validate output against schema.

    Returns (validated_model_or_dict, error_message).
    If valid, error_message is None.
    """
    parsed, parse_error = parse_json_object(raw_text)
    if parse_error:
        return None, f"JSON parse error: {parse_error}"

    if schema is None:
        return parsed, None

    try:
        validated = schema.model_validate(parsed)
        return validated, None
    except ValidationError as exc:
        # Generate compact error summary for the repair prompt
        error_lines = []
        for err in exc.errors():
            loc = ".".join(str(p) for p in err.get("loc", []))
            msg = err.get("msg", "")
            error_lines.append(f"- Field '{loc}': {msg}")
        compact_errors = "\n".join(error_lines[:8])
        return None, f"Schema validation failed:\n{compact_errors}"


def build_repair_prompt(validation_error: str, schema: type[BaseModel] | None = None) -> str:
    """Build a compact repair turn prompt containing only validation errors."""
    schema_hint = ""
    if schema is not None:
        try:
            schema_json = json.dumps(schema.model_json_schema(), indent=2)
            schema_hint = f"\nExpected JSON schema:\n```json\n{schema_json}\n```"
        except Exception:
            schema_hint = ""

    return (
        f"Your previous response had validation errors:\n{validation_error}\n"
        f"{schema_hint}\n"
        "Please output the corrected JSON object now. "
        "Output ONLY the JSON object, with no other text."
    )
