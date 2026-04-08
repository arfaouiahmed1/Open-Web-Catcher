/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,jsx}",
    "./components/**/*.{js,jsx}",
    "./lib/**/*.{js,jsx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#08131f",
        mist: "#d7e4ef",
        dune: "#f5ecde",
        surge: "#16b8a6",
        spark: "#ff8c42",
        ember: "#ef4444",
        signal: "#75a9ff"
      },
      boxShadow: {
        panel: "0 24px 80px rgba(8, 19, 31, 0.18)"
      }
    }
  },
  plugins: []
};
