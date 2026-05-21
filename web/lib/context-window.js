export function callModel(call) {
  return call?.model_name || call?.model || "";
}

export function callInputTokens(call) {
  return Number(call?.input_tokens ?? call?.inputTokens ?? 0);
}

export function callOutputTokens(call) {
  return Number(call?.output_tokens ?? call?.outputTokens ?? 0);
}

export function callContextWindow(call) {
  return Number(call?.context_window ?? call?.contextWindow ?? 0);
}
