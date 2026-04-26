/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,jsx}",
    "./components/**/*.{js,jsx}",
    "./lib/**/*.{js,jsx}",
  ],
  theme: {
    extend: {
      colors: {
        /* surfaces */
        bg:       "#05080f",
        panel:    "#0a1220",
        "panel-2":"#0f1828",
        ink:      "#060c16",   /* kept for compat */
        surface:  "#0a1220",   /* kept for compat */

        /* text */
        "ink-text": "#f2f5fa",
        "ink-dim":  "#c4cbd8",
        mute:       "#7a8699",
        "mute-2":   "#515d70",
        "mute-3":   "#2f3746",

        /* accents — warm amber signal replaces stock blue */
        signal:  "oklch(0.76 0.13 64)",   /* warm amber — primary */
        mint:    "oklch(0.78 0.13 170)",  /* green */
        violet:  "oklch(0.72 0.14 300)",  /* purple */
        rose:    "oklch(0.70 0.15 20)",   /* red */
        sky:     "oklch(0.76 0.12 240)",  /* blue */

        /* backwards-compat aliases */
        surge:  "oklch(0.78 0.13 170)",   /* = mint */
        spark:  "oklch(0.76 0.13 64)",    /* = signal */
        ember:  "oklch(0.70 0.15 20)",    /* = rose */
        muted:  "#515d70",

        border: "rgba(255,255,255,0.07)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: {
        card: "10px",
        "card-lg": "14px",
      },
      boxShadow: {
        card: "0 1px 0 rgba(255,255,255,0.04) inset, 0 10px 30px -18px rgba(0,0,0,0.9)",
        glow: "0 0 0 1px color-mix(in oklch, oklch(0.76 0.13 64) 40%, transparent), 0 10px 30px -10px color-mix(in oklch, oklch(0.76 0.13 64) 35%, transparent)",
      },
      animation: {
        breathe:          "breathe 2.4s ease-in-out infinite",
        "pulse-ring":     "pulse-ring 1.8s ease-out infinite",
        scan:             "scan 2.4s linear infinite",
        tput:             "tput 1.4s ease-in-out infinite",
        wave:             "wave 1.1s ease-in-out infinite",
        "fade-up":        "fade-up 220ms ease both",
        "slide-in-right": "slide-in-right 180ms ease both",
        "glow-pulse":     "glow-pulse 2s ease-in-out infinite",
        "agent-arrive":   "agent-arrive 240ms cubic-bezier(0.34,1.56,0.64,1) both",
        "tool-pop":       "tool-pop-fade 2.2s ease forwards",
        "count-pop":      "count-pop 300ms ease",
        "ping-once":      "ping-once 0.7s ease forwards",
        "spin-slow":      "spin-slow 3s linear infinite",
        "fill-bar":       "fill-bar 600ms cubic-bezier(0.4,0,0.2,1) both",
      },
      keyframes: {
        breathe: {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%":      { opacity: "0.55", transform: "scale(0.92)" },
        },
        "pulse-ring": {
          "0%":   { transform: "scale(1)", opacity: "0.6" },
          "100%": { transform: "scale(2.4)", opacity: "0" },
        },
        scan: {
          "0%":   { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        tput: {
          "0%, 100%": { height: "10%", background: "var(--mute-3)" },
          "50%":      { height: "90%", background: "var(--signal)" },
        },
        wave: {
          "0%, 100%": { height: "20%" },
          "50%":      { height: "100%" },
        },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to:   { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(14px)" },
          to:   { opacity: "1", transform: "translateX(0)" },
        },
        "glow-pulse": {
          "0%, 100%": { boxShadow: "0 0 0 0 transparent, 0 0 0 2px color-mix(in oklch, var(--signal) 40%, transparent)" },
          "50%":      { boxShadow: "0 0 0 4px transparent, 0 0 0 2px color-mix(in oklch, var(--signal) 70%, transparent)" },
        },
        "agent-arrive": {
          from: { opacity: "0", transform: "scale(0.88)" },
          to:   { opacity: "1", transform: "scale(1)" },
        },
        "tool-pop-fade": {
          "0%":   { opacity: "0", transform: "translateY(0px) scale(0.8)" },
          "15%":  { opacity: "1", transform: "translateY(-6px) scale(1)" },
          "75%":  { opacity: "1", transform: "translateY(-8px) scale(1)" },
          "100%": { opacity: "0", transform: "translateY(-12px) scale(0.9)" },
        },
        "count-pop": {
          "0%":   { transform: "scale(1)" },
          "40%":  { transform: "scale(1.06)" },
          "100%": { transform: "scale(1)" },
        },
        "ping-once": {
          "0%":   { transform: "scale(1)", opacity: "0.8" },
          "80%":  { transform: "scale(2.2)", opacity: "0" },
          "100%": { transform: "scale(2.2)", opacity: "0" },
        },
        "spin-slow": {
          to: { transform: "rotate(360deg)" },
        },
        "fill-bar": {
          from: { transform: "scaleX(0)", transformOrigin: "left" },
          to:   { transform: "scaleX(1)", transformOrigin: "left" },
        },
      },
    },
  },
  plugins: [],
};
