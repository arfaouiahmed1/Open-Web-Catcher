import { inspect as inspectFull } from "./inspect_full.js";
import { summarizeLandingInspect } from "./inspect-summaries.js";

export async function inspectLanding(params = {}) {
  const data = await inspectFull({
    ...params,
    scanMode: "landing",
    scroll: params.scroll ?? true,
    scroll_steps: params.scroll_steps ?? 14,
  });
  return summarizeLandingInspect(data);
}
