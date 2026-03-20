import type { Page } from "@playwright/test";

export interface ActiveElementInfo {
  tagName: string;
  role: string | null;
  ariaLabel: string | null;
  testId: string | null;
  className: string;
  isTerminal: boolean;
  textContent: string;
  parentInfo: string;
}

export async function getActiveElementInfo(page: Page): Promise<ActiveElementInfo | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const cn = typeof el.className === "string" ? el.className : "";
    const parent = el.parentElement;
    return {
      tagName: el.tagName,
      role: el.getAttribute("role"),
      ariaLabel: el.getAttribute("aria-label"),
      testId: el.getAttribute("data-testid"),
      className: cn,
      isTerminal: cn.includes("xterm-helper-textarea") || cn.includes("cm-content"),
      textContent: (el.textContent ?? "").slice(0, 50).trim(),
      parentInfo: parent
        ? `${parent.tagName}.${(typeof parent.className === "string" ? parent.className : "").slice(0, 60)}`
        : "",
    };
  });
}

export function elementKey(info: ActiveElementInfo): string {
  return `${info.tagName}|${info.role ?? ""}|${info.ariaLabel ?? ""}|${info.testId ?? ""}`;
}

export async function escapeTerminalFocus(page: Page): Promise<void> {
  await page.keyboard.press("F6");
  await page.waitForFunction(
    () => {
      const el = document.activeElement;
      if (!el) return true;
      const cn = typeof el.className === "string" ? el.className : "";
      return !cn.includes("xterm-helper-textarea") && !cn.includes("cm-content");
    },
    { timeout: 3000 }
  );
}

export async function hasVisibleFocusIndicator(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return false;
    const cn = typeof el.className === "string" ? el.className : "";
    if (cn.includes("xterm-helper-textarea") || cn.includes("cm-content")) return true;

    function isTransparent(color: string): boolean {
      if (!color || color === "transparent") return true;
      const match = color.match(/rgba?\([\d.\s,/]+\)/);
      if (match) {
        const parts = color.match(/[\d.]+/g);
        if (parts && parts.length >= 4 && parseFloat(parts[3]) === 0) return true;
      }
      return false;
    }

    function checkStyles(target: Element): boolean {
      const s = getComputedStyle(target);
      const hasOutline =
        s.outlineStyle !== "none" &&
        parseFloat(s.outlineWidth) > 0 &&
        !isTransparent(s.outlineColor);
      const hasBoxShadow = s.boxShadow !== "none" && s.boxShadow !== "";
      return hasOutline || hasBoxShadow;
    }

    if (checkStyles(el)) return true;
    if (el.parentElement && checkStyles(el.parentElement)) return true;
    return false;
  });
}
