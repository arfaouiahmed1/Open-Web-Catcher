export interface LlmCallLike {
  model_name?: unknown;
  model?: unknown;
  input_tokens?: unknown;
  inputTokens?: unknown;
  output_tokens?: unknown;
  outputTokens?: unknown;
  context_window?: unknown;
  contextWindow?: unknown;
}

export function callModel(call: LlmCallLike | null | undefined): string {
  return String((call?.model_name as string | undefined) ?? (call?.model as string | undefined) ?? "");
}

export function callInputTokens(call: LlmCallLike | null | undefined): number {
  return Number((call?.input_tokens as number | undefined) ?? (call?.inputTokens as number | undefined) ?? 0);
}

export function callOutputTokens(call: LlmCallLike | null | undefined): number {
  return Number((call?.output_tokens as number | undefined) ?? (call?.outputTokens as number | undefined) ?? 0);
}

export function callContextWindow(call: LlmCallLike | null | undefined): number {
  return Number((call?.context_window as number | undefined) ?? (call?.contextWindow as number | undefined) ?? 0);
}
