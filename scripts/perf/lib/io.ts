import fs from "node:fs";
import path from "node:path";

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf-8");
}

/**
 * Append to a file the harness does not own — `$GITHUB_STEP_SUMMARY` is the
 * only caller, and Actions hands every step of a job the same file. Truncating
 * it would erase whatever ran before us.
 */
export function appendText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, content, "utf-8");
}

export function appendJsonLine(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(data)}\n`, "utf-8");
}

export function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) return null;
  return JSON.parse(raw) as T;
}
