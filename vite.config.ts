import { defineConfig, type Plugin } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import {
  getDevServerConfig,
  getDevServerOrigins,
  getDevServerWebSocketOrigins,
} from "./shared/config/devServer";

const devServerConfig = getDevServerConfig();
const devServerOrigins = getDevServerOrigins();
const devServerWebSocketOrigins = getDevServerWebSocketOrigins();

// CSP definitions for development and production
const DEV_CSP = [
  `default-src 'self' ${devServerOrigins.join(" ")} ${devServerWebSocketOrigins.join(" ")}`,
  `script-src 'self' ${devServerOrigins.join(" ")} 'unsafe-eval'`,
  `style-src 'self' ${devServerOrigins.join(" ")} 'unsafe-inline'`,
  "font-src 'self' data:",
  `connect-src 'self' ${devServerOrigins.join(" ")} ${devServerWebSocketOrigins.join(" ")} canopy-file:`,
  `img-src 'self' ${devServerOrigins.join(" ")} https://avatars.githubusercontent.com canopy-file: data:`,
  "frame-src 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
].join("; ");

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "connect-src 'self' canopy-file:",
  "img-src 'self' https://avatars.githubusercontent.com canopy-file: data: blob:",
  "frame-src 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
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

export default defineConfig(({ mode }) => ({
  envPrefix: ["VITE_", "CANOPY_"],
  plugins: [
    react(),
    babel({
      presets: [reactCompilerPreset({ compilationMode: "infer" })],
    }),
    tailwindcss(),
    cspTransformPlugin(),
  ],
  base: "./",
  build: {
    target: "chrome144",
    modulePreload: { polyfill: false },
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rolldownOptions: {
      ...(mode === "production" && {
        treeshake: {
          manualPureFunctions: ["console.log", "console.info", "console.warn", "console.debug"],
        },
      }),
      output: {
        codeSplitting: {
          groups: [
            { name: "vendor-xterm", test: /node_modules[\\/]@xterm[\\/]/, priority: 70 },
            {
              name: "vendor-editor",
              test: /node_modules[\\/](@codemirror[\\/]|@uiw[\\/]|refractor[\\/])/,
              priority: 60,
            },
            {
              name: "vendor-motion",
              test: /node_modules[\\/]framer-motion[\\/]/,
              priority: 50,
            },
            {
              name: "vendor-icons",
              test: /node_modules[\\/]lucide-react[\\/]/,
              priority: 40,
            },
            {
              name: "vendor-ai-github",
              test: /node_modules[\\/](@octokit[\\/]|@ai-sdk[\\/]|ai[\\/])/,
              priority: 30,
            },
            {
              name: "vendor-zod",
              test: /node_modules[\\/](zod[\\/]|zod-to-json-schema[\\/])/,
              priority: 20,
            },
            { name: "vendor", test: /node_modules[\\/]/, priority: 10 },
          ],
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
    host: devServerConfig.host,
    port: devServerConfig.port,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
}));
