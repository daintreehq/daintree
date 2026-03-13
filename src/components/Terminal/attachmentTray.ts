import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";

export interface TrayItem {
  id: string;
  kind: "image" | "file" | "url";
  label: string;
  tokenEstimate: number;
  from: number;
  to: number;
}

interface ImageEntry {
  from: number;
  to: number;
  filePath: string;
}

interface FileEntry {
  from: number;
  to: number;
  fileName: string;
}

interface UrlEntry {
  from: number;
  to: number;
  title: string;
  tokenEstimate: number;
  sourceUrl: string;
}

const IMAGE_TOKEN_ESTIMATE = 1_000;
const FILE_TOKEN_ESTIMATE = 500;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const WARNING_THRESHOLD = 0.8;

function imageLabel(filePath: string): string {
  const match = filePath.match(/clipboard-(\d+)-/);
  if (match) {
    const date = new Date(Number(match[1]));
    if (!isNaN(date.getTime())) {
      const hh = String(date.getHours()).padStart(2, "0");
      const mm = String(date.getMinutes()).padStart(2, "0");
      return `Screenshot ${hh}:${mm}`;
    }
  }
  return "Screenshot";
}

export function normalizeChips(
  images: readonly ImageEntry[],
  files: readonly FileEntry[],
  urls: readonly UrlEntry[]
): TrayItem[] {
  const items: TrayItem[] = [];

  for (const img of images) {
    items.push({
      id: `img-${img.from}-${img.to}`,
      kind: "image",
      label: imageLabel(img.filePath),
      tokenEstimate: IMAGE_TOKEN_ESTIMATE,
      from: img.from,
      to: img.to,
    });
  }

  for (const file of files) {
    items.push({
      id: `file-${file.from}-${file.to}`,
      kind: "file",
      label: file.fileName,
      tokenEstimate: FILE_TOKEN_ESTIMATE,
      from: file.from,
      to: file.to,
    });
  }

  for (const url of urls) {
    items.push({
      id: `url-${url.from}-${url.to}`,
      kind: "url",
      label: url.title || url.sourceUrl,
      tokenEstimate: url.tokenEstimate,
      from: url.from,
      to: url.to,
    });
  }

  return items;
}

export function buildSummaryLine(items: TrayItem[]): string {
  const counts = { image: 0, file: 0, url: 0 };
  let totalTokens = 0;
  for (const item of items) {
    counts[item.kind]++;
    totalTokens += item.tokenEstimate;
  }

  const parts: string[] = [];
  if (counts.image > 0) parts.push(`${counts.image} image${counts.image !== 1 ? "s" : ""}`);
  if (counts.file > 0) parts.push(`${counts.file} file${counts.file !== 1 ? "s" : ""}`);
  if (counts.url > 0) parts.push(`${counts.url} URL${counts.url !== 1 ? "s" : ""}`);

  return `${parts.join(" \u00b7 ")} \u00b7 ~${totalTokens.toLocaleString()} tokens`;
}

export function getContextWindow(agentId: string | undefined): number {
  if (!agentId) return DEFAULT_CONTEXT_WINDOW;
  return getEffectiveAgentConfig(agentId)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

export function isWarningUsage(totalTokens: number, contextWindow: number): boolean {
  return totalTokens / contextWindow >= WARNING_THRESHOLD;
}
