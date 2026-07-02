import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#1f7a4d",
          dark: "#155c39",
          light: "#e7f4ec",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
