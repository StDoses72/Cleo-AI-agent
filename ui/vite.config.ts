import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { localConfigPlugin } from "./local-config-plugin";

export default defineConfig(({ command }) => ({
  base: "./",
  plugins: [react(), localConfigPlugin(process.env.CLEO_PREVIEW_PYTHON)],
  define: { "import.meta.env.VITE_CLEO_LOCAL_CONFIG": JSON.stringify(command === "serve" && Boolean(process.env.CLEO_PREVIEW_PYTHON)) },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
}));
