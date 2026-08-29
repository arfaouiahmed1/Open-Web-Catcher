# Open Web Catcher (OWC) Operator Console — Design System

> Extraction, not invention. Every token, scale, and pattern below is traced 1:1 from the
> existing codebase (`web/app/globals.css`, `web/tailwind.config.mjs`, `web/components/ui/*`,
> `web/components/console/*`). Line references like `(globals.css:L31)` point at
> `web/app/globals.css`. Downstream workers on plan tasks 37 (component library) and 40-43
> (page rebuilds) MUST reference tokens from this document instead of raw values.

---

## 1. Atmosphere & Identity

A dark, evidence-dense operator console for controlled browser investigation. The operator
watches a multi-agent pipeline live: routing decisions, tool calls, screenshots, costs, and
failures stream past in mono-labeled rows. The signature is **signal-on-zinc**: near-black
zinc surfaces (`#09090b`) separated by hairline borders rather than elevation, with a single
warm amber OKLCH accent (`--signal`, hue 64) carrying "active/attention" semantics, plus a
closed five-hue accent ramp (mint / violet / rose / sky) reserved strictly for status and
data-series meaning — never decoration. Atmosphere comes from two fixed radial gradient
washes bleeding off the top corners of the page and an optional 24px grid-paper texture;
depth comes from `--shadow-card` (a 1px ring plus a soft black drop), not from stacked gray
boxes. Density is cockpit-grade: 10-12px uppercase tracked micro-labels, tabular numerals,
mono pills for identifiers, 4px progress bars. Light mode exists as a full zinc-inverted
token set behind `.light`, but dark is the default and the design center.

**Material/color story:** zinc hex surfaces + OKLCH perceptual accents, tinted via
`color-mix(in oklch ...)` at 8-15% for fills and 24-40% for borders. This oklch-vs-hex mix
is deliberate: accents stay perceptually consistent across themes; surfaces are pinned to
Tailwind zinc values for shadcn parity.

---

## 2. Color

### Accent ramp (OKLCH, theme-independent) — globals.css:L11-L16

| Token | Value | Semantic role |
|---|---|---|
| `--signal` | `oklch(0.76 0.13 64)` | Primary accent: active/running/attention/warning; CTAs via `--primary`; focus ring |
| `--signal-2` | `oklch(0.88 0.11 80)` | Lighter signal stop (defined; rarely referenced directly) |
| `--mint` | `oklch(0.78 0.13 170)` | Success / completed / healthy |
| `--violet` | `oklch(0.72 0.14 300)` | Agent/model identity, "live" telemetry |
| `--rose` | `oklch(0.7 0.15 20)` | Failure / destructive / recording-live dot |
| `--sky` | `oklch(0.76 0.12 240)` | Queued/informational, tools, classification stage |

### Status colors — globals.css:L19-L23

| Token | Value | Maps to |
|---|---|---|
| `--status-running` | `oklch(0.76 0.13 64)` | = `--signal` |
| `--status-success` | `oklch(0.78 0.13 170)` | = `--mint` |
| `--status-failed` | `oklch(0.7 0.15 20)` | = `--rose` |
| `--status-idle` | `oklch(0.5 0.04 240)` | Desaturated blue-gray |
| `--status-connecting` | `oklch(0.76 0.12 240)` | = `--sky` |

### Surface ladder (dark default, `:root, .dark`) — globals.css:L31-L37

| Token | Dark value | Zinc ref | Light value (.light, L110-L116) |
|---|---|---|---|
| `--bg` | `#09090b` | zinc-950 | `#ffffff` |
| `--panel` | `#09090b` | zinc-950 (sidebar = bg) | `#ffffff` |
| `--panel-2` | `#18181b` | zinc-900 | `#f4f4f5` (zinc-100) |
| `--card` | `#09090b` | zinc-950 (border defines card) | `#ffffff` |
| `--card-hi` | `#18181b` | zinc-900 | `#f4f4f5` |
| `--line` | `#1f1f23` | between zinc-900/800 | `#e4e4e7` (zinc-200) |
| `--line-hi` | `#27272a` | zinc-800 | `#d4d4d8` (zinc-300) |

### Text ladder — globals.css:L40-L44 (dark), L119-L123 (light)

