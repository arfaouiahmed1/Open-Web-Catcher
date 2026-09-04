"use client";

import * as React from "react";
import { Search, Loader2 } from "lucide-react";

export interface ApiKeysTabProvider {
  id: string;
  name: string;
  keyEnv: string;
  color: string;
  category: string;
  features: string[];
  baseUrl?: string;
}

export interface ApiKeysTabProps {
  providers: ApiKeysTabProvider[];
  apiKeys: Record<string, unknown>;
  keyEdits: Record<string, string | null>;
  baseUrlEdits: Record<string, string | null>;
  showKey: Record<string, boolean>;
  keyTestState: Record<string, string>;
  providerKeyQuery: string;
  providerKeyCategory: string;
  providerKeyStatus: string;
  configuredBaseUrls: Record<string, string>;
  registryBaseUrls: Record<string, string>;
  onQuery: (v: string) => void;
  onCategory: (v: string) => void;
  onStatus: (v: string) => void;
  onKeyEdit: (id: string, v: string) => void;
  onKeyClear: (id: string) => void;
  onKeyUndo: (id: string) => void;
  onToggleShow: (id: string) => void;
  onBaseUrlEdit: (id: string, v: string) => void;
  onTest: (id: string) => void;
  onClearFilters: () => void;
}

const STATUS_FILTERS = ["All", "Configured", "Missing"];
const CATEGORY_FILTERS = ["All", "Frontier", "Speed", "Open", "Cloud", "Enterprise", "Community", "Local", "Gateway"];

