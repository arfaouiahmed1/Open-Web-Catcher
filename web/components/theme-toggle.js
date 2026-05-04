"use client";

import { Laptop, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "light",  label: "Light",  Icon: Sun    },
  { value: "system", label: "System", Icon: Laptop },
  { value: "dark",   label: "Dark",   Icon: Moon   },
];

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const activeTheme = mounted ? (theme || "system") : "system";

  return (
    <div
      className="relative inline-flex items-center rounded-full border bg-background p-0.5"
      role="group"
      aria-label="Theme switcher"
    >
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
            className={cn(
              "relative z-10 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium transition-all duration-150",
              selected
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="h-3 w-3" />
          </button>
        );
      })}
    </div>
  );
}