| Token | Dark | Zinc ref | Light |
|---|---|---|---|
| `--ink` | `#fafafa` | zinc-50 | `#09090b` (zinc-950) |
| `--ink-dim` | `#e4e4e7` | zinc-200 | `#18181b` (zinc-900) |
| `--mute` | `#a1a1aa` | zinc-400 | `#71717a` (zinc-500) |
| `--mute-2` | `#71717a` | zinc-500 | `#a1a1aa` (zinc-400) |
| `--mute-3` | `#3f3f46` | zinc-700 | `#d4d4d8` (zinc-300) |

### shadcn semantic mapping — globals.css:L47-L74 (dark), L126-L153 (light)

| Token | Resolves to |
|---|---|
| `--background` / `--foreground` | `var(--bg)` / `var(--ink)` |
| `--card-foreground` | `var(--ink)` |
| `--popover` | `#18181b` dark / `#ffffff` light (literal, not var) |
| `--popover-foreground` | `var(--ink)` |
| `--primary` / `--ring` | `var(--signal)` |
| `--primary-foreground` | `#09090b` dark / `#ffffff` light (literal) |
| `--secondary` / `--muted` / `--accent` | `var(--panel-2)` |
| `--secondary-foreground` / `--accent-foreground` | `var(--ink)` |
| `--muted-foreground` | `var(--mute)` |
| `--destructive` | `var(--rose)` |
| `--destructive-foreground` | `var(--ink)` dark / `#ffffff` light (literal) |
| `--border` / `--input` | `var(--line)` |
| Sidebar set (`--sidebar*`) | mirrors bg/panel-2/line/signal; see L67-L74, L146-L153 |

### Chart palette — globals.css:L77-L81 (dark), L155-L159 (light)

`--chart-1..5` = signal, mint, violet, sky, rose (same five OKLCH accents; wired through
Tailwind as `chart.1..5` in tailwind.config.mjs).

### Atmosphere, scrollbar, shadows — globals.css:L84-L103 (dark), L161-L180 (light)

- `--bg-layer-1`: radial-gradient wash, `color-mix(in oklch, var(--signal) 6%, transparent)`
  at top-left (dark) / 10% (light). `--bg-layer-2`: violet 5% top-right (dark) / sky 8%
  (light). Applied on `body` (L212).
- `--scrollbar-thumb` `#3f3f46` / hover `#52525b` (dark); `#d4d4d8` / `#a1a1aa` (light).
- `--shadow-card`: `0 0 0 1px #27272a, 0 4px 16px -4px rgba(0,0,0,.6)` dark; ring
  `#e4e4e7` + softer drop in light. Exposed as Tailwind `shadow-card`.
- `--shadow-glow`: signal-tinted ring + spread via color-mix 30-40%. Tailwind `shadow-glow`.

### Rules

- Accents carry meaning only: running=signal, success=mint, failed=rose, queued=sky,
  agent/model=violet. Never use an accent decoratively.
- Tint recipe for status fills/borders: background `color-mix(accent 8-15%, transparent)`,
  border `color-mix(accent 24-40%, transparent)`, text full accent. See `.owc-pill`
  (globals.css:L509-L558), Badge variants (`ui/badge.js`).
- Never introduce a color outside this table. Extend the table first.
- **Explicit format note:** accents/status/charts are OKLCH; surfaces/text/lines are hex
  zinc literals; shadows use rgba black; all tints go through `color-mix(in oklch ...)`.
  Do not convert one family into the other when editing.

---

## 3. Typography

### Font stack — app/layout.js:L1-L4,26; globals.css:L199, L223-L230

- Sans: **Geist Sans** (`next/font` via `geist/font/sans`, exposed as `--font-geist-sans`;
  Tailwind `font-sans`). Body fallback `ui-sans-serif, system-ui, sans-serif`.
- Mono: **Geist Mono** (`--font-geist-mono`; Tailwind `font-mono`), applied to `code, pre,
  kbd, samp, .mono` with `"ss01","zero"` features.
- Body features (globals.css:L200): `"rlig" 1, "calt" 1, "ss01", "cv11", "tnum"` — tabular
  numerals everywhere by default.
