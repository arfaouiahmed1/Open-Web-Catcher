/** @type {import('tailwindcss').Config} */
module.exports = {
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
        sans: ["'Inter Tight'", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "monospace"],
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
        breathe: "breathe 2.4s ease-in-out infinite",
        "pulse-ring": "pulse-ring 1.8s ease-out infinite",
        scan:    "scan 2.4s linear infinite",
        tput:    "tput 1.4s ease-in-out infinite",
        wave:    "wave 1.1s ease-in-out infinite",
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
      },
    },
  },
  plugins: [],
};
