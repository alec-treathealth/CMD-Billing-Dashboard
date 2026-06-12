import type { Config } from 'tailwindcss';

/**
 * Minimal Tailwind config wired for shadcn/ui (CSS-variable theming). No custom
 * design tokens yet — UI polish is a later step.
 */
const config: Config = {
  darkMode: ['class'],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
