import { REQUEST_STATUSES, type RequestStatus } from "./contracts";

const STATUS_LABELS: Record<(typeof REQUEST_STATUSES)[number], string> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
};

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * The report the synthetic provider "builds": a small SVG summary of how many
 * requests are in each status. Deterministic, so a reconciled job that
 * rebuilds it writes the same bytes.
 */
export function renderReportSvg(
  byStatus: Readonly<Record<RequestStatus, number>>,
  generatedAt: string
): string {
  const counts = REQUEST_STATUSES.map((status) => ({ status, count: byStatus[status] }));
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  const max = Math.max(1, ...counts.map((entry) => entry.count));
  const bars = counts
    .map((entry, index) => {
      const y = 56 + index * 36;
      const width = Math.round((entry.count / max) * 220);
      return `<text x="16" y="${y + 16}" font-size="13">${STATUS_LABELS[entry.status]}</text>
  <rect x="112" y="${y}" width="${width}" height="22" rx="4" fill="#5b8def" />
  <text x="${120 + width}" y="${y + 16}" font-size="13">${entry.count}</text>`;
    })
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="190" viewBox="0 0 400 190" font-family="system-ui, sans-serif" fill="#1f2328">
  <rect width="400" height="190" fill="#ffffff" />
  <text x="16" y="30" font-size="16" font-weight="600">Request Desk report</text>
  <text x="16" y="46" font-size="11" fill="#57606a">${escapeXml(`${total} requests · ${generatedAt}`)}</text>
  ${bars}
</svg>
`;
}
