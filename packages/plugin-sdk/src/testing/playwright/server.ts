import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { KIT_PATH, PANEL_CSS_PATH, SCRIPT_PATH, renderShell } from "./page.js";

export interface PanelPreviewServerOptions {
  title: string;
  script: string;
  css: string;
  kitDir: string;
}

export interface PanelPreviewServer {
  /** The page, ending in `/`. */
  url: string;
  close(): Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function mimeType(file: string): string {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** The file a kit path names, held inside the kit directory through symlinks. */
async function kitFile(root: string, urlPath: string): Promise<string | null> {
  let relative: string;
  try {
    relative = decodeURIComponent(urlPath.slice(KIT_PATH.length));
  } catch {
    return null;
  }
  if (relative.includes("\0")) return null;
  const inside = (target: string) => {
    const rel = path.relative(root, target);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  const candidate = path.resolve(root, relative);
  if (!inside(candidate)) return null;
  try {
    const real = await fs.realpath(candidate);
    return inside(real) && (await fs.stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

function send(res: http.ServerResponse, status: number, body: string | Buffer, type: string) {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(res.req.method === "HEAD" ? undefined : body);
}

/** Serve one built preview on loopback. A port of 0 picks a free one. */
export async function startPanelPreviewServer(
  opts: PanelPreviewServerOptions
): Promise<PanelPreviewServer> {
  const kitRoot = await fs.realpath(opts.kitDir);
  const html = renderShell(opts.title);
  let allowedHosts = new Set<string>();
  const server = http.createServer((req, res) => {
    void (async () => {
      // A site that rebinds a hostname to loopback must not read the build.
      if (!allowedHosts.has(req.headers.host ?? "")) {
        send(res, 403, "Forbidden\n", "text/plain; charset=utf-8");
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end();
        return;
      }
      const { pathname } = new URL(req.url ?? "/", "http://preview.invalid");
      if (pathname === "/" || pathname === "/index.html") {
        send(res, 200, html, "text/html; charset=utf-8");
      } else if (pathname === SCRIPT_PATH) {
        send(res, 200, opts.script, MIME_TYPES[".js"]!);
      } else if (pathname === PANEL_CSS_PATH) {
        send(res, 200, opts.css, MIME_TYPES[".css"]!);
      } else {
        const file = pathname.startsWith(KIT_PATH) ? await kitFile(kitRoot, pathname) : null;
        if (file) send(res, 200, await fs.readFile(file), mimeType(file));
        else send(res, 404, `Not found: ${pathname}\n`, "text/plain; charset=utf-8");
      }
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  let closing: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${port}/`,
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
