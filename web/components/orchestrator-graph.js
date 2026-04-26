"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/* ── constants ── */
const W = 900;
const H = 340;

const AGENT_NODES = [
  { id: "orchestrator", label: "Orchestrator",  x: 450, y: 52,  color: "signal"  },
  { id: "classification", label: "Classify",    x: 150, y: 230, color: "sky"     },
  { id: "landing",     label: "Landing",         x: 350, y: 230, color: "violet"  },
  { id: "hosting",     label: "Hosting",         x: 550, y: 230, color: "mint"    },
  { id: "embedded",    label: "Embedded",        x: 750, y: 230, color: "signal"  },
];

const EDGES = [
  { from: "orchestrator", to: "classification" },
  { from: "orchestrator", to: "landing"        },
  { from: "orchestrator", to: "hosting"        },
  { from: "orchestrator", to: "embedded"       },
];

const NODE_R = 52;

const COLOR_MAP = {
  signal:  "var(--signal)",
  sky:     "var(--sky)",
  violet:  "var(--violet)",
  mint:    "var(--mint)",
  rose:    "var(--rose)",
};

/* ── helpers ── */
function statusFromEvents(actorEvents) {
  if (!actorEvents.length) return "idle";
  if (actorEvents.some((e) => e.kind === "agent_failed"))    return "failed";
  if (actorEvents.some((e) => e.kind === "agent_finished"))  return "succeeded";
  if (actorEvents.some((e) => e.kind === "agent_started"))   return "running";
  if (actorEvents.some((e) => e.kind === "tool_session_connecting")) return "connecting";
  return "idle";
}

function edgeStatus(fromStatus, toStatus) {
  if (fromStatus === "running")   return "running";
  if (fromStatus === "succeeded") return "success";
  if (fromStatus === "failed")    return "failed";
  return "idle";
}

function edgePath(x1, y1, x2, y2) {
  const dy = (y2 - y1) * 0.55;
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
}

/* ── SVG Defs (gradients, markers) ── */
function SvgDefs() {
  return (
    <defs>
      <marker id="arrow-idle" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="rgba(255,255,255,0.12)" />
      </marker>
      <marker id="arrow-running" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="color-mix(in oklch, var(--signal) 65%, transparent)" />
      </marker>
      <marker id="arrow-success" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="color-mix(in oklch, var(--mint) 55%, transparent)" />
      </marker>
      <marker id="arrow-failed" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="color-mix(in oklch, var(--rose) 55%, transparent)" />
      </marker>
      <filter id="glow-signal" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="4" result="blur"/>
        <feComposite in="SourceGraphic" in2="blur" operator="over"/>
      </filter>
      <filter id="glow-soft" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="2" result="blur"/>
        <feComposite in="SourceGraphic" in2="blur" operator="over"/>
      </filter>
      <radialGradient id="node-bg-signal" cx="50%" cy="35%" r="65%">
        <stop offset="0%" stopColor="color-mix(in oklch, var(--signal) 22%, transparent)" />
        <stop offset="100%" stopColor="color-mix(in oklch, var(--signal) 4%, transparent)" />
      </radialGradient>
      <radialGradient id="node-bg-sky" cx="50%" cy="35%" r="65%">
        <stop offset="0%" stopColor="color-mix(in oklch, var(--sky) 22%, transparent)" />
        <stop offset="100%" stopColor="color-mix(in oklch, var(--sky) 4%, transparent)" />
      </radialGradient>
      <radialGradient id="node-bg-violet" cx="50%" cy="35%" r="65%">
        <stop offset="0%" stopColor="color-mix(in oklch, var(--violet) 22%, transparent)" />
        <stop offset="100%" stopColor="color-mix(in oklch, var(--violet) 4%, transparent)" />
      </radialGradient>
      <radialGradient id="node-bg-mint" cx="50%" cy="35%" r="65%">
        <stop offset="0%" stopColor="color-mix(in oklch, var(--mint) 22%, transparent)" />
        <stop offset="100%" stopColor="color-mix(in oklch, var(--mint) 4%, transparent)" />
      </radialGradient>
    </defs>
  );
}

