import fs from "node:fs/promises";
import path from "node:path";

export async function resolveNextMajorVersion(cwd: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(path.join(cwd, "node_modules/next/package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    const version = pkg?.version;
    if (typeof version === "string") {
      const major = parseInt(version.split(".")[0], 10);
      if (major >= 1) return major;
    }
  } catch {
    // fall through to package.json deps check
  }

  try {
    const raw = await fs.readFile(path.join(cwd, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    const versionSpec: unknown = pkg?.dependencies?.next ?? pkg?.devDependencies?.next;
    if (typeof versionSpec === "string") {
      const stripped = versionSpec.replace(/^[\^~>=<v\s]+/, "");
      const major = parseInt(stripped.split(".")[0], 10);
      if (major >= 1) return major;
    }
  } catch {
    // fall through to null
  }

  console.debug("[resolveNextVersion] Could not resolve Next.js version for", cwd);
  return null;
}
