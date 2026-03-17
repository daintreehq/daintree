export interface TrayItem {
  id: string;
  kind: "image" | "file";
  label: string;
  thumbnailUrl?: string;
  fileSize?: number;
  from: number;
  to: number;
}

interface ImageEntry {
  from: number;
  to: number;
  filePath: string;
  thumbnailUrl: string;
}

interface FileEntry {
  from: number;
  to: number;
  fileName: string;
  fileSize?: number;
}

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
  files: readonly FileEntry[]
): TrayItem[] {
  const items: TrayItem[] = [];

  for (const img of images) {
    items.push({
      id: `img-${img.from}-${img.to}`,
      kind: "image",
      label: imageLabel(img.filePath),
      thumbnailUrl: img.thumbnailUrl,
      from: img.from,
      to: img.to,
    });
  }

  for (const file of files) {
    items.push({
      id: `file-${file.from}-${file.to}`,
      kind: "file",
      label: file.fileName,
      fileSize: file.fileSize,
      from: file.from,
      to: file.to,
    });
  }

  items.sort((a, b) => a.from - b.from);
  return items;
}
