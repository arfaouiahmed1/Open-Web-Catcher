"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

import { cn } from "@/lib/utils";

function useDismissibleLayer(open, onClose, triggerRef, panelRef) {
  useEffect(() => {
    if (!open) return undefined;

    function onPointerDown(event) {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (trigger?.contains(event.target) || panel?.contains(event.target)) return;
      onClose();
    }

    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose, panelRef, triggerRef]);
}

export function Select({
  className,
  label,
  value,
  onChange,
  options = [],
  placeholder = "Select",
  emptyMessage = "No options available",
  searchable = false,
  disabled = false,
}) {
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = useMemo(
    () => options.find((option) => option.value === value) || null,
    [options, value]
  );

  const filteredOptions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => {
      const haystack = [
        option.label,
        option.value,
        option.description,
        option.meta,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [options, query]);

  useDismissibleLayer(open, () => setOpen(false), triggerRef, panelRef);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  return (
    <div className={cn(label ? "space-y-1.5" : undefined, className)}>
      {label && (
        <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">
          {label}
        </label>
      )}

      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          className={cn(
            "flex h-11 w-full items-center justify-between rounded-[12px] border px-3 text-left transition-colors",
            "disabled:cursor-not-allowed disabled:opacity-50"
          )}
          style={{
            borderColor: open ? "color-mix(in oklch, var(--signal) 35%, transparent)" : "var(--line)",
            background: "rgba(0,0,0,0.2)",
            color: selected ? "var(--ink)" : "var(--mute)",
          }}
        >
          <span className="min-w-0">
            {selected ? (
              <span className="block truncate text-[13px] font-medium">{selected.label}</span>
            ) : (
              <span className="block truncate text-[13px]">{placeholder}</span>
            )}
            {selected?.description && (
              <span className="mt-0.5 block truncate text-[11px] text-[var(--mute)]">
                {selected.description}
              </span>
            )}
          </span>
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")}
            style={{ color: "var(--mute)" }}
          />
        </button>

        {open && (
          <div
            ref={panelRef}
            className="absolute left-0 right-0 top-[calc(100%+8px)] z-50 overflow-hidden rounded-[14px] border"
            style={{
              borderColor: "var(--line-hi)",
              background: "color-mix(in oklch, var(--panel) 92%, transparent)",
              boxShadow: "var(--shadow-card)",
              backdropFilter: "blur(18px)",
            }}
          >
            {searchable && (
              <div className="border-b p-2.5" style={{ borderColor: "var(--line)" }}>
                <div
                  className="flex items-center gap-2 rounded-[10px] border px-2.5"
                  style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.02)" }}
                >
                  <Search className="h-3.5 w-3.5" style={{ color: "var(--mute)" }} />
                  <input
                    autoFocus
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search models"
                    className="h-9 w-full bg-transparent text-[13px] text-[var(--ink)] placeholder:text-[var(--mute)] focus:outline-none"
                  />
                </div>
              </div>
            )}

            <div className="max-h-72 overflow-y-auto p-1.5">
              {filteredOptions.length ? (
                filteredOptions.map((option) => {
                  const active = option.value === value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        onChange?.(option.value, option);
                        setOpen(false);
                      }}
                      className="flex w-full items-start gap-2 rounded-[10px] px-3 py-2 text-left transition-colors"
                      style={{
                        background: active
                          ? "color-mix(in oklch, var(--signal) 12%, transparent)"
                          : "transparent",
                        color: active ? "var(--ink)" : "var(--ink-dim)",
                      }}
                    >
                      <span
                        className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border"
                        style={{
                          borderColor: active
                            ? "color-mix(in oklch, var(--signal) 30%, transparent)"
                            : "var(--line)",
                          background: active
                            ? "color-mix(in oklch, var(--signal) 16%, transparent)"
                            : "transparent",
                        }}
                      >
                        {active && <Check className="h-3 w-3" style={{ color: "var(--signal)" }} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{option.label}</span>
                        {option.description && (
                          <span className="mt-0.5 block text-[11px] text-[var(--mute)]">
                            {option.description}
                          </span>
                        )}
                        {option.meta && (
                          <span className="mt-1 block font-mono text-[10px] text-[var(--mute-2)]">
                            {option.meta}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="px-3 py-6 text-center text-[12px] text-[var(--mute)]">
                  {emptyMessage}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
