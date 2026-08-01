/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./app.js"],
  theme: {
    extend: {
      colors: {
        ink: '#14130F',
        panel: '#1E1C16',
        panel2: '#2A271E',
        paper: '#EDE6D6',
        paperdim: '#A89C82',
        signal: '#8FBC6B',
        amber: '#E8A33D',
        staticred: '#C9554F',
      },
      fontFamily: {
        display: ['"Big Shoulders"', 'sans-serif'],
        body: ['"IBM Plex Sans"', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
}
