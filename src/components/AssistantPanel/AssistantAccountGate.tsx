import { useMemo } from "react";
import { AlertCircle } from "lucide-react";

import {
  useTerminalColorSchemeStore,
  selectEffectiveTheme,
} from "@/store/terminalColorSchemeStore";
import { resolveInputBarColors } from "@/utils/terminalTheme";
import { buildAssistantPalette } from "./palette";
import { Button } from "@/components/ui/button";
import { DaintreeAssistantIcon } from "@/components/icons/brands/DaintreeAssistantIcon";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import type { AssistantLaunchGateReason } from "./assistantLaunchGate";

/**
 * What the assistant panel shows instead of booting an engine that could only fail.
 *
 * Deliberately quiet rather than an error: none of these are faults. The account needs
 * something from the user first, and the way forward is the whole content — an empty
 * state that names the next action rather than what is absent.
 *
 * It installs the assistant palette itself. Those `--assistant-*` variables are normally
 * declared by `AssistantPanelView`'s inline style block, and this component renders
 * INSTEAD of that view — so naming them without declaring them would resolve to nothing.
 * Reaching for app tokens instead is not the alternative: the panel's contrast floors are
 * enforced against the palette tiers, and a component that steps outside them is exactly
 * what `palette.contract.test.ts` exists to catch.
 */

interface GateCopy {
  headline: string;
  detail: string;
  actionLabel: string;
}

const COPY: Record<AssistantLaunchGateReason, GateCopy> = {
  "signed-out": {
    headline: "Sign in to use the assistant",
    detail: "Your Daintree account signs you in through your browser. It takes a moment.",
    actionLabel: "Sign in",
  },
  "subscription-required": {
    headline: "Choose a plan to use the assistant",
    detail: "You're signed in — the assistant needs an active plan before it can run.",
    actionLabel: "View plans",
  },
  "subscription-inactive": {
    // Not "choose a plan": there IS one, and it is not granting access. Sending someone
    // to buy a second is both wrong and expensive.
    headline: "Check your billing to use the assistant",
    detail: "Your plan isn't granting access right now. The assistant runs again once it is.",
    actionLabel: "Manage billing",
  },
  revoked: {
    headline: "Sign in again to use the assistant",
    detail: "Your assistant access was disconnected. Signing in restores it on this machine.",
    actionLabel: "Sign in",
  },
};

export interface AssistantAccountGateProps {
  reason: AssistantLaunchGateReason;
  /** True while a sign-in is running, so the gate can show progress and offer a cancel. */
  busy: boolean;
  /** The last operation failure, if one is worth showing. */
  error?: string | null;
  onAct: () => void;
  onCancel: () => void;
  onDismissError: () => void;
  className?: string;
}

export function AssistantAccountGate({
  reason,
  busy,
  error,
  onAct,
  onCancel,
  onDismissError,
  className,
}: AssistantAccountGateProps) {
  const copy = COPY[reason];

  // The same derivation the panel view uses, so the gate sits on the panel's ground with
  // the panel's ink rather than the app's.
  const termTheme = useTerminalColorSchemeStore(selectEffectiveTheme);
  const term = useMemo(() => resolveInputBarColors(termTheme), [termTheme]);
  const paletteVars = useMemo(() => buildAssistantPalette(term, termTheme), [term, termTheme]);

  return (
    <div
      className={className}
      data-testid="assistant-account-gate"
      style={{
        backgroundColor: paletteVars["--assistant-surface"],
        color: paletteVars["--assistant-fg"],
        ...paletteVars,
      }}
    >
      <div className="flex h-full w-full items-center justify-center p-6">
        <div className="max-w-sm space-y-3 text-center" role="status" aria-live="polite">
          <DaintreeAssistantIcon
            className="mx-auto h-8 w-8"
            style={{ color: "var(--assistant-fg-secondary)" }}
            aria-hidden="true"
          />
          <p className="text-sm font-medium">{copy.headline}</p>
          <p className="text-xs leading-relaxed" style={{ color: "var(--assistant-fg-secondary)" }}>
            {/* While the browser has it, say so — otherwise a disabled button is the only
                feedback and the sign-in looks like it did nothing. */}
            {busy ? "Finish signing in in your browser." : copy.detail}
          </p>

          {error && (
            <InlineStatusBanner
              severity="error"
              icon={AlertCircle}
              title="Sign-in failed"
              description={error}
              onClose={onDismissError}
              className="text-left"
            />
          )}

          {busy ? (
            <Button variant="subtle" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          ) : (
            <Button variant="subtle" size="sm" onClick={onAct}>
              {copy.actionLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
