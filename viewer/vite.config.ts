import { defineConfig } from "vite";

export default defineConfig({
  base: "./",                       // served by `ebo atlas serve` and opened from packets as plain static files
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 8000,
    // Stable file names: rebuilds overwrite in place instead of accumulating hashed copies.
    rolldownOptions: { output: { entryFileNames: "assets/[name].js", chunkFileNames: "assets/[name].js", assetFileNames: "assets/[name][extname]" } },
    rollupOptions: { output: { entryFileNames: "assets/[name].js", chunkFileNames: "assets/[name].js", assetFileNames: "assets/[name][extname]" } },
  },
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
  worker: { format: "es", rollupOptions: { output: { entryFileNames: "assets/[name].js" } } },
});
