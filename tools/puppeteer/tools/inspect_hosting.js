import { inspect as inspectFull } from "./inspect_full.js";
import { summarizeHostingInspect } from "./inspect-summaries.js";

export async function inspectHosting(params = {}) {
  const data = await inspectFull({
    ...params,
    scanMode: "hosting",
    scroll: params.scroll ?? true,
    scroll_steps: params.scroll_steps ?? 12,
  });
  return summarizeHostingInspect(data);
}
