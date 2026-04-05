"""Short-term memory: per-run conversation window (last k messages)."""

from __future__ import annotations

from langchain.memory import ConversationBufferWindowMemory


class ShortTermMemory:
    """Thin wrapper around ConversationBufferWindowMemory for agent use."""

    def __init__(self, k: int = 10) -> None:
        self._memory = ConversationBufferWindowMemory(k=k, return_messages=True)

    def save(self, human: str, ai: str) -> None:
        self._memory.save_context({"input": human}, {"output": ai})

    def load(self) -> list:
        return self._memory.load_memory_variables({}).get("history", [])

    def clear(self) -> None:
        self._memory.clear()
