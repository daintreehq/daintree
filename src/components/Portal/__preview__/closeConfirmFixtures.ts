import type { PortalTab } from "@shared/types/portal";
import type { PortalPendingCloseKind } from "@/store/portalPendingCloseStore";

/**
 * Bulk-close confirm states for the visual-review harness. Type-only imports:
 * the capture spec reads this file under Playwright's Node loader.
 */

export interface CloseConfirmFixture {
  kind: PortalPendingCloseKind;
  tabs: PortalTab[];
  /** Viewport height; a short one makes a long list scroll inside the dialog. */
  height?: number;
  /** A pointer or keyboard state the spec performs after load. */
  drive?: "hover-row" | "focus-row";
}

const claude: PortalTab = {
  id: "t-claude",
  url: "https://claude.ai/chat/7c1e0f2a-91d4-4b8e-a3f6-2c5d8e9b1a07",
  title: "Refactor the portal tab store",
  icon: "claude",
};
const chatgpt: PortalTab = {
  id: "t-chatgpt",
  url: "https://chatgpt.com/c/91ab33c2-6e0f-4d7a-b1c8-5f2e9d4a7b30",
  title: "Zustand selector equality",
  icon: "codex",
};
const gemini: PortalTab = {
  id: "t-gemini",
  url: "https://gemini.google.com/app/5d2f8a91c3e4",
  title: "Gemini",
  icon: "gemini",
};
const mdn: PortalTab = {
  id: "t-mdn",
  url: "https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver",
  title: "ResizeObserver - Web APIs | MDN",
};
const github: PortalTab = {
  id: "t-github",
  url: "https://github.com/daintreehq/daintree/pull/13379/files",
  title: "Hosts overview exchanges by gpriday · Pull Request #13379 · daintreehq/daintree",
};
const localhost: PortalTab = {
  id: "t-localhost",
  url: "http://localhost:5173/settings/billing",
  title: "Orchid Studio — Billing",
};
const vite: PortalTab = {
  id: "t-vite",
  url: "https://vite.dev/guide/build.html#multi-page-app",
  title: "Building for Production | Vite",
};
const tailwind: PortalTab = {
  id: "t-tailwind",
  url: "https://tailwindcss.com/docs/text-overflow",
  title: "text-overflow - Typography - Tailwind CSS",
};
const electron: PortalTab = {
  id: "t-electron",
  url: "https://www.electronjs.org/docs/latest/api/web-contents-view",
  title: "WebContentsView | Electron",
};
const stripe: PortalTab = {
  id: "t-stripe",
  url: "https://dashboard.stripe.com/test/payments?status=failed",
  title: "Payments – Orchid Studio – Stripe",
};
const linear: PortalTab = {
  id: "t-linear",
  url: "https://linear.app/orchid/issue/ORC-482/billing-page-shows-stale-plan",
  title: "ORC-482 Billing page shows stale plan after upgrade",
};
const sentry: PortalTab = {
  id: "t-sentry",
  url: "https://orchid.sentry.io/issues/5123987640/?project=4504",
  title: "TypeError: Cannot read properties of undefined (reading 'plan')",
};

const longTitleA: PortalTab = {
  id: "t-long-a",
  url: "https://stackoverflow.com/questions/7993067/text-overflow-ellipsis-not-working",
  title:
    "css - text-overflow: ellipsis not working on a flex child inside a grid cell with min-width auto, even with overflow hidden set on every ancestor - Stack Overflow",
};
const longTitleB: PortalTab = {
  id: "t-long-b",
  url: "https://www.nngroup.com/articles/confirmation-dialog/",
  title:
    "Confirmation Dialogs Can Prevent User Errors (If Not Overused) — Nielsen Norman Group research on when to interrupt",
};
const longTitleC: PortalTab = {
  id: "t-long-c",
  url: "https://docs.github.com/en/rest/pulls/pulls",
  title:
    "REST API endpoints for pull requests - GitHub Docs: list, create, get, update, merge, and check whether a pull request has been merged",
};

const longUrlA: PortalTab = {
  id: "t-url-a",
  url: "https://www.google.com/search?q=electron+webcontentsview+partition+persist+cookies+after+eviction&sca_esv=8c1f2b9a7e&source=hp&ei=Zx4kZ9qLJ8Wr0PEPq7mU-AM&iflsig=AL9hbdgAAAAAZyQ",
  title: "electron webcontentsview partition persist cookies after eviction - Google Search",
};
const longUrlB: PortalTab = {
  id: "t-url-b",
  url: "https://preview-pr-13379-hosts-overview-exchanges.orchid-studio-staging.pages.dev/settings/billing/invoices/2026-09?utm_source=slack",
  title: "Invoices",
};
const longUrlC: PortalTab = {
  id: "t-url-c",
  url: "https://github.com/daintreehq/daintree/blob/develop/src/components/Terminal/TerminalDestructiveActionConfirmDialog.tsx#L239-L300",
  title: "daintree/src/components/Terminal/TerminalDestructiveActionConfirmDialog.tsx at develop",
};

const longHost: PortalTab = {
  id: "t-url-d",
  url: "https://orchid-studio-customer-onboarding-and-billing-portal-preview-environment.app/",
  title: "Onboarding",
};

const untitled: PortalTab = {
  id: "t-untitled",
  url: "https://orchid-studio.pages.dev/embed/chart?id=4f2a",
  title: "",
};
const blank: PortalTab = { id: "t-blank", url: null, title: "New tab" };

export const CLOSE_CONFIRM_FIXTURES = {
  "two-tabs": { kind: "closeOthers", tabs: [claude, mdn] },
  "many-tabs": {
    kind: "closeAll",
    tabs: [
      claude,
      chatgpt,
      gemini,
      mdn,
      github,
      localhost,
      vite,
      tailwind,
      electron,
      stripe,
      linear,
      sentry,
    ],
    height: 760,
  },
  "long-titles": { kind: "closeToRight", tabs: [longTitleA, longTitleB, longTitleC, gemini] },
  "long-urls": {
    kind: "closeOthers",
    tabs: [longUrlA, longUrlB, longUrlC, longHost, localhost],
  },
  untitled: { kind: "closeToRight", tabs: [untitled, blank, github] },
  "hover-row": {
    kind: "closeOthers",
    tabs: [longUrlC, longTitleA, localhost],
    drive: "hover-row",
  },
  "focus-row": {
    kind: "closeOthers",
    tabs: [longUrlC, longTitleA, localhost],
    drive: "focus-row",
  },
} satisfies Record<string, CloseConfirmFixture>;

export type CloseConfirmFixtureName = keyof typeof CLOSE_CONFIRM_FIXTURES;

export const CLOSE_CONFIRM_FIXTURE_NAMES = Object.keys(
  CLOSE_CONFIRM_FIXTURES
) as CloseConfirmFixtureName[];

export function isCloseConfirmFixtureName(name: string): name is CloseConfirmFixtureName {
  return Object.hasOwn(CLOSE_CONFIRM_FIXTURES, name);
}

export function getCloseConfirmFixture(name: CloseConfirmFixtureName): CloseConfirmFixture {
  return CLOSE_CONFIRM_FIXTURES[name];
}