- `.owc-stat-num` (L774-L780): sans, `font-variant-numeric: tabular-nums`, weight 500,
  tracking -0.02em — the metric-number style.
- Legacy note: `.owc-pill` / `.model-badge` / `.tool-chip` hardcode
  `"JetBrains Mono", monospace` (L513, L692, L707) instead of `var(--font-geist-mono)`.

### Scale as actually used (grep counts across web/app + web/components)

Body base is **14px / line-height 1.5** (globals.css:L209-L213). The console runs a dense
micro-type ramp of arbitrary Tailwind sizes:

| Size | Occurrences | Canonical usage |
|---|---|---|
| `text-[10px]` | 186 | Micro-labels, eyebrows, chips, timestamps |
| `text-[11px]` | 142 | Secondary metadata, descriptions |
| `text-[12px]` | 115 | Compact body, table cells |
| `text-[10.5px]` | 38 | Badge/pill text, deltas |
| `text-[11.5px]` | 26 | Dense list rows |
| `text-[13px]` | 22 | Emphasized compact body |
| `text-[9px]` / `text-[9.5px]` | 21 / 16 | Slider min/max, tiny badges (floor) |
| `text-[12.5px]` / `text-[14px]` | 11 / 6 | Row titles / legacy body |
| `text-xs` (=12px) | 104 | shadcn primitive defaults |
| `text-sm` (=14px) | 132 | Primitive defaults, form text |
| `text-base` / `text-lg` / `text-xl` / `text-2xl` / `text-3xl` | 12 / 5 / 3 / 7 / 1 | Dialog titles (lg), CardTitle (2xl), rare page numbers |

Display sizes in components: KPI numbers `text-[26px]` (`kpi-card.js:L166`); isolated
`text-[30px]`/`text-[31px]` page figures elsewhere.

### Tracking + case pattern (the console's signature label)

Uppercase micro-label: `text-[10px] font-semibold uppercase tracking-[0.12em]` — 53 hits of
`tracking-[0.12em]`, plus `[0.14em]` x16, `[0.18em]` x4 (`.owc-eyebrow`), `tracking-widest`
x5, `tracking-tight` x9 (large numerals/titles), table heads `tracking-[0.1em]`
(`ui/table.js` TableHead).

`.owc-eyebrow` (globals.css:L492-L507): 10px / 600 / 0.18em uppercase, `--signal` colored,
18px dash rendered via `::before`.

### Rules

- Body never below 9px; 9-10px only for non-essential metadata.
- All numerals in metrics/tables use tabular figures (body default already sets `tnum`).
- Identifiers (run IDs, model names, tool names, IPs) render in `font-mono` pills/badges.
- Max 2 families (Geist Sans + Geist Mono). No third family without updating this file.

---

## 4. Spacing & Layout

No custom spacing tokens exist; spacing uses the **Tailwind default 4px-base scale**
(`p-2`=8, `p-3`=12, `p-4`=16, `p-6`=24, `gap-2`, `space-y-2`, etc.).

Observed conventions:

- Card padding: primitives use `p-6` (`ui/card.js`); dense console cards override to
  `p-4` or `p-3` (`kpi-card.js:L149`, feed rows `px-3 py-3`).
- Form blocks: label-above-input with `space-y-2`; input height `h-10`, padding
  `px-3.5 py-2.5` (`ui/input.js`, `ui/select.js`, `ui/textarea.js`).
- Progress bars: `h-[3px]`/`h-1` rounded-full tracks (`.owc-bar` is 4px, L561-L573).
- Icon tiles in feeds: 32px (`h-8 w-8`) squares or 24px circles.

### Grid & shell

- App shell: fixed left sidebar `16rem` desktop / `18rem` mobile sheet
  (`ui/sidebar.js` SIDEBAR_WIDTH constants), content in `SidebarInset`
  (`min-h-svh flex-1 flex-col`).
- Breakpoints: Tailwind defaults sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536.
  Usage counts: `sm:` x76, `xl:` x54, `lg:` x19, `md:` x12, `2xl:` x4.

### Rules

- Spacing intent maps to the 4px Tailwind scale; browser mechanics (`calc(100vw-1.5rem)`
  dialog sizing, `minmax`, percentages) stay raw.
