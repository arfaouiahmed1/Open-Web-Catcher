import React from "react";

export const GROUP_COLORS: Record<string, string> = {
  Run: "var(--signal)",
  Inspect: "var(--sky)",
  System: "var(--violet)",
};

export function LogoMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <path d="M16 3.5 L26.5 9.25 L26.5 22.75 L16 28.5 L5.5 22.75 L5.5 9.25 Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" opacity="0.9" />
      <path d="M16 9.5 L21 12.25 L21 19.75 L16 22.5 L11 19.75 L11 12.25 Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" opacity="0.55" />
      <path d="M3 16 H9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M23 16 H29" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="16" cy="16" r="2.1" fill="currentColor" />
    </svg>
  );
}

export const ICONS: Record<string, React.ReactNode> = {
  overview: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 13a9 9 0 1 1 18 0" /><path d="M12 13l4-5" /><circle cx="12" cy="13" r="1.2" fill="currentColor" stroke="none" /></svg>
  ),
  live: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></svg>
  ),
  tools: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3a4 4 0 0 0-3 6.8L4 18l2 2 8.2-8.2A4 4 0 0 0 21 9l-3 1-2-2 1-3z" /></svg>
  ),
  runs: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M3 12h18M3 18h12" /></svg>
  ),
  providers: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><path d="M8 6h8M8 8l4 8M16 8l-4 8" /></svg>
  ),
  evals: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3h6v3l-3 4 3 4v7H9v-7l3-4-3-4V3z" /></svg>
  ),
  database: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="8" ry="2.5" /><path d="M4 5v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V5" /><path d="M4 11v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6" /></svg>
  ),
  datasets: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="8" height="8" rx="1" /><rect x="13" y="3" width="8" height="8" rx="1" /><rect x="3" y="13" width="8" height="8" rx="1" /><rect x="13" y="13" width="8" height="8" rx="1" /></svg>
  ),
  prompts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" /><path d="M9 9h1M9 13h6M9 17h6" /></svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
  ),
  play: (
    <svg viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round"><polygon points="6 4 20 12 6 20 6 4" fill="currentColor" /></svg>
  ),
  hamburger: (
    <svg viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="3" width="14" height="1.5" rx="1" /><rect x="1" y="7.25" width="14" height="1.5" rx="1" /><rect x="1" y="11.5" width="14" height="1.5" rx="1" /></svg>
  ),
};

export interface NavChild {
  href: string;
  label: string;
}

export interface NavItem {
  href: string;
  label: string;
  key: string;
  section: string | null;
  badge?: boolean;
  children?: NavChild[];
}

const DASHBOARD_TABS: NavChild[] = [
  { href: "/?tab=overview", label: "Overview" },
  { href: "/?tab=costs", label: "Costs" },
  { href: "/?tab=tokens", label: "Tokens" },
  { href: "/?tab=providers", label: "Providers" },
  { href: "/?tab=tools", label: "Tools" },
  { href: "/?tab=agents", label: "Agents" },
];

const LIVE_PIPELINE_TABS: NavChild[] = [
  { href: "/live?mode=workflow", label: "Workflow" },
  { href: "/live?mode=agent", label: "Single agent" },
];

const RUNS_TABS: NavChild[] = [
  { href: "/runs?tab=sites", label: "Websites" },
  { href: "/runs?tab=batches", label: "Batches" },
  { href: "/runs?tab=history", label: "Run history" },
];

const SETTINGS_TABS: NavChild[] = [
  { href: "/settings?tab=models", label: "Models & Providers" },
  { href: "/settings?tab=browser", label: "Browser" },
  { href: "/settings?tab=display", label: "Display" },
  { href: "/settings?tab=api-keys", label: "API Keys" },
  { href: "/settings?tab=account", label: "Account" },
  { href: "/settings?tab=notifications", label: "Notifications" },
  { href: "/settings?tab=mcp-tools", label: "MCP Tools" },
];

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", key: "overview", section: null, children: DASHBOARD_TABS },
  { href: "/live", label: "Live Pipeline", key: "live", section: "Agents", badge: true, children: LIVE_PIPELINE_TABS },
  { href: "/runs", label: "View Results", key: "runs", section: "Agents", children: RUNS_TABS },
  { href: "/providers", label: "Provider Results", key: "providers", section: "Agents" },
  { href: "/settings", label: "Settings", key: "settings", section: "Config", children: SETTINGS_TABS },
];

export const NAV_GROUPS: string[] = ["Agents", "Config"];

export function pathToCrumbs(pathname: string): string[] {
  const map: Record<string, string[]> = {
    "/": ["dashboard"],
    "/live": ["agents", "live-pipeline"],
    "/runs": ["agents", "view-results"],
    "/providers": ["agents", "provider-results"],
    "/settings": ["config", "settings"],
  };
  const base = `/${pathname.split("/")[1] || ""}`;
  return map[base] || ["dashboard"];
}
