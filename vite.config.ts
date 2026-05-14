import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// base: "./" → emit relative URLs in dist, so the bundle works under
// ANY hosted path (GitHub Pages /repo-name/, root, file://, etc.)
// without needing to know the deploy URL at build time.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
