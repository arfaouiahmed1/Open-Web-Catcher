# Multi-Agent Pipeline

The core intelligence layer operates as an asynchronous state graph driven by specialized sub-agents. Each agent is bound to a strict persona, output schema, and tool allowance.

---

## The Four Specialized Agents

### 1. Classification Agent
- **Profile**: `classification`
- **Goal**: Analyze the root URL without deep interaction to determine the page architecture.
- **Output**: `ClassificationResult` (`PageType.LANDING`, `PageType.HOSTING`, `PageType.EMBEDDED`, or `PageType.UNKNOWN`) with a numerical confidence score and reasoning trace.
- **Tools**: Read-only navigation and DOM inspection.

### 2. Landing Page Agent
- **Profile**: `landing`
- **Goal**: Navigate index schedules and match directories (e.g. `streamed.pk`, `freeshot.live`).
- **Output**: Array of `MatchInfo` models containing match titles, event times, participants, and server/channel links.
- **Tools**: `navigate`, `inspect`, `interact` (clicking dropdowns, tabs, schedule filters).

### 3. Hosting Page Agent
- **Profile**: `hosting`
- **Goal**: Probe video hosting portals, resolve player servers, and detect embedded player frames.
- **Output**: `ExtractionResult` containing discovered `StreamURL` entries, detected server slots (`ServerResult`), and embedded iframe URLs requiring follow-up.
- **Tools**: Interactive DOM manipulation, popup handling, stream harvesting.

### 4. Embedded Player Agent
- **Profile**: `embedded`
- **Goal**: Overcome hostile iframe sandboxes, anti-debugger traps, and click-to-play overlays to capture live media streams.
- **Output**: Direct `.m3u8` (HLS) or `.mpd` (DASH) stream manifests with cryptographic byte verification.
- **Tools**: Full interaction suite, frame tree traversal, media playback verification.
