import "@/components/Layout/__preview__/launcherShims";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { BrandSurface } from "@/components/icons";
import { activeWorkspaceIdentity, branchChipState } from "@/lib/workspaceIdentity";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToolbarProjectPill } from "@/components/Layout/ToolbarProjectPill";
import { ProjectIdentityEditor } from "../ProjectIdentityEditor";
import { ProjectEmojiButton } from "../ProjectEmojiButton";
import type { Project } from "@shared/types";
import "@/index.css";

/**
 * Standalone visual-review harness for the "Edit name and icon" popover and the
 * shared emoji picker inside it.
 *
 * Mounts the real `ProjectIdentityEditor` beside the real `ToolbarProjectPill`
 * in a stand-in of the toolbar's project group, opened, exactly as the pill's
 * context menu leaves it. One fixture per page load (`?fixture=`): the popover
 * autofocuses its name field and is portaled, so two open at once would fight
 * over focus and stack on top of each other. The spec
 * (`project-identity-review.spec.ts`) drives the interactive states — hover,
 * keyboard, search — on top of a fixture.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=<slug>           one of FIXTURES below
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureSlug = params.get("fixture") ?? "rest";

interface Fixture {
  slug: string;
  name: string;
  emoji: string;
  /** Mount the dialog-row `ProjectEmojiButton` instead of the toolbar editor. */
  emojiButton?: boolean;
}

/** Mirrored as `FIXTURES` in the spec — keep the two lists in step. */
const FIXTURES: Fixture[] = [
  { slug: "rest", name: "Daintree", emoji: "🌴" },
  { slug: "suggestion", name: "payments-api", emoji: "🌲" },
  { slug: "long-name", name: "helios-analytics-dashboard-platform-monorepo", emoji: "☀️" },
  { slug: "emoji-button", name: "Daintree", emoji: "🌴", emojiButton: true },
];

function makeProject(fixture: Fixture): Project {
  return {
    id: `preview-${fixture.slug}`,
    path: `/Users/dev/Projects/${fixture.name}`,
    name: fixture.name,
    emoji: fixture.emoji,
    lastOpened: 0,
  };
}

function ToolbarStage({ fixture }: { fixture: Fixture }) {
  const project = useMemo(() => makeProject(fixture), [fixture]);
  const [open, setOpen] = useState(true);
  const identity = activeWorkspaceIdentity(project, null);
  const chipState = branchChipState(identity.kind, "develop", true, false);
  return (
    <BrandSurface surface="surface-toolbar">
      <div
        data-preview-strip=""
        className="@container/toolbar relative grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-x-3 h-12 items-center px-4 shrink-0 surface-toolbar border-y border-divider"
        style={{ width: 1100 }}
      >
        <div />
        <div
          role="group"
          aria-label="Project"
          className="relative flex items-center justify-center min-w-0 max-w-full justify-self-center"
        >
          <ProjectIdentityEditor project={project} open={open} onOpenChange={setOpen} />
          <ToolbarProjectPill
            workspaceIdentity={identity}
            emoji={project.emoji}
            chipState={chipState}
            branchName="develop"
            isDropdownOpen={false}
            data-state="closed"
          />
        </div>
        <div />
      </div>
    </BrandSurface>
  );
}

function EmojiButtonStage({ fixture }: { fixture: Fixture }) {
  const [emoji, setEmoji] = useState(fixture.emoji);
  return (
    <div data-preview-strip="" className="flex items-center gap-3 p-4" style={{ width: 1100 }}>
      <ProjectEmojiButton emoji={emoji} onEmojiChange={setEmoji} />
      <span className="text-sm text-text-primary">{fixture.name}</span>
    </div>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);
  const fixture = FIXTURES.find((f) => f.slug === fixtureSlug) ?? FIXTURES[0]!;

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    setReady(true);
  }, [scheme]);

  if (!ready) return null;

  return (
    <TooltipProvider>
      <div data-preview-shell="" data-fixture={fixture.slug} className="flex flex-col pt-4">
        {fixture.emojiButton ? (
          <EmojiButtonStage fixture={fixture} />
        ) : (
          <ToolbarStage fixture={fixture} />
        )}
      </div>
    </TooltipProvider>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
