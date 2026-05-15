import { inspect as inspectFull } from "./inspect_full.js";
import { summarizeEmbeddedInspect } from "./inspect-summaries.js";

export async function inspectEmbedded(params = {}) {
  const data = await inspectFull({
    ...params,
    scanMode: "embedded",
    scroll: params.scroll ?? true,
    scroll_steps: params.scroll_steps ?? 12,
  });
  return summarizeEmbeddedInspect(data);
}
