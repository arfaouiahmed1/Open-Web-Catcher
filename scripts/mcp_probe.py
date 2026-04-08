import asyncio
import time

from langchain_mcp_adapters.client import MultiServerMCPClient


async def main() -> None:
    client = MultiServerMCPClient(
        {
            "classification": {
                "url": "http://owc-tools:3000/mcp/classification/sse",
                "transport": "sse",
            }
        }
    )

    started = time.time()
    try:
        tools = await asyncio.wait_for(client.get_tools(), timeout=8)
        print("get_tools_ok", len(tools), round(time.time() - started, 2))
    except Exception as exc:
        print("get_tools_err", type(exc).__name__, str(exc), round(time.time() - started, 2))


if __name__ == "__main__":
    asyncio.run(main())
