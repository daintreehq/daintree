const BADGE_SIZE = 32;
const BADGE_FONT_SIZE = 14;
const BADGE_BG_WAITING_FALLBACK = "#f59e0b"; // amber-500
const BADGE_BG_FAILED_FALLBACK = "#ef4444"; // red-500
const BADGE_TEXT_COLOR = "#ffffff";

let originalHref: string | null = null;
let badgeColors: { waiting: string; failed: string } | null = null;

function getBadgeColors(): { waiting: string; failed: string } {
  if (badgeColors) return badgeColors;

  const styles = getComputedStyle(document.documentElement);
  const waiting = styles.getPropertyValue("--color-status-warning").trim();
  const failed = styles.getPropertyValue("--color-status-error").trim();

  badgeColors = {
    waiting: waiting || BADGE_BG_WAITING_FALLBACK,
    failed: failed || BADGE_BG_FAILED_FALLBACK,
  };

  return badgeColors;
}

function createBadgeCanvas(count: number, hasFailures: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = BADGE_SIZE;
  canvas.height = BADGE_SIZE;
  const ctx = canvas.getContext("2d");

  if (!ctx) return canvas;

  const colors = getBadgeColors();

  // Draw badge circle
  ctx.fillStyle = hasFailures ? colors.failed : colors.waiting;
  ctx.beginPath();
  ctx.arc(BADGE_SIZE / 2, BADGE_SIZE / 2, BADGE_SIZE / 2 - 2, 0, Math.PI * 2);
  ctx.fill();

  // Draw count text
  ctx.fillStyle = BADGE_TEXT_COLOR;
  ctx.font = `bold ${BADGE_FONT_SIZE}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const displayText = count > 9 ? "9+" : String(count);
  ctx.fillText(displayText, BADGE_SIZE / 2, BADGE_SIZE / 2 + 1);

  return canvas;
}

function getFaviconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  return link;
}

export function updateFaviconBadge(waitingCount: number, failedCount: number): void {
  const link = getFaviconLink();

  // Store original href for restoration
  if (originalHref === null && link.href && !link.href.startsWith("data:")) {
    originalHref = link.href;
  }

  const totalCount = waitingCount + failedCount;

  if (totalCount === 0) {
    // Clear badge - restore original or remove favicon
    if (originalHref) {
      link.href = originalHref;
    } else {
      // Remove generated favicon
      link.removeAttribute("href");
    }
    return;
  }

  // Generate badge favicon
  const hasFailures = failedCount > 0;
  const canvas = createBadgeCanvas(totalCount, hasFailures);
  link.href = canvas.toDataURL("image/png");
}

export function clearFaviconBadge(): void {
  updateFaviconBadge(0, 0);
}
