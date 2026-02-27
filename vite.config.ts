import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// CSP definitions for development and production
const DEV_CSP = [
  "default-src 'self' http://localhost:5173 ws://localhost:5173",
  "script-src 'self' http://localhost:5173 'unsafe-eval'",
  "style-src 'self' http://localhost:5173 'unsafe-inline'",
  "font-src 'self' data:",
  "connect-src 'self' http://localhost:5173 ws://localhost:5173",
  "img-src 'self' http://localhost:5173 https://avatars.githubusercontent.com data:",
  "frame-src 'self' https://www.youtube.com http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
].join("; ");

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "img-src 'self' https://avatars.githubusercontent.com data: blob:",
  "frame-src 'self' https://www.youtube.com http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

// Plugin to transform CSP meta tag based on build mode
function cspTransformPlugin(): Plugin {
  return {
    name: "csp-transform",
    transformIndexHtml(html, ctx) {
      const csp = ctx.server ? DEV_CSP : PROD_CSP;
      const cspRegex = /<meta\s+[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i;

      if (!cspRegex.test(html)) {
        throw new Error(
          'CSP meta tag not found in index.html. Expected: <meta http-equiv="Content-Security-Policy" ...>'
        );
      }

      return html.replace(
        cspRegex,
        `<meta http-equiv="Content-Security-Policy" content="${csp}" />`
      );
    },
  };
}

function getVendorChunk(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;

  if (id.includes("/node_modules/@xterm/")) {
    return "vendor-xterm";
  }
  if (
    id.includes("/node_modules/@codemirror/") ||
    id.includes("/node_modules/@uiw/") ||
    id.includes("/node_modules/refractor/")
  ) {
    return "vendor-editor";
  }
  if (id.includes("/node_modules/framer-motion/")) {
    return "vendor-motion";
  }
  if (id.includes("/node_modules/lucide-react/")) {
    return "vendor-icons";
  }
  if (
    id.includes("/node_modules/@octokit/") ||
    id.includes("/node_modules/@ai-sdk/") ||
    id.includes("/node_modules/ai/")
  ) {
    return "vendor-ai-github";
  }
  if (id.includes("/node_modules/zod/") || id.includes("/node_modules/zod-to-json-schema/")) {
    return "vendor-zod";
  }

  return "vendor";
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cspTransformPlugin()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          return getVendorChunk(id);
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
