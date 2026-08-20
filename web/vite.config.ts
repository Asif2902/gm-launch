import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_API_PROXY_TARGET ?? "http://localhost:4100";

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        /**
         * LI.FI's Solana and Bitcoin adapters `import { Buffer } from "buffer"`, which Vite
         * externalises to the Node builtin and leaves undefined in the browser. Pointing it at
         * the userland `buffer` package makes the import resolve to a real implementation.
         */
        buffer: "buffer/",
      },
    },

    server: {
      port: 5174,
      // Cloudflare quick tunnels (`*.trycloudflare.com`) fail Vite's host check otherwise.
      allowedHosts: [".trycloudflare.com"],
      /**
       * Same-origin `/api` in development.
       *
       * The metadata API runs as its own process (it holds the Turso and R2 credentials and
       * runs `sharp`, none of which can live in a browser bundle). Proxying rather than
       * pointing the client at `localhost:4100` keeps requests same-origin, so there is no CORS
       * preflight in dev and the client code is identical in both environments.
       */
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: true,
      rollupOptions: {
        output: {
          // Split the heavy, rarely-changing dependencies so a code change doesn't force users
          // to re-download the wallet stack and charting library.
          manualChunks: {
            react: ["react", "react-dom", "react-router-dom"],
            wallet: ["wagmi", "viem"],
            charts: ["lightweight-charts"],
          },
        },
      },
    },
  };
});
