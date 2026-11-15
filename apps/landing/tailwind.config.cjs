module.exports = { corePlugins: { container: false }, content: ['./src/**/*.{astro,html,ts,tsx}', '../../packages/ui/**/*.{astro,tsx}'], presets: [require('../../packages/ui/tailwind.preset.cjs')] };
