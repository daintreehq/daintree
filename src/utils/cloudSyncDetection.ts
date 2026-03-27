export type CloudSyncService = "OneDrive" | "Google Drive" | "Dropbox" | "iCloud Drive";

export type Platform = "mac" | "windows" | "linux";

interface SyncRoot {
  prefix: string;
  service: CloudSyncService;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function buildRoots(home: string, platform: Platform): SyncRoot[] {
  if (platform === "mac") {
    const cs = `${home}/Library/CloudStorage`;
    return [
      { prefix: `${cs}/OneDrive-`, service: "OneDrive" },
      { prefix: `${cs}/OneDrive`, service: "OneDrive" },
      { prefix: `${cs}/GoogleDrive-`, service: "Google Drive" },
      { prefix: `${cs}/Dropbox-`, service: "Dropbox" },
      { prefix: `${cs}/Dropbox`, service: "Dropbox" },
      { prefix: `${home}/Library/Mobile Documents`, service: "iCloud Drive" },
    ];
  }

  if (platform === "windows") {
    return [
      { prefix: `${home}/OneDrive`, service: "OneDrive" },
      { prefix: `${home}/Dropbox`, service: "Dropbox" },
      { prefix: `${home}/My Drive`, service: "Google Drive" },
    ];
  }

  // Linux
  return [
    { prefix: `${home}/Dropbox`, service: "Dropbox" },
    { prefix: `${home}/OneDrive`, service: "OneDrive" },
  ];
}

function matchesPrefix(
  projectPath: string,
  prefix: string,
  caseInsensitive: boolean,
): boolean {
  const p = caseInsensitive ? projectPath.toLowerCase() : projectPath;
  const r = caseInsensitive ? prefix.toLowerCase() : prefix;

  if (!p.startsWith(r)) return false;

  // Must be exact match, followed by `/`, or prefix ends with `-` (e.g., OneDrive-Personal)
  const rest = projectPath.slice(prefix.length);
  if (rest.length === 0) return true;
  if (rest[0] === "/") return true;
  // Allow prefix patterns like "OneDrive-" where the next char is part of the folder name
  if (prefix.endsWith("-")) return true;
  // Windows OneDrive Business: "OneDrive - Company" or Dropbox Team: "Dropbox (Team)"
  if (rest[0] === " " || rest[0] === "(") return true;
  return false;
}

export function detectCloudSyncService(
  projectPath: string,
  homeDir: string,
  platform: Platform,
): CloudSyncService | null {
  if (!projectPath || !homeDir) return null;

  const normalizedPath = normalizePath(projectPath);
  const normalizedHome = normalizePath(homeDir);
  const caseInsensitive = platform !== "linux";
  const roots = buildRoots(normalizedHome, platform);

  for (const root of roots) {
    if (matchesPrefix(normalizedPath, root.prefix, caseInsensitive)) {
      return root.service;
    }
  }

  return null;
}
