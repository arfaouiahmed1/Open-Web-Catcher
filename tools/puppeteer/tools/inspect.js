/**
 * tools/inspect.js - classification-oriented inspect wrapper.
 */

import { inspect as inspectFull } from "./inspect_full.js";
import { summarizeClassificationInspect } from "./inspect-summaries.js";

export async function inspect(params = {}) {
  const data = await inspectFull({
    ...params,
    scanMode: "classification",
    scroll: params.scroll ?? true,
    scroll_steps: params.scroll_steps ?? 6,
  });
  return summarizeClassificationInspect(data);
}