/* ── Edge component ── */
function Edge({ fromNode, toNode, status }) {
  const x1 = fromNode.x;
  const y1 = fromNode.y + NODE_R;
  const x2 = toNode.x;
  const y2 = toNode.y - NODE_R;
  const d = edgePath(x1, y1, x2, y2);

  const isRunning = status === "running";
  const isSuccess = status === "success";
  const isFailed  = status === "failed";

  const strokeColor = isRunning ? "color-mix(in oklch, var(--signal) 65%, transparent)"
    : isSuccess ? "color-mix(in oklch, var(--mint) 55%, transparent)"
    : isFailed  ? "color-mix(in oklch, var(--rose) 55%, transparent)"
    : "rgba(255,255,255,0.08)";

  const markerId = isRunning ? "arrow-running"
    : isSuccess ? "arrow-success"
    : isFailed  ? "arrow-failed"
    : "arrow-idle";

  return (
    <g>
      {/* shadow path */}
      <path d={d} fill="none" stroke="rgba(0,0,0,0.3)" strokeWidth="3" />
      {/* main edge */}
      <path
        d={d}
        fill="none"
        stroke={strokeColor}
        strokeWidth={isRunning ? 1.8 : 1.4}
        strokeDasharray={isRunning ? "8 4" : undefined}
        strokeLinecap="round"
        markerEnd={`url(#${markerId})`}
        style={isRunning ? { animation: "edge-flow 1.2s linear infinite" } : undefined}
      />
    </g>
  );
}

/* ── Tool pop indicator ── */
function ToolPopIndicator({ toolName, key: _key }) {
  return (
    <div
      className="tool-chip animate-tool-pop pointer-events-none whitespace-nowrap"
      style={{ position: "absolute", bottom: "calc(100% + 8px)", left: "50%", transform: "translateX(-50%)" }}
    >
      <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
        <path d="M5 1v2a.5.5 0 00.5.5H8M1.5 4a3.5 3.5 0 106 2.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
      {toolName}
    </div>
  );
}

/* ── Agent node ── */
function AgentNode({ node, actorData, recentTool }) {
  const { label, x, y, color } = node;
  const { status, toolCalls, llmCalls, latestModel, latestTool } = actorData;

  const accentColor = COLOR_MAP[color] || COLOR_MAP.signal;
  const isRunning  = status === "running";
  const isSuccess  = status === "succeeded";
  const isFailed   = status === "failed";
  const isIdle     = status === "idle";

  const ringColor = isRunning ? "var(--signal)"
    : isSuccess ? "var(--mint)"
    : isFailed  ? "var(--rose)"
    : "rgba(255,255,255,0.10)";

  const ringOpacity = isIdle ? 0.5 : 1;

  /* SVG circle rings */
  const outerR = NODE_R + 8;
  const innerR = NODE_R;

  return (
    <g transform={`translate(${x},${y})`} style={{ animation: "agent-arrive 240ms cubic-bezier(0.34,1.56,0.64,1) both" }}>
      {/* pulse ring when running */}
      {isRunning && (
        <circle r={outerR + 6} fill="none" stroke={accentColor} strokeWidth="1"
          opacity="0" style={{ animation: "pulse-ring 2s ease-out infinite" }} />
      )}

      {/* outer status ring */}
      <circle r={outerR} fill="none"
        stroke={ringColor}
        strokeWidth={isRunning ? 2 : 1.5}
        opacity={ringOpacity}
        style={isRunning ? { animation: "glow-pulse 2s ease-in-out infinite" } : undefined}
      />

      {/* node background */}
      <circle r={innerR} fill={`url(#node-bg-${color})`} />
      <circle r={innerR} fill="none"
        stroke={accentColor}
        strokeWidth="1"
        opacity="0.4"
      />

      {/* status indicator top-right */}
      {!isIdle && (
        <circle
          cx={innerR * 0.68} cy={-innerR * 0.68}
          r="6"
          fill={isRunning ? "var(--signal)" : isSuccess ? "var(--mint)" : "var(--rose)"}
          style={isRunning ? { animation: "breathe 1.2s ease-in-out infinite" } : undefined}
        />
      )}

      {/* label */}
      <text
        textAnchor="middle"
        dominantBaseline="middle"
        y={latestModel || toolCalls > 0 ? -10 : 0}
        fill={isIdle ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.92)"}
        fontSize="12"
        fontWeight="600"
        fontFamily="var(--font-sans)"
        letterSpacing="0"
      >
        {label}
      </text>

      {/* model badge */}
      {latestModel && (
        <text
          textAnchor="middle"
          dominantBaseline="middle"
          y={8}
          fill="color-mix(in oklch, var(--violet) 90%, white)"
          fontSize="8.5"
          fontFamily="'JetBrains Mono', monospace"
          fontWeight="500"
        >
          {latestModel.replace(/^(models\/)?/, "").slice(0, 18)}
        </text>
      )}

      {/* tool + llm counts */}
      {(toolCalls > 0 || llmCalls > 0) && (
        <g transform="translate(0, 24)">
          {toolCalls > 0 && (
            <rect x={llmCalls > 0 ? -34 : -16} y="-7" width="32" height="13" rx="6.5"
              fill="color-mix(in oklch, var(--sky) 14%, transparent)"
              stroke="color-mix(in oklch, var(--sky) 30%, transparent)"
              strokeWidth="0.8"
            />
          )}
          {toolCalls > 0 && (
            <text
              x={llmCalls > 0 ? -18 : 0}
              dominantBaseline="middle"
              textAnchor="middle"
              fill="var(--sky)"
              fontSize="7.5"
              fontFamily="'JetBrains Mono', monospace"
              fontWeight="600"
            >
              🔧{toolCalls}
            </text>
          )}
          {llmCalls > 0 && (
            <rect x={toolCalls > 0 ? 2 : -16} y="-7" width="32" height="13" rx="6.5"
              fill="color-mix(in oklch, var(--violet) 14%, transparent)"
              stroke="color-mix(in oklch, var(--violet) 30%, transparent)"
              strokeWidth="0.8"
            />
          )}
          {llmCalls > 0 && (
            <text
              x={toolCalls > 0 ? 18 : 0}
              dominantBaseline="middle"
              textAnchor="middle"
              fill="var(--violet)"
              fontSize="7.5"
              fontFamily="'JetBrains Mono', monospace"
              fontWeight="600"
            >
              ◈{llmCalls}
            </text>
          )}
        </g>
      )}
    </g>
  );
}