- Density over air: this is a VISUAL_DENSITY 7-8 console. Do not import marketing-scale
  section gaps.

---

## 5. Components

### 5.1 Primitives — `web/components/ui/` (25 files, exact inventory)

All are shadcn-style function components (JS, no TypeScript), Radix-based where noted,
styled with Tailwind + CSS variables, composed via `cn()` (`@/lib/utils`).

| # | File | Variants / states as implemented |
|---|---|---|
| 1 | `alert-dialog.js` | Radix AlertDialog. Content: centered modal, `rounded-xl border bg-background p-6 shadow-lg`, open anim `animate-fade-in-soft`. Cancel = button outline variant; Action = buttonVariants (default danger). Overlay `bg-black/70 backdrop-blur-sm z-50`. |
| 2 | `badge.js` | cva `tone`: `default` (secondary bg), `success` (mint tint), `warning` (signal tint), `danger` (rose tint), `signal` (signal tint), `violet`, `live` (violet alias). Base: `rounded-full border px-2.5 py-0.5 font-mono text-[10.5px] font-medium transition-colors focus-visible ring-1 ring-ring`. Tints via arbitrary `color-mix(in_oklch ...)` classes. |
| 3 | `breadcrumb.js` | Nav `aria-label="Breadcrumb"`, list `gap-1.5 text-sm text-muted-foreground`, page `aria-current="page" font-medium text-foreground`, separator `aria-hidden` ChevronRight `size-3.5`. |
| 4 | `button.js` | cva `variant`: `default` (bg-background border-input), `accent` (bg-primary), `success` (bg mint, text `#0d0a04`), `ghost`, `danger` (destructive), `secondary`, `outline`, `link`. cva `size`: `default h-9 px-4`, `sm h-8 px-3 text-xs`, `lg h-10 px-6`, `icon h-9 w-9`, `icon-sm h-8 w-8`. States: hover variants per tone, `focus-visible:ring-1 ring-ring ring-offset-2`, `disabled:opacity-50 pointer-events-none`. `asChild` via Radix Slot. |
| 5 | `card.js` | Card `rounded-xl border bg-card text-card-foreground shadow-sm`; Header `p-6 space-y-1.5`; Title `text-2xl font-semibold leading-none tracking-tight`; Description `text-sm text-muted-foreground`; Content/Footer `p-6 pt-0`. |
| 6 | `chart.js` | Recharts wrapper. ChartContainer `aspect-video text-xs` with recharts selector overrides (axis ticks fill-muted-foreground, grid stroke-border/50); config-driven `--color-*` vars injected per theme; ChartTooltipContent `rounded-lg border-border/50 bg-background text-xs shadow-xl`, values `font-mono tabular-nums`. |
| 7 | `checkbox.js` | Radix. `h-4 w-4 rounded-[4px] border-input bg-background shadow-sm`, checked: border/bg primary, Check icon `h-3.5 w-3.5`; focus ring-1; disabled opacity-50. |
| 8 | `command.js` | cmdk. Root `rounded-md bg-popover`; Input row `h-10 border-b px-3` with Search icon; List `max-h-[300px] overflow-y-auto`; Item `rounded-sm px-2 py-1.5 text-sm`, selected `bg-accent text-accent-foreground`, disabled opacity-50; Shortcut `ml-auto text-xs tracking-widest`. |
| 9 | `dialog.js` | Radix Dialog. Overlay `bg-black/70 backdrop-blur-sm`; Content centered `w-[calc(100vw-1.5rem)] max-h-[calc(100vh-1.5rem)] max-w-lg rounded-xl border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-fade-in-soft overflow-y-auto`; optional close button with `sr-only` label. Title `text-lg font-semibold`; Description `text-sm muted`. Footer `flex-col-reverse gap-2 sm:flex-row sm:justify-end`. |
| 10 | `input.js` | Wrapper pattern: optional bold `label` above + `description` below (`space-y-2`). Field `h-10 rounded-lg border-border bg-background px-3.5 py-2.5 text-sm font-medium`, `hover:border-input`, `focus-visible:ring-1 ring-ring`, disabled opacity-50. |
| 11 | `label.js` | Radix LabelPrimitive. `text-sm font-medium leading-none`, peer-disabled styles. |
| 12 | `popover.js` | Radix Popover. Content `w-72 rounded-md border bg-popover p-4 shadow-md`, `sideOffset=8`, open anim `animate-fade-in-soft`. |
| 13 | `scroll-area.js` | Radix ScrollArea. Viewport `h-full w-full rounded-[inherit]`; ScrollBar vertical `w-2.5` / horizontal `h-2.5`, thumb `rounded-full bg-border`. |
| 14 | `select.js` | Custom high-level Select (label, options with label/description/meta, emptyMessage). Trigger = Input-like `h-10 rounded-lg px-3.5 py-2.5 text-sm font-medium` + ChevronDown; Content popper `max-h-96 min-w-[8rem] rounded-md border bg-popover shadow-md`, viewport `p-1.5`; items `py-2.5 pl-9 pr-3 rounded-md` with check indicator `text-primary`, meta line `font-mono text-[11px]`; empty state `px-3 py-8 text-center text-sm`. Empty-string values normalized via sentinel. |
| 15 | `separator.js` | Radix Separator. `h-px w-full` (or vertical) `bg-border`, decorative by default. |
| 16 | `sheet.js` | Radix Dialog side panel. Sides: top/bottom full-width; left/right `w-3/4 sm:max-w-sm` with border. Content `bg-background p-6 shadow-lg data-[state=open]:animate-fade-in-soft`; overlay same as dialog. Title/Description/Footer mirror dialog. |
| 17 | `sidebar.js` | Full shadcn sidebar kit. Widths 16rem/18rem; cookie persistence `owc:sidebar:open` (7 days); toggle Ctrl/Cmd+B; mobile < 767px renders inside Sheet; desktop rail `hidden md:block` fixed with `transition-[width,left,right] duration-200 ease-linear`; MenuButton cva sizes `default h-8 text-sm / sm h-7 text-xs / lg h-12`, active `bg-sidebar-accent font-medium`; MenuBadge `h-5 min-w-5 rounded-md text-xs tabular-nums`. |
| 18 | `skeleton.js` | `animate-pulse rounded-md bg-muted`. |
| 19 | `slider.js` | High-level: Label + mono value chip (`font-mono text-xs font-semibold tabular-nums`, bordered, minWidth 44px), track `h-1.5 rounded-full bg-secondary`, range filled with configurable color (default `var(--signal)`), thumb `h-4 w-4` ring-2 focus, min/max labels `font-mono text-[9px]`, optional description. |
| 20 | `spinner.js` | Lucide Loader2, `role="status" aria-label="Loading"`, `animate-spin text-muted-foreground`; sizes sm h-3 / default h-4 / lg h-6 / xl h-8. (CSS twin: `.owc-spinner` border-spinner, sm/lg, 600ms linear.) |
| 21 | `switch.js` | Radix Switch. `h-5 w-9 rounded-full border-2 border-transparent bg-input`, checked `bg-primary`, unchecked `bg-muted`; thumb `h-4 w-4 translate-x-4` checked; ring-1 focus; disabled opacity-50. |
| 22 | `table.js` | Table wrapper `overflow-auto text-sm`; Head `h-10 px-4 text-left text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground`; Cell `p-4 align-middle`; Row `border-b border-border transition-colors hover:bg-accent/50 data-[state=selected]:bg-muted`; Footer `bg-muted/50 font-medium`. |
| 23 | `tabs.js` | Radix Tabs. List `h-9 rounded-lg border bg-muted p-1`; Trigger `rounded-md px-3 py-1.5 text-sm font-medium`, active `bg-background text-foreground shadow-sm`; ring-2 focus-visible; Content `mt-4`. |
| 24 | `textarea.js` | Same wrapper pattern as Input (+`mono` prop switching to `font-mono`); field `min-h-[120px] rounded-lg px-3.5 py-2.5 text-sm`. |
| 25 | `tooltip.js` | Radix Tooltip. Provider delayDuration 150; Content `rounded-md border bg-popover px-3 py-1.5 text-sm shadow-md`, sideOffset 6, maxWidth 260. Includes `HelpIcon` help-button pattern (`h-4 w-4 rounded-full border bg-muted text-[9px] font-bold`, aria-label Help). |

