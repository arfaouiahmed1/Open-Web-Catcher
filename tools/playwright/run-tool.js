import { getToolDefinitions } from './tool-registry.js';

const [, , toolName = '', rawPayload = '{}'] = process.argv;

async function main() {
  if (!toolName) {
    throw new Error('Missing tool name');
  }

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${error.message}`);
  }

  const browserWsEndpoint = payload.browserWSEndpoint || payload.browserWsEndpoint || '';
  const args = { ...payload };
  delete args.browserWSEndpoint;
  delete args.browserWsEndpoint;

  const definitions = getToolDefinitions(browserWsEndpoint);
  const definition = definitions[toolName];
  if (!definition) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const result = await definition.handler(args);
  process.stdout.write(JSON.stringify(result));
}

main().catch((error) => {
  process.stderr.write(String(error?.stack || error?.message || error));
  process.exit(1);
});
