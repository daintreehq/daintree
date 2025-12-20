import path from "node:path";

export interface AppProtocolHeaders extends Record<string, string> {
  "Content-Type": string;
  "Cross-Origin-Opener-Policy": string;
  "Cross-Origin-Embedder-Policy": string;
  "X-Content-Type-Options": string;
  "Cross-Origin-Resource-Policy": string;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
};

export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

export function buildHeaders(mimeType: string): AppProtocolHeaders {
  return {
    "Content-Type": mimeType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "credentialless",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

export function resolveAppUrlToDistPath(
  urlString: string,
  distRoot: string,
  options: { expectedHostname?: string } = {}
): { filePath: string; error?: string } {
  try {
    const url = new URL(urlString);

    if (url.protocol !== "app:") {
      return { filePath: "", error: "Invalid protocol" };
    }

    if (options.expectedHostname && url.hostname !== options.expectedHostname) {
      return { filePath: "", error: "Invalid host" };
    }

    let pathname = url.pathname;

    if (pathname === "/" || pathname === "") {
      pathname = "/index.html";
    }

    const relativePath = pathname.startsWith("/") ? pathname.slice(1) : pathname;

    const decodedPath = decodeURIComponent(relativePath);

    if (decodedPath.includes("\0")) {
      return { filePath: "", error: "Invalid path" };
    }
    if (decodedPath.includes("\\")) {
      return { filePath: "", error: "Invalid path separator" };
    }

    const normalizedPosix = path.posix.normalize("/" + decodedPath).slice(1);

    if (normalizedPosix.split("/").some((seg) => seg === "..")) {
      return { filePath: "", error: "Path traversal detected" };
    }

    const absoluteDistRoot = path.resolve(distRoot);
    const absoluteResolvedPath = path.resolve(absoluteDistRoot, normalizedPosix);

    if (
      !absoluteResolvedPath.startsWith(absoluteDistRoot + path.sep) &&
      absoluteResolvedPath !== absoluteDistRoot
    ) {
      return { filePath: "", error: "Path outside dist root" };
    }

    return { filePath: absoluteResolvedPath };
  } catch (error) {
    return {
      filePath: "",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