### 5.2 Console composite patterns (project-level primitives worth naming)

These repeat across pages and MUST be reused (not re-styled) during W10 rebuilds.

- **StatusBadge semantics** — no component named StatusBadge exists; the semantics live in
  two places that must stay in sync:
  - `web/lib/run-status.js` `statusTone()` / `statusLabel()`: run statuses map to Badge
    tones — queued→sky, running→signal, success→success(mint), cancelled/partial/
    no_hosting_pages/no_streams/llm_rate_limited/llm_api_down→warning(signal),
    page_inaccessible/site_dead/timeout/failed/unknown→danger(rose).
  - `web/components/ui/badge.js` tone variants render the visual.
  - Event-kind mapping precedent: `runtime-events-panel.js` `statusTone(status, kind)`
    (`*_finished`→success, `*_failed`→danger, `*_started`→signal, llm→violet) and
    `actorTone()` (orchestrator→warning, classification→signal, landing→violet,
    hosting→success).
- **Event feed rows** — `orchestrator-decision-feed.js` DecisionCard: `rounded-lg border
  border-border/60 bg-card px-3.5 py-3` with 2px left accent border colored by event kind
  (`decisionMeta()`), 24px circular icon chip on `color-mix(accent 15%)` fill, relative
  timestamp, expandable details, new-row entry animation `animate-agent-arrive`.
  `tool-call-feed.js` ToolCallRow: Card with tone-tinted border/background
  (`toneForStatus()`: color-mix 24% border / 8% bg), 32px icon tile, stage eyebrow label,
  actor Badge, mono tool-name pill, screenshot thumbnail strip, expand-to-details.
