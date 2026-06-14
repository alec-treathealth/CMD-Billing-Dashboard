import type { Config } from 'tailwindcss';

/**
 * Tailwind config wired for shadcn/ui (CSS-variable theming). Colors map to the
 * token set in app/globals.css; radius derives from --radius.
 */
const config: Config = {
  darkMode: ['class'],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        head: ['Space Grotesk', 'Inter', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        // TreatHealthOS card shadow
        ths: '0 4px 16px -6px rgba(14,58,58,.12)',
        'ths-lg': '0 18px 40px -12px rgba(14,58,58,.18)',
      },
      colors: {
        // TreatHealthOS brand tokens (raw hex) — used for the teal900 anchor
        // bar and sparing coral accents alongside the shadcn semantic mapping.
        teal900: '#0E3A3A',
        teal700: '#135E5A',
        teal500: '#1C8B82',
        teal200: '#B7DAD5',
        teal50: '#EAF4F2',
        coral600: '#E2674F',
        coral400: '#F0917C',
        coral50: '#FCEDE8',
        ground: '#FBF8F4',
        surface: '#FFFFFF',
        ink900: '#1B2B2A',
        ink600: '#4A5C5A',
        ink400: '#859794',
        line: '#E4E9E6',
        status: {
          ok: '#2E8B6F',
          warn: '#C9881E',
          danger: '#C0453B',
          info: '#2D7393',
          neutral: '#6B7B79',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
