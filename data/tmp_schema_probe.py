import asyncio
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_google_genai._function_utils import convert_to_genai_function_declarations


async def main() -> None:
    client = MultiServerMCPClient(
        {
            'classification': {
                'url': 'http://owc-tools:3000/mcp/classification/sse',
                'transport': 'sse',
            }
        }
    )
    tools = await asyncio.wait_for(client.get_tools(), timeout=12)
    print('tool_count', len(tools))
    for tool in tools:
        try:
            convert_to_genai_function_declarations([tool])
            print('OK', tool.name)
        except Exception as exc:
            print('FAIL', tool.name, type(exc).__name__, str(exc))


if __name__ == '__main__':
    asyncio.run(main())
