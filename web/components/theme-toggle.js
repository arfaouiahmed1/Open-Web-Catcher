"use client";

import { Laptop, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";

const OPTIONS = [
  { value: "light",  label: "Light",  Icon: Sun    },
  { value: "system", label: "System", Icon: Laptop },
  { value: "dark",   label: "Dark",   Icon: Moon   },
];

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef(null);
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });

  useEffect(() => { setMounted(true); }, []);

  const activeTheme = mounted ? (theme || "system") : "system";

  /* compute indicator position */
  useEffect(() => {
    if (!containerRef.current || !mounted) return;
    const btns = containerRef.current.querySelectorAll("button");
    const idx = OPTIONS.findIndex((o) => o.value === activeTheme);
    if (idx >= 0 && btns[idx]) {
      const btn = btns[idx];
      setIndicatorStyle({ left: btn.offsetLeft, width: btn.offsetWidth });
    }
  }, [activeTheme, mounted]);

  return (
    <div
      ref={containerRef}
      className="relative flex items-center rounded-full p-0.5"
      style={{
        border: "1px solid var(--line)",
        background: "var(--card)",
      }}
      role="group"
      aria-label="Theme switcher"
    >
      {/* sliding indicator */}
      <span
        className="pointer-events-none absolute rounded-full"
        style={{
          left: indicatorStyle.left,
          width: indicatorStyle.width,
          top: 2,
          bottom: 2,
          background: "color-mix(in oklch, var(--signal) 16%, transparent)",
          border: "1px solid color-mix(in oklch, var(--signal) 28%, transparent)",
          transition: "left 200ms cubic-bezier(0.4,0,0.2,1), width 200ms cubic-bezier(0.4,0,0.2,1)",
        }}
      />

      {OPTIONS.map(({ value, label, Icon }) => {
        const selected = activeTheme === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            aria-label={`Use ${label.toLowerCase()} theme`}
            aria-pressed={selected}
            title={value === "system" ? `System (${mounted ? resolvedTheme : "…"})` : label}
            className="relative z-10 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors duration-150"
            style={{
              color: selected ? "var(--signal)" : "var(--mute)",
            }}
          >
            <Icon
              className="h-3 w-3 transition-transform duration-150"
              style={{ transform: selected ? "scale(1.15)" : "scale(1)" }}
            />
            <span className="hidden lg:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
