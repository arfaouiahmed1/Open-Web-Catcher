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
        ink:    "#060c16",
        surface:"#0c1623",
        border: "rgba(255,255,255,0.08)",
        signal: "#3b82f6",   // blue
        surge:  "#10b981",   // green
        spark:  "#f59e0b",   // amber
        ember:  "#ef4444",   // red
        violet: "#8b5cf6",
        muted:  "#475569",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "ui-monospace", "monospace"],
      },
      boxShadow: {
        card: "0 1px 3px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.06)",
        glow: "0 0 24px rgba(59,130,246,0.15)",
      },
      animation: {
        pulse: "pulse 2s cubic-bezier(0.4,0,0.6,1) infinite",
      },
    },
  },
  plugins: [],
};
