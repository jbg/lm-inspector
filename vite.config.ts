import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Spiral design-system components are shipped as .jsx; let esbuild treat them
// as JSX without conversion.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "safari16",
  },
});
