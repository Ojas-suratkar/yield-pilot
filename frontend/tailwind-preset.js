/** Shared Tailwind preset: every design defines the same CSS variables with its own values. */
const animate = require("tailwindcss-animate");
const containerQueries = require("@tailwindcss/container-queries");
const c = (name) => `hsl(var(--${name}) / <alpha-value>)`;

module.exports = {
  darkMode: ["class"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "var(--font-sans)", "system-ui", "sans-serif"],
      },
      colors: {
        border: c("border"),
        input: c("input"),
        ring: c("ring"),
        background: c("background"),
        foreground: c("foreground"),
        primary: { DEFAULT: c("primary"), foreground: c("primary-foreground") },
        secondary: { DEFAULT: c("secondary"), foreground: c("secondary-foreground") },
        muted: { DEFAULT: c("muted"), foreground: c("muted-foreground") },
        destructive: { DEFAULT: c("destructive"), foreground: c("destructive-foreground") },
        card: { DEFAULT: c("card"), foreground: c("card-foreground") },
        popover: { DEFAULT: c("popover"), foreground: c("popover-foreground") },
        highlight: { DEFAULT: c("highlight"), foreground: c("highlight-foreground") },
        good: c("good"),
        warn: c("warn"),
        sidebar: {
          DEFAULT: c("sidebar"),
          foreground: c("sidebar-foreground"),
          muted: c("sidebar-muted"),
          accent: c("sidebar-accent"),
          border: c("sidebar-border"),
        },
      },
      borderRadius: {
        card: "var(--radius-card)",
        btn: "var(--radius-btn)",
      },
    },
  },
  plugins: [animate, containerQueries],
};
