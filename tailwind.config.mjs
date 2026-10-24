/** @type {import('tailwindcss').Config} */

// "indigo" is the app's accent colour. It's mapped to CSS variables so each club's chosen
// colour (components/brand.js) re-colours the whole app. Defaults live in app/globals.css.
const brand = Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900]
  .map((n) => [n, `rgb(var(--brand-${n}) / <alpha-value>)`]));

export default {
  content: ['./app/**/*.{js,jsx}', './components/**/*.{js,jsx}'],
  theme: { extend: { colors: { indigo: brand } } },
  plugins: [],
};
