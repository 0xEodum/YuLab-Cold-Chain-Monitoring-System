import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const projectRoot = path.resolve(__dirname, "..");

// The frontend reads deployments/localhost.json and reuses scripts/lib/sensor.js from the
// Hardhat project one level up, so Vite must be allowed to serve files from there.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@backend": projectRoot,
    },
  },
  server: {
    port: 5173,
    fs: { allow: [projectRoot] },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test-setup.js"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{js,jsx}"],
      exclude: ["src/main.jsx", "src/test-setup.js", "src/**/*.test.{js,jsx}"],
    },
  },
});
