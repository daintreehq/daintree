import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { REPORT_PATH, type PreviewChapterReport } from "./protocol.js";

/** URL prefix the plugin's own files are served under. */
export const PLUGIN_PATH = "/plugin/";

export interface PreviewAsset {
  body: string | Buffer;
  type: string;
}

export interface TourPreviewServerOptions {
  pluginDir: string;
  /** Page shell served at `/`. */
  html: string;
  /** Everything else the preview itself serves, by absolute URL path. */
  assets: ReadonlyMap<string, PreviewAsset>;
  onReport?: (report: PreviewChapterReport) => void;
  host?: string;
  /** 0 picks a free port. */
  port?: number;
}

export interface TourPreviewServer {
  url: string;
  close(): Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
};

export function mimeType(file: string): string {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** A single `bytes=` range within `size`, or null when absent or unsatisfiable. */
export function parseRange(header: string | undefined, size: number): [number, number] | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start <= end && start < size ? [start, end] : null;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The file a `/plugin/…` path names, or null. Resolved through symlinks and
 * held inside the plugin directory, so nothing else on disk is reachable.
 */
async function pluginFile(root: string, urlPath: string): Promise<string | null> {
  let relative: string;
  try {
    relative = decodeURIComponent(urlPath.slice(PLUGIN_PATH.length));
  } catch {
    return null;
  }
  if (relative.includes("\0")) return null;
  const candidate = path.resolve(root, relative);
  if (!isInside(root, candidate)) return null;
  try {
    const real = await fs.realpath(candidate);
    if (!isInside(root, real)) return null;
    return (await fs.stat(real)).isFile() ? real : null;
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

async function servePluginFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  file: string
): Promise<void> {
  const { size } = await fs.stat(file);
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": mimeType(file),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  let range: [number, number] | null = null;
  if (req.headers.range !== undefined) {
    range = parseRange(req.headers.range, size);
    if (!range) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
  }
  const [start, end] = range ?? [0, size - 1];
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  headers["Content-Length"] = size === 0 ? 0 : end - start + 1;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD" || size === 0) {
    res.end();
    return;
  }
  // pipeline() closes the file when the page abandons a request mid-stream,
  // which scrubbing audio does constantly.
  await pipeline(createReadStream(file, { start, end }), res).catch(() => {});
}

async function readReport(req: http.IncomingMessage): Promise<PreviewChapterReport | null> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 64 * 1024) return null;
  }
  try {
    const parsed = JSON.parse(body) as Partial<PreviewChapterReport>;
    if (typeof parsed.chapterId !== "string" || !Array.isArray(parsed.undefinedCues)) return null;
    return {
      chapterId: parsed.chapterId,
      undefinedCues: parsed.undefinedCues.filter((cue): cue is string => typeof cue === "string"),
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * A plain static server, deliberately not Vite's: the plugin's built module
 * keeps its bare `react` and `@daintreehq/tour` imports for the page's import
 * map to resolve, and a dev server would rewrite them first. Listens on
 * loopback only.
 */
export async function startTourPreviewServer(
  opts: TourPreviewServerOptions
): Promise<TourPreviewServer> {
  const root = await fs.realpath(opts.pluginDir);
  let allowedHosts = new Set<string>();
  const server = http.createServer((req, res) => {
    void (async () => {
      // Another site that rebinds a hostname to loopback would otherwise read
      // the plugin's files through this server.
      if (!allowedHosts.has(req.headers.host ?? "")) {
        send(res, 403, "Forbidden\n", "text/plain; charset=utf-8");
        return;
      }
      const url = new URL(req.url ?? "/", "http://preview.invalid");
      if (req.method === "POST" && url.pathname === REPORT_PATH) {
        const report = await readReport(req);
        if (report) opts.onReport?.(report);
        res.writeHead(report ? 204 : 400);
        res.end();
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end();
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        send(res, 200, opts.html, MIME_TYPES[".html"]!);
        return;
      }
      const asset = opts.assets.get(url.pathname);
      if (asset) {
        send(res, 200, asset.body, asset.type);
        return;
      }
      if (url.pathname.startsWith(PLUGIN_PATH)) {
        const file = await pluginFile(root, url.pathname);
        if (file) {
          await servePluginFile(req, res, file);
          return;
        }
      }
      send(res, 404, `Not found: ${url.pathname}\n`, "text/plain; charset=utf-8");
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { address, port } = server.address() as AddressInfo;
  const host = address.includes(":") ? `[${address}]` : address;
  // Browsers leave the default port out of `Host`.
  const bare = port === 80 ? [host, "localhost"] : [];
  allowedHosts = new Set([`${host}:${port}`, `localhost:${port}`, ...bare]);

  let closing: Promise<void> | null = null;
  return {
    url: `http://${host}:${port}/`,
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