export function ApiKeysTab(props: ApiKeysTabProps): React.JSX.Element {
  const {
    providers,
    apiKeys,
    keyEdits,
    baseUrlEdits,
    showKey,
    keyTestState,
    providerKeyQuery,
    providerKeyCategory,
    providerKeyStatus,
    configuredBaseUrls,
    registryBaseUrls,
  } = props;

  const filtered = providers.filter((pr) => {
    const q = providerKeyQuery.trim().toLowerCase();
    const matchesSearch =
      !q || [pr.name, pr.keyEnv, pr.id, (pr.features || []).join(" "), pr.category].join(" ").toLowerCase().includes(q);
    const matchesCat = providerKeyCategory === "All" || pr.category === providerKeyCategory;
    const hasKey = Boolean(apiKeys[pr.id]);
    const matchesStatus =
      providerKeyStatus === "All" || (providerKeyStatus === "Configured" ? hasKey : !hasKey);
    return matchesSearch && matchesCat && matchesStatus;
  });

  const groups: Record<string, ApiKeysTabProvider[]> = {};
  filtered.forEach((pr) => {
    const g = pr.category || "Other";
    if (!groups[g]) groups[g] = [];
    groups[g].push(pr);
  });
  const order = ["Frontier", "Speed", "Open", "Cloud", "Enterprise", "Community", "Local", "Gateway"];
  const sortedGroups = Object.keys(groups).sort((a, b) => order.indexOf(a) - order.indexOf(b));

  return (
    <section className="space-y-6" style={{ fontFeatureSettings: '"cv01","ss03"' }}>
      <div className="border-b border-border/60 pb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="text-[20px] font-[590] tracking-[-0.24px] text-foreground">Provider keys</h2>
            <p className="mt-2 max-w-[560px] text-[14px] leading-[1.6] tracking-[-0.13px] text-muted-foreground">
              BYOK — keys live in <span className="font-mono text-[12px] text-foreground/80">data/settings.runtime.yaml</span>.
              Never baked into images, never committed. Values are masked; leave blank to keep, clear to remove.
            </p>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/30 px-3 py-1.5 text-[12px] font-[500] text-foreground/80">
            <span className="size-2 rounded-full bg-[#10b981]" />
            {Object.values(apiKeys).filter(Boolean).length} / {providers.length} live
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative min-w-[260px] max-w-[360px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70" />
          <input
            value={providerKeyQuery}
            onChange={(e) => props.onQuery(e.target.value)}
            placeholder="Search providers, env, features…"
            aria-label="Search providers, env, features"
            className="h-10 w-full rounded-xl border border-border/70 bg-card pl-9 pr-4 text-[13px] outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Provider key status filter">
          {STATUS_FILTERS.map((st) => (
            <button
              key={st}
              onClick={() => props.onStatus(st)}
              aria-pressed={providerKeyStatus === st}
              className={[
                "inline-flex h-6 items-center rounded-full border px-2.5 text-[12px] font-[500] transition-colors",
                providerKeyStatus === st
                  ? "border-border bg-muted/60 text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground/80",
              ].join(" ")}
            >
              {st}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-muted/60" aria-hidden="true" />
          {CATEGORY_FILTERS.map((cat) => (
            <button
              key={cat}
              onClick={() => props.onCategory(cat)}
              aria-pressed={providerKeyCategory === cat}
              aria-label={`Filter providers by category ${cat}`}
              className={[
                "inline-flex h-6 items-center rounded-full border px-2.5 text-[12px] font-[500] transition-colors",
                providerKeyCategory === cat
                  ? "border-border bg-muted/60 text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground/80",
              ].join(" ")}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-8">
        {filtered.length === 0 ? (
          <div className="rounded-[8px] border border-dashed border-border bg-muted/20 px-6 py-12 text-center">
            <div className="mx-auto max-w-sm">
              <div className="text-[13px] font-[510] text-foreground">No providers match</div>
              <p className="mt-1 text-[13px] leading-[1.5] text-muted-foreground">
                Try a different search or filter. {providers.length} total providers available.
              </p>
              <button
                onClick={props.onClearFilters}
                className="mt-4 inline-flex h-7 items-center rounded-[6px] border border-border bg-muted/30 px-3 text-[12px] font-[500] text-foreground/80 hover:bg-muted/60"
              >
                Clear filters
              </button>
            </div>
          </div>
        ) : (
          sortedGroups.map((group) => (
            <div key={group} className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="text-[11px] font-[600] uppercase tracking-[0.08em] text-muted-foreground">{group}</div>
                <div className="h-px flex-1 bg-muted/60" />
                <div className="text-[11px] text-muted-foreground/70">{groups[group].length} providers</div>
              </div>
              <div className="overflow-hidden rounded-[8px] border border-border bg-muted/20">
                {groups[group].map((item, idx) => {
                  const hasKey = Boolean(apiKeys[item.id]);
                  const edited = keyEdits[item.id];
                  const isEdited = edited !== null && edited !== undefined;
                  const isCleared = edited === "";
                  const show = Boolean(showKey[item.id]);
                  const testState = keyTestState[item.id] || "";
                  const isTesting = testState === "testing";
                  const defaultBaseUrl = item.baseUrl || registryBaseUrls[item.id] || "";
                  const configuredBaseUrl = configuredBaseUrls[item.id] || "";
                  const editedBaseUrl = baseUrlEdits[item.id];
                  const effectiveBaseUrl =
                    editedBaseUrl !== null && editedBaseUrl !== undefined ? editedBaseUrl : configuredBaseUrl;
                  return (
                    <div
                      key={item.id}
                      className={[
                        "group relative flex flex-col gap-3 px-4 py-4 transition-colors",
                        idx !== 0 ? "border-t border-border/60" : "",
                        isEdited && !isCleared ? "bg-[rgba(94,106,210,0.04)]" : "hover:bg-muted/30",
                      ].join(" ")}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex min-w-0 flex-1 items-start gap-3">
                          <span
                            className="mt-1.5 size-2 shrink-0 rounded-full"
                            style={{ background: hasKey || (isEdited && !isCleared) ? item.color : "#3f3f46" }}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[13px] font-[510] text-foreground">{item.name}</span>
                              <span className="inline-flex items-center rounded-[4px] border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                                {item.keyEnv}
                              </span>
                              {isEdited ? (
                                <span
                                  className={[
                                    "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-[600]",
                                    isCleared
                                      ? "border-[rgba(245,158,11,0.2)] bg-[rgba(245,158,11,0.12)] text-[var(--signal-text)]"
                                      : "border-[rgba(94,106,210,0.2)] bg-[rgba(94,106,210,0.12)] text-[var(--violet-text)]",
                                  ].join(" ")}
                                >
                                  {isCleared ? "will clear" : "edited"}
                                </span>
                              ) : hasKey ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(16,185,129,0.10)] px-2 py-0.5 text-[10px] font-[600] text-[var(--mint-text)]">
                                  <span className="size-1 rounded-full bg-[#10b981]" /> live
                                </span>
                              ) : null}
                              {testState === "ok" ? (
                                <span className="inline-flex items-center rounded-full bg-[rgba(16,185,129,0.12)] px-2 py-0.5 text-[10px] font-[600] text-[var(--mint-text)]">
                                  verified
                                </span>
                              ) : testState === "error" ? (
                                <span className="inline-flex items-center rounded-full bg-[rgba(239,68,68,0.12)] px-2 py-0.5 text-[10px] font-[600] text-[var(--rose-text)]">
                                  failed
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {(item.features || []).slice(0, 3).map((f: string) => (
                                <span
                                  key={f}
                                  className="rounded-[4px] bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                >
                                  {f}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            onClick={() => props.onToggleShow(item.id)}
                            className="inline-flex h-7 items-center rounded-[6px] border border-border bg-muted/20 px-2.5 text-[12px] font-[500] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                          >
                            {show ? "Hide" : "Show"}
                          </button>
                          <button
                            onClick={() => props.onTest(item.id)}
                            disabled={isTesting}
                            className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-border bg-muted/20 px-2.5 text-[12px] font-[500] text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
                          >
                            {isTesting ? <Loader2 className="size-3 animate-spin" /> : null} Test
                          </button>
                          <button
                            onClick={() => props.onKeyClear(item.id)}
                            className="inline-flex h-7 items-center rounded-[6px] border border-transparent px-2.5 text-[12px] font-[500] text-muted-foreground hover:bg-muted/40 hover:text-foreground/80"
                          >
                            Clear
                          </button>
                          {isEdited ? (
                            <button
                              onClick={() => props.onKeyUndo(item.id)}
                              className="inline-flex h-7 items-center rounded-[6px] bg-[#5e6ad2] px-2.5 text-[12px] font-[500] text-white hover:bg-[#828fff]"
                            >
                              Undo
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                          <input
                            value={isEdited ? (edited as string) : ""}
                            onChange={(e) => props.onKeyEdit(item.id, e.target.value)}
                            placeholder={hasKey ? "•••••••••••••••• — paste new key to replace" : "Paste " + item.keyEnv}
                            aria-label={`API key for ${item.name}`}
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            className="h-9 w-full rounded-lg border border-border/70 bg-background px-3 font-mono text-[12px] outline-none placeholder:text-muted-foreground/60 focus-visible:ring-1 focus-visible:ring-ring"
                          />
                        </div>
                      </div>
                      <div className="relative">
                        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[10px] font-[600] uppercase tracking-[0.08em] text-muted-foreground/70">
                          URL
                        </span>
                        <input
                          value={effectiveBaseUrl}
                          onChange={(e) => props.onBaseUrlEdit(item.id, e.target.value)}
                          placeholder={defaultBaseUrl || "https://your-endpoint.example.com/v1"}
                          aria-label={`Base URL for ${item.name}`}
                          autoComplete="off"
                          spellCheck={false}
                          className="h-9 w-full rounded-lg border border-border/70 bg-background px-3 font-mono text-[12px] outline-none placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </div>
                      <p className="text-[11px] leading-[1.4] text-muted-foreground/70">
                        {hasKey ? "Key set — masked. " : "No key — "}
                        {isEdited && !isCleared
                          ? "Will save new value."
                          : isCleared
                            ? "Will remove from runtime on save."
                            : "Leave blank to keep."}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