/* ── main export ── */
export function OrchestratorGraph({ events = [], rootActor = "orchestrator" }) {
  const [toolPops, setToolPops] = useState([]);
  const prevEventsLen = useRef(0);

  /* derive per-actor data from events */
  const actorMap = useMemo(() => {
    const map = new Map();
    for (const node of AGENT_NODES) {
      map.set(node.id, { status: "idle", toolCalls: 0, llmCalls: 0, latestModel: null, latestTool: null });
    }
    for (const e of events) {
      const actor = e?.actor;
      if (!actor) continue;
      /* fuzzy match: "orchestrator" may be the root actor string */
      const nodeId = AGENT_NODES.find((n) => actor.toLowerCase().includes(n.id.toLowerCase()))?.id || actor;
      if (!map.has(nodeId)) {
        map.set(nodeId, { status: "idle", toolCalls: 0, llmCalls: 0, latestModel: null, latestTool: null });
      }
      const d = map.get(nodeId);
      if (e.kind === "agent_failed")    d.status = "failed";
      else if (e.kind === "agent_finished") d.status = "succeeded";
      else if (e.kind === "agent_started")  { if (d.status === "idle") d.status = "running"; }
      if (e.kind === "tool_call_started") { d.toolCalls++; d.latestTool = e.details?.tool_name || null; }
      if (e.kind === "llm_response")      { d.llmCalls++;  d.latestModel = e.details?.model_name || null; }
    }
    return map;
  }, [events]);

  /* detect new tool_call_started events → pop indicator */
  useEffect(() => {
    const newEvents = events.slice(prevEventsLen.current);
    prevEventsLen.current = events.length;
    for (const e of newEvents) {
      if (e.kind !== "tool_call_started") continue;
      const toolName = e.details?.tool_name || "tool";
      const actor = e?.actor;
      const nodeId = AGENT_NODES.find((n) => actor?.toLowerCase().includes(n.id.toLowerCase()))?.id || actor;
      setToolPops((prev) => [
        ...prev.filter((p) => Date.now() - p.ts < 2200),
        { id: `${e.seq}-${Date.now()}`, nodeId, toolName, ts: Date.now() },
      ]);
    }
  }, [events]);

  /* clean up expired pops */
  useEffect(() => {
    if (!toolPops.length) return;
    const t = setTimeout(() => {
      setToolPops((prev) => prev.filter((p) => Date.now() - p.ts < 2200));
    }, 2300);
    return () => clearTimeout(t);
  }, [toolPops]);

  const edgeStatuses = useMemo(() => {
    const result = new Map();
    for (const edge of EDGES) {
      const fromData = actorMap.get(edge.from) || { status: "idle" };
      result.set(`${edge.from}-${edge.to}`, edgeStatus(fromData.status));
    }
    return result;
  }, [actorMap]);

  /* compute which nodes are actually present in events */
  const activeNodeIds = useMemo(() => {
    const ids = new Set([rootActor]);
    for (const e of events) {
      if (!e?.actor) continue;
      const nodeId = AGENT_NODES.find((n) => e.actor.toLowerCase().includes(n.id.toLowerCase()))?.id;
      if (nodeId) ids.add(nodeId);
    }
    return ids;
  }, [events, rootActor]);

  return (
    <div
      className="relative overflow-hidden rounded-[14px] border"
      style={{
        borderColor: "var(--line)",
        background: "var(--card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      {/* header */}
      <div
        className="flex items-center gap-3 border-b px-4 py-3"
        style={{ borderColor: "var(--line)" }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ color: "var(--signal)", flexShrink: 0 }}>
          <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2"/>
          <circle cx="7" cy="7" r="2.2" fill="currentColor"/>
          <path d="M1 7h2M11 7h2M7 1v2M7 11v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
        <span className="text-[11.5px] font-semibold tracking-wide uppercase" style={{ color: "var(--signal)", letterSpacing: "0.12em" }}>
          Orchestrator Graph
        </span>
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-[10px]" style={{ color: "var(--mute-2)", fontFamily: "JetBrains Mono, monospace" }}>
            {events.length} events
          </span>
          {/* legend */}
          <div className="hidden sm:flex items-center gap-3 text-[9.5px]" style={{ color: "var(--mute-2)", fontFamily: "JetBrains Mono, monospace" }}>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full" style={{ background: "var(--signal)" }} /> running
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full" style={{ background: "var(--mint)" }} /> done
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full" style={{ background: "var(--rose)" }} /> failed
            </span>
          </div>
        </div>
      </div>

      {/* SVG canvas */}
      <div className="relative" style={{ height: H + 16 }}>
        <svg
          width="100%"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ position: "absolute", inset: 0 }}
        >
          <SvgDefs />

          {/* subtle grid */}
          <defs>
            <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
              <path d="M 28 0 L 0 0 0 28" fill="none" stroke="rgba(255,255,255,0.025)" strokeWidth="0.5"/>
            </pattern>
          </defs>
          <rect width={W} height={H} fill="url(#grid)" />

          {/* edges */}
          {EDGES.map((edge) => {
            const fromNode = AGENT_NODES.find((n) => n.id === edge.from);
            const toNode   = AGENT_NODES.find((n) => n.id === edge.to);
            if (!fromNode || !toNode) return null;
            const status = edgeStatuses.get(`${edge.from}-${edge.to}`) || "idle";
            return (
              <Edge
                key={`${edge.from}-${edge.to}`}
                fromNode={fromNode}
                toNode={toNode}
                status={status}
              />
            );
          })}

          {/* nodes */}
          {AGENT_NODES.map((node) => {
            const actorData = actorMap.get(node.id) || { status: "idle", toolCalls: 0, llmCalls: 0, latestModel: null, latestTool: null };
            /* dim nodes not yet seen */
            const seen = activeNodeIds.has(node.id) || events.length === 0;
            return (
              <g key={node.id} opacity={seen ? 1 : 0.35} style={{ transition: "opacity 400ms" }}>
                <AgentNode node={node} actorData={actorData} />
              </g>
            );
          })}
        </svg>

        {/* tool pop indicators (absolutely positioned over SVG) */}
        {toolPops.map((pop) => {
          const node = AGENT_NODES.find((n) => n.id === pop.nodeId);
          if (!node) return null;
          /* convert SVG coords to % positions */
          const leftPct = (node.x / W) * 100;
          const topPct  = ((node.y - NODE_R - 30) / H) * 100;
          return (
            <div
              key={pop.id}
              className="tool-chip animate-tool-pop pointer-events-none whitespace-nowrap"
              style={{
                position: "absolute",
                left: `${leftPct}%`,
                top: `calc(${topPct}% + 8px)`,
                transform: "translateX(-50%)",
                zIndex: 10,
              }}
            >
              <svg width="9" height="9" viewBox="0 0 9 9" fill="none" style={{ flexShrink: 0 }}>
                <path d="M4 1a3 3 0 100 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                <path d="M7 4H4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              {pop.toolName}
            </div>
          );
        })}
      </div>

      {/* bottom metrics strip */}
      {events.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-4 border-t px-4 py-2.5"
          style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.015)" }}
        >
          {AGENT_NODES.map((node) => {
            const d = actorMap.get(node.id);
            if (!d || (d.toolCalls === 0 && d.llmCalls === 0)) return null;
            const accentColor = COLOR_MAP[node.color] || "var(--signal)";
            return (
              <div key={node.id} className="flex items-center gap-2">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: accentColor }}
                />
                <span className="text-[10px]" style={{ color: "var(--ink-dim)", fontFamily: "JetBrains Mono, monospace" }}>
                  {node.label}
                </span>
                {d.toolCalls > 0 && (
                  <span className="tool-chip" style={{ fontSize: "9px", padding: "1px 5px" }}>
                    🔧 {d.toolCalls}
                  </span>
                )}
                {d.llmCalls > 0 && (
                  <span className="model-badge" style={{ fontSize: "9px", padding: "1px 5px" }}>
                    ◈ {d.llmCalls}
                    {d.latestModel && ` · ${d.latestModel.replace(/^(models\/)?/, "").slice(0, 14)}`}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
