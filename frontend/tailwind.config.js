/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'var(--pm-background)',
        foreground: 'var(--pm-foreground)',
        card: 'var(--pm-card)',
        'card-foreground': 'var(--pm-card-foreground)',
        popover: 'var(--pm-popover)',
        'popover-foreground': 'var(--pm-popover-foreground)',
        primary: 'var(--pm-primary)',
        'primary-foreground': 'var(--pm-primary-foreground)',
        muted: 'var(--pm-muted)',
        'muted-foreground': 'var(--pm-muted-foreground)',
        border: 'var(--pm-border)',
        input: 'var(--pm-input)',
        ring: 'var(--pm-ring)',
        success: 'var(--pm-state-success)',
        warning: 'var(--pm-state-warning)',
        error: 'var(--pm-state-error)',
        info: 'var(--pm-state-info)',
      },
      fontFamily: {
        sans: ['Inter', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Fira Code', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        xs: 'var(--pm-radius-xs)',
        sm: 'var(--pm-radius-sm)',
        md: 'var(--pm-radius-md)',
        lg: 'var(--pm-radius-lg)',
        pill: 'var(--pm-radius-pill)',
      },
      boxShadow: {
        1: 'var(--pm-shadow-1)',
        2: 'var(--pm-shadow-2)',
      },
    },
  },
  plugins: [],
}
