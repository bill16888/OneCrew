import type { Config } from 'tailwindcss';

/**
 * Tailwind dark-theme tokens for AI-Native Team Workspace.
 *
 * Visual rules (Requirements 9.1, 9.2, 9.3):
 *   - Background: #0A0A0A (workspace canvas)
 *   - Primary: Indigo #6366F1
 *   - AI Badge: purple gradient (#A855F7 → #6366F1)
 *   - AI message accent: vertical purple bar on the left edge
 */
const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    './store/**/*.{ts,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: '1rem',
      screens: {
        '2xl': '1400px',
      },
    },
    extend: {
      colors: {
        // Canvas + surface scale tuned for the #0A0A0A base
        background: '#0A0A0A',
        foreground: '#F5F5F5',
        surface: {
          DEFAULT: '#111113',
          raised: '#17171A',
          overlay: '#1F1F23',
        },
        border: '#27272A',
        muted: {
          DEFAULT: '#1A1A1D',
          foreground: '#A1A1AA',
        },
        // Indigo primary (Requirements 9.1)
        primary: {
          DEFAULT: '#6366F1',
          foreground: '#FFFFFF',
          50: '#EEF2FF',
          100: '#E0E7FF',
          200: '#C7D2FE',
          300: '#A5B4FC',
          400: '#818CF8',
          500: '#6366F1',
          600: '#4F46E5',
          700: '#4338CA',
          800: '#3730A3',
          900: '#312E81',
        },
        // Purple — AI Badge & AI message accents (Requirements 9.2, 9.3)
        ai: {
          DEFAULT: '#A855F7',
          accent: '#A855F7',
          gradientFrom: '#A855F7',
          gradientTo: '#6366F1',
          50: '#FAF5FF',
          100: '#F3E8FF',
          200: '#E9D5FF',
          300: '#D8B4FE',
          400: '#C084FC',
          500: '#A855F7',
          600: '#9333EA',
          700: '#7E22CE',
          800: '#6B21A8',
          900: '#581C87',
        },
        destructive: {
          DEFAULT: '#EF4444',
          foreground: '#FFFFFF',
        },
        success: {
          DEFAULT: '#10B981',
          foreground: '#FFFFFF',
        },
      },
      backgroundImage: {
        // AI Badge gradient — used on AI messages and AI task cards
        'ai-gradient': 'linear-gradient(135deg, #A855F7 0%, #6366F1 100%)',
      },
      borderRadius: {
        lg: '0.75rem',
        md: '0.5rem',
        sm: '0.375rem',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      boxShadow: {
        'ai-glow': '0 0 0 1px rgba(168, 85, 247, 0.4), 0 0 24px rgba(99, 102, 241, 0.25)',
      },
      keyframes: {
        'ai-pulse': {
          '0%, 100%': { opacity: '0.65' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        'ai-pulse': 'ai-pulse 1.5s ease-in-out infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
