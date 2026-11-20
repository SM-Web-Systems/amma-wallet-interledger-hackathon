import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import manifest from "./manifest.json";
import path from "path";
import { requireApiUrl } from "./src/shared/lib/build-env";

export default defineConfig(({ command, mode }) => {
  if (command === "build") requireApiUrl(loadEnv(mode, process.cwd(), "VITE_").VITE_API_URL ?? process.env.VITE_API_URL);
  return {
  plugins: [
    react(),
    crx({ manifest }),
    tailwindcss(),
    nodePolyfills({ include: ["buffer", "stream", "crypto"] }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/shared"),
      "@popup": path.resolve(__dirname, "src/popup"),
    },
  },
  build: {
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          stellar: ["@stellar/stellar-sdk"],
          vendor: ["react", "react-dom", "react-router-dom", "zustand", "@tanstack/react-query"],
        },
      },
    },
  },
  };
});
