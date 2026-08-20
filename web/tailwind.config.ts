import type { Config } from "tailwindcss";

/**
 * Base-themed dark design system.
 *
 * Colour choices are validated, not eyeballed (see web/README.md):
 *   - `base` #0052FF is Base's brand blue; `base.light` carries it onto dark surfaces.
 *   - `up`/`down` are #0ca678 / #e8590c — the conventional green/red fails colourblind
 *     separation in a readable lightness band (deutan ΔE ≈ 4 against a floor of 8). This pair
 *     scores deutan ΔE 11.3 and passes lightness, chroma and contrast against #0E1014.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#06070A",
        surface: "#0C0E13",
        elevated: "#13161D",
        raised: "#1A1E27",
        line: "#1E222B",
        hairline: "#161A22",
        muted: "#7C8698",
        dim: "#535C6D",

        brand: {
          DEFAULT: "#0052FF",
          light: "#4C8DFF",
          glow: "#2F6FFF",
          deep: "#0038B8",
        },

        up: "#0CA678",
        "up-light": "#20D9A0",
        down: "#E8590C",
        "down-light": "#FF8341",
        warn: "#F0B90B",
        gold: "#FFB020",
      },

      /**
       * Two families, split by job.
       *
       * `display` (Space Grotesk) carries names, tickers and every figure a trader reads at a
       * glance — it is geometric with tall, open numerals that stay distinct when compressed into
       * a card. `sans` (Inter) carries prose, where Space Grotesk's character gets tiring.
       *
       * Both are variable fonts, so the weight range costs one file each.
       */
      fontFamily: {
        sans: ["Inter Variable", "Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        display: [
          "Space Grotesk Variable",
          "Space Grotesk",
          "Inter Variable",
          "system-ui",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },

      boxShadow: {
        glow: "0 0 0 1px rgb(0 82 255 / 0.35), 0 0 28px -6px rgb(0 82 255 / 0.55)",
        "glow-sm": "0 0 18px -6px rgb(0 82 255 / 0.6)",
        "glow-up": "0 0 24px -6px rgb(12 166 120 / 0.7)",
        "glow-down": "0 0 24px -6px rgb(232 89 12 / 0.7)",
        "glow-gold": "0 0 26px -6px rgb(255 176 32 / 0.75)",
        lift: "0 18px 40px -18px rgb(0 0 0 / 0.9)",
      },

      backgroundImage: {
        "grid-fade":
          "linear-gradient(to bottom, rgb(30 34 43 / 0.55) 1px, transparent 1px), linear-gradient(to right, rgb(30 34 43 / 0.55) 1px, transparent 1px)",
      },

      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-in-left": {
          from: { opacity: "0", transform: "translateX(-14px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        marquee: {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(-50%)" },
        },
        shimmer: {
          "100%": { transform: "translateX(200%)" },
        },
        "pulse-ring": {
          "0%": { transform: "scale(0.85)", opacity: "0.7" },
          "70%": { transform: "scale(1.6)", opacity: "0" },
          "100%": { transform: "scale(1.6)", opacity: "0" },
        },
        "glow-breathe": {
          "0%, 100%": { opacity: "0.35" },
          "50%": { opacity: "0.85" },
        },
        drift: {
          "0%, 100%": { transform: "translate(0, 0) scale(1)" },
          "33%": { transform: "translate(4%, -3%) scale(1.08)" },
          "66%": { transform: "translate(-3%, 4%) scale(0.95)" },
        },
        "flash-up": {
          "0%": { backgroundColor: "rgb(12 166 120 / 0.30)" },
          "100%": { backgroundColor: "transparent" },
        },
        "flash-down": {
          "0%": { backgroundColor: "rgb(232 89 12 / 0.30)" },
          "100%": { backgroundColor: "transparent" },
        },
        "gradient-pan": {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-6px)" },
        },
        "spin-slow": {
          to: { transform: "rotate(360deg)" },
        },
      },

      animation: {
        "fade-up": "fade-up 0.45s cubic-bezier(0.16, 1, 0.3, 1) both",
        "fade-in": "fade-in 0.4s ease-out both",
        "slide-in-left": "slide-in-left 0.35s cubic-bezier(0.16, 1, 0.3, 1) both",
        marquee: "marquee 45s linear infinite",
        "marquee-fast": "marquee 24s linear infinite",
        shimmer: "shimmer 2.2s ease-in-out infinite",
        "pulse-ring": "pulse-ring 2s cubic-bezier(0.24, 0, 0.38, 1) infinite",
        "glow-breathe": "glow-breathe 4s ease-in-out infinite",
        drift: "drift 22s ease-in-out infinite",
        "flash-up": "flash-up 0.9s ease-out",
        "flash-down": "flash-down 0.9s ease-out",
        "gradient-pan": "gradient-pan 6s ease infinite",
        float: "float 5s ease-in-out infinite",
        "spin-slow": "spin-slow 14s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