- **Metric cards** — `kpi-card.js` KpiCard: Card + `p-4`; eyebrow label
  (`text-[10px] uppercase tracking-[0.15em]`); count-up number via rAF eased hook rendered
  in `.owc-stat-num text-[26px]`; optional SVG sparkline (72x28, gradient area fill);
  optional animated progress bar (width transition 700ms); delta arrow row
  (`font-mono text-[10.5px]`, up=emerald/down=rose); live dot using `breathe` keyframe;
  value-change replay of `count-pop`.
- **Pipeline timeline/graph** — `workflow-canvas.js` (React Flow): edges styled by
  `.pipeline-edge` classes (globals.css:L718-L733) — running edges get
  `stroke-dasharray: 8 4` + `edge-flow` dash animation; success=mint, failed=rose.
  `agent-activity-board.js` stage colors: classification→sky, landing→violet,
  hosting→mint, embedded→signal, orchestrator→ink; threshold tones `metricTone()`:
  >=0.85 rose, >=0.6 signal, else mint.
- **Console chrome** — `components/console/common/`: `page-header.js`,
  `section-panel.js`, `empty-state.js`, `loading-view.js`, `confirm-action.js`;
  layout in `console/layout/app-shell.js` + `console-topbar.js` +
  `navigation-config.js`. Rebuilds must compose these rather than re-implementing shells.
- **Pills/chips (CSS utilities)** — `.owc-pill` with `ok/warn/err/live` modifiers and
  breathing dot (globals.css:L509-L558), `.model-badge` (violet, L688-L700),
  `.tool-chip` (sky, L703-L715), `.live-badge` (rose, L741-L759),
  `.agent-ring-running/success/failed` glow rings (L668-L685).

---

## 6. Motion & Interaction

### Existing catalog (globals.css keyframes L298-L492 + utility classes L635-L665 + tailwind.config.mjs duplicates)

