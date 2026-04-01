/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        newsroom: {
          bg: '#0D1117',
          surface: '#161B22',
          border: '#21262D',
          muted: '#30363D',
          text: '#E6EDF3',
          subtle: '#8B949E',
          green: '#3FB950',
          yellow: '#D29922',
          red: '#F85149',
          blue: '#58A6FF',
          purple: '#BC8CFF',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin 2s linear infinite',
      },
    },
  },
  plugins: [],
};
