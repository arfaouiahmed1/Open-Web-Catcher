import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        /* ── shadcn/ui semantic tokens ── */
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",

        sidebar: {
          DEFAULT: "var(--sidebar)",
          foreground: "var(--sidebar-foreground)",
          primary: "var(--sidebar-primary)",
          "primary-foreground": "var(--sidebar-primary-foreground)",
          accent: "var(--sidebar-accent)",
          "accent-foreground": "var(--sidebar-accent-foreground)",
          border: "var(--sidebar-border)",
          ring: "var(--sidebar-ring)",
        },

        chart: {
          1: "var(--chart-1)",
          2: "var(--chart-2)",
          3: "var(--chart-3)",
          4: "var(--chart-4)",
          5: "var(--chart-5)",
        },

        /* ── OWC accent palette (charts / status) ── */
        signal: "oklch(0.76 0.13 64)",
        mint: "oklch(0.78 0.13 170)",
        violet: "oklch(0.72 0.14 300)",
        rose: "oklch(0.70 0.15 20)",
        sky: "oklch(0.76 0.12 240)",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        glow: "var(--shadow-glow)",
      },
      animation: {
        breathe: "breathe 2.4s ease-in-out infinite",
        "pulse-ring": "pulse-ring 1.8s ease-out infinite",
        scan: "scan 2.4s linear infinite",
        "fade-up": "fade-up 220ms ease both",
        "slide-in-right": "slide-in-right 180ms ease both",
        "glow-pulse": "glow-pulse 2s ease-in-out infinite",
        "agent-arrive": "agent-arrive 240ms cubic-bezier(0.34,1.56,0.64,1) both",
        "tool-pop": "tool-pop-fade 2.2s ease forwards",
        "count-pop": "count-pop 300ms ease",
        "ping-once": "ping-once 0.7s ease forwards",
        "spin-slow": "spin-slow 3s linear infinite",
        "fill-bar": "fill-bar 600ms cubic-bezier(0.4,0,0.2,1) both",
      },
      keyframes: {
        breathe: {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.55", transform: "scale(0.92)" },
        },
        "pulse-ring": {
          "0%": { transform: "scale(1)", opacity: "0.6" },
          "100%": { transform: "scale(2.4)", opacity: "0" },
        },
        scan: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(14px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "glow-pulse": {
          "0%, 100%": { boxShadow: "0 0 0 2px color-mix(in oklch, var(--signal) 40%, transparent)" },
          "50%": { boxShadow: "0 0 0 2px color-mix(in oklch, var(--signal) 70%, transparent)" },
        },
        "agent-arrive": {
          from: { opacity: "0", transform: "scale(0.88)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        "tool-pop-fade": {
          "0%": { opacity: "0", transform: "translateY(0px) scale(0.8)" },
          "15%": { opacity: "1", transform: "translateY(-6px) scale(1)" },
          "75%": { opacity: "1", transform: "translateY(-8px) scale(1)" },
          "100%": { opacity: "0", transform: "translateY(-12px) scale(0.9)" },
        },
        "count-pop": {
          "0%": { transform: "scale(1)" },
          "40%": { transform: "scale(1.06)" },
          "100%": { transform: "scale(1)" },
        },
        "ping-once": {
          "0%": { transform: "scale(1)", opacity: "0.8" },
          "80%": { transform: "scale(2.2)", opacity: "0" },
          "100%": { transform: "scale(2.2)", opacity: "0" },
        },
        "spin-slow": {
          to: { transform: "rotate(360deg)" },
        },
        "fill-bar": {
          from: { transform: "scaleX(0)", transformOrigin: "left" },
          to: { transform: "scaleX(1)", transformOrigin: "left" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