| Animation | Duration/easing | Usage |
|---|---|---|
| `fade-up` (`.animate-fade-up`, `.page-enter`) | 220ms / 260ms ease both | Cards, page transitions |
| `fade-in-soft` | 180ms ease | Dialog/popover/alert open states |
| `slide-in-right` (`.event-entry`) | 180ms ease | New event/feed rows |
| `slide-in-up` (`.animate-slide-in-up`) | 200ms ease | New event rows (alt.) |
| `agent-arrive` | 240ms cubic-bezier(0.34,1.56,0.64,1) (overshoot) | New decision cards, agent nodes |
| `count-pop` | 300ms ease | Metric value changes |
| `fill-bar` | 600ms cubic-bezier(0.4,0,0.2,1) | Progress bar fills |
| `ping-once` | 0.7s ease forwards | One-shot attention ping |
| `breathe` | 1.2-2.4s ease-in-out infinite | Live dots, running indicators |
| `glow-pulse` | 2s ease-in-out infinite | Running rings/stages (box-shadow) |
| `scan` / `.shimmer` | 2.4s linear infinite | Skeleton shimmer sweep |
| `edge-flow` / `dash-drift` | 1.2s linear infinite | Pipeline edge dash flow |
| `spin-slow` / `owc-spin` | 600ms-3s linear infinite | Spinners |
| `stage-failure-pulse` / `stage-cancelled-pulse` | 1.8s / 2.4s infinite | Failed/cancelled stages |
| `pulse-ring`, `flow`, `tput`, `wave`, `tool-pop-fade` | various | Ambient node/terminal visualizers |

Entry animations cluster at 180-260ms; ambient loops at 1.2-2.4s. Easing vocabulary:
`ease` for entries, `cubic-bezier(0.34,1.56,0.64,1)` for arrival overshoot,
`cubic-bezier(0.4,0,0.2,1)` for bars.

### Rules (normative going forward)

- GPU-composited properties only: animate `transform` and `opacity`. Never animate layout
  properties (`top/left/width/height`). Legacy exceptions that exist but must not spread:
  `tput`/`wave` (height), `AnimBar` width transition (`kpi-card.js`), box-shadow glows.
- Motion serves meaning: every animation maps to a real state change (new evidence arrived,
  run started/failed, value changed). No decorative loops on static content; slop
  animation is prohibited.
- Infinite loops only on genuinely live elements (running agents, live feeds).
- `prefers-reduced-motion` support is REQUIRED for new work (currently absent — see debt).
- SVG-icon rule: icons come from `lucide-react` (established dependency); no emojis in UI.

---

## 7. Depth & Surface

Strategy: **mixed — borders-first with tonal shift, shadows as quiet reinforcement.**

- Cards are same-color as the background (`--card` = `--bg` = zinc-950) and are defined by
  their 1px `--line` border; elevation is communicated by `--panel-2`/`--card-hi` tonal
  steps when needed (globals.css comment L34: "card = bg, border defines").
- `--shadow-card` adds a 1px ring + soft black drop for floating cards
  (`tool-call-feed.js` uses `shadow-card` explicitly).
- Overlays (dialog/sheet) darken with `bg-black/70 backdrop-blur-sm`.
- `.owc-glass` (L783-L787): `color-mix(panel 85%, transparent)` + `backdrop-filter:
  blur(12px)` + line border — the one glass material, used sparingly.
- `.paper` (L594-L599): 24px grid-paper lines at 2.5% white for canvas/backdrop areas.
- Glow (`--shadow-glow`, `.glow-pulse`, `.agent-ring-*`) is reserved for RUNNING state
  only. Never decorative.

---

## 8. Accessibility Constraints & Accepted Debt

### Constraints (observed + required)

Observed in code today:
- Global `:focus-visible` outline: `2px solid var(--ring)` (signal), offset 2px, radius 6px
  (globals.css:L248-L252). Primitives additionally use `focus-visible:ring-1/ring-2
  ring-ring ring-offset-2`.
- Radix primitives provide keyboard interaction, focus trap, and roving focus for dialog,
  alert-dialog, sheet, select, tabs, popover, tooltip, switch, checkbox, slider, command.
- ARIA in primitives/app: `sr-only` labels on icon-only buttons (dialog close, sidebar
  trigger), `role="status"` spinner, `role="alert"` login error, `aria-label` x23,
  `aria-hidden` x7, `aria-current="page"` breadcrumbs/nav, `aria-disabled` x2,
  `aria-live` x1, `aria-pressed` x1.
- Theme contrast pairs are pre-computed (ink/mute ladders vs surface ladder).

Required for all new work (W10 waves):
- WCAG 2.2 AA: 4.5:1 body text, 3:1 large text and UI boundaries; visible focus on every
  interactive element; full keyboard reachability.
- `prefers-reduced-motion`: gate ambient/infinite animations; collapse entries to instant.
- Icon-only buttons carry `sr-only` or `aria-label`.
- Survives content stress: long labels truncate (`truncate`/`min-w-0`), unbroken strings
  scroll inside their container, primary content reflows to one column at 375px with no
  horizontal page scroll.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|
| (a) Inline-style legacy pages pending W10 rebuild (T43) | 303 inline `style={{}}` blocks across web/app + web/components. Worst offenders: `console/overview/overview-page.js` (50), `console/run-detail/agent-activity-board.js` (37), `notification-provider.js` (25), `console/settings/settings-page.js` (24), `console/run-detail/run-detail-page.js` (25), `browser-live-view.js` (23), `cost-estimate-card.js` (21), `context-window-meter.js` (15), `run-detail-live.js` (17). Pre-console-refactor root-level components (`kpi-card`, `tool-call-feed`, `llm-output-panel`, etc.) coexist with `components/console/*`. | Rebuild waves 40-43 own the migration; restyling now would conflict with parallel workers. | Tasks 40-43; rebuilt pages must consume DESIGN.md tokens only. |
| (b) React Dev Tooling Gate PENDING | `web/package.json` — react-grab / react-scan / react-doctor NOT installed. | Another worker owns web/package.json + tsconfig; single-file scope avoids merge conflicts. | MUST be installed before the next UI implementation wave (task 37 kickoff at latest). |
| (c) Token drift — raw hexes outside globals.css | 20 occurrences in 7 files (59 total minus 39 inside globals.css). Worst: `app/login/page.js` (10 — fallback hexes `#0b0e14`, `#12161f`, `#232a38`, `#e6e9f0`, `#7a8399`, `#0f131c`, `#f87171` that do NOT match real token values), `workflow-canvas.js` (3 — `#94a3b8`, `#75a9ff` x2 off-palette blue), `context-window-meter.js` (1 — `#f59e0b` fallback for `--amber`, a token that is NEVER DEFINED in globals.css), `browser-live-view.js` (1 — `#050508`), `notification-provider.js` (1 — `#fff`), `ui/button.js` (1 — `#0d0a04` success-button text), `ui/chart.js` (1 — benign recharts selector string). | Login page predates token consolidation; workflow-canvas needs React Flow edge props which take literal colors. | Login rebuilt in W10; define `--amber` or remap to `--signal`; move canvas edge colors to tokens. |
| Ad-hoc type ramp | 20 distinct arbitrary `text-[Npx]` sizes (9-31px), see Section 3. | Density console evolved organically; consolidation is a task-37 decision, not extraction. | Task 37 may name a canonical subset; until then reuse existing sizes. |
| Duplicated motion definitions | Keyframes/animations defined in BOTH globals.css and tailwind.config.mjs (drift risk: config `glow-pulse` differs slightly from CSS version). | Historical; harmless while values match closely. | Consolidate to one source during task 37. |
| Duplicate light-mode patch blocks | globals.css:L254-L296 and L789-L843 both patch `.light .text-white` etc. with slightly different rules. | Compatibility shim for legacy white/slate utility usage; removal would break legacy pages before rebuild. | Delete after tasks 40-43 remove white/slate utilities. |
| No `prefers-reduced-motion` handling | Entire web app (grep: zero matches). | Not yet implemented anywhere. | Required in every W10 rebuilt page; add global media query in task 37. |
| `.owc-pill`/`.model-badge`/`.tool-chip` hardcode JetBrains Mono | globals.css:L513, L692, L707 | Pre-Geist-Mono legacy. | Swap to `var(--font-geist-mono)` during task 37. |

### Future considerations (NON-NORMATIVE — recorded, not approved)

- Name a canonical micro-type subset (e.g. 10 / 10.5 / 11 / 12 / 13 / 14px) and migrate
  the long tail (9, 9.5, 11.5, 12.5, 13.5px) toward it.
- Define `--amber` or replace its single consumer with `--signal`.
- Extract StatusBadge into a real shared component once run-status/event-kind mappings
  converge (three mapping tables currently exist: run-status.js, runtime-events-panel.js,
  orchestrator-decision-feed.js).
- Consider `@media (prefers-reduced-transparency)` fallback for `.owc-glass`.
