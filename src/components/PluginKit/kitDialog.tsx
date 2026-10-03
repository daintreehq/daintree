import type { ReactNode } from "react";
import type { PluginDialogAction } from "@shared/types/plugin-sdk-react";
import {
  AppDialog,
  type DialogAction,
  type DialogPlacement,
  type DialogSize,
} from "@/components/ui/AppDialog";
import { renderIconSource } from "./PluginKitIcons";
import {
  content,
  fn,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  PluginStyleScope,
  scopedContent,
} from "./kitProps";
import { PluginKitLayerContext, type PluginKitLayer } from "./kitScope";

function readDialogAction(action: PluginDialogAction | undefined): DialogAction | undefined {
  if (typeof action !== "object" || action === null) return undefined;
  const label = nonEmpty(action.label);
  const onClick = fn(action.onClick);
  if (!label || !onClick) return undefined;
  return {
    label,
    onClick: () => onClick(),
    disabled: action.disabled === true,
    loading: action.loading === true,
    intent: oneOf(action.intent, ["default", "destructive"] as const),
    icon: renderIconSource(action.icon) ?? undefined,
  };
}

/**
 * A disabled primary's reason, for the footer hint. Only the primary: it is
 * the one button the host points at the hint with `aria-describedby`.
 */
function disabledReasonOf(action: PluginDialogAction | undefined): ReactNode {
  if (typeof action !== "object" || action === null || action.disabled !== true) return undefined;
  return scopedContent(action.disabledReason);
}

export function iconNode(source: unknown): ReactNode {
  return renderIconSource(source) ?? undefined;
}

export function zIndexOf(layer: unknown): "nested" | undefined {
  return layer === "nested" ? "nested" : undefined;
}

export function layerOf(layer: unknown): PluginKitLayer {
  return layer === "nested" ? "nested" : "modal";
}

export function noop() {}

/** What `Dialog` and `Sheet` share, as the plugin passed it. */
export interface KitDialogFrameProps {
  open: unknown;
  onClose: (() => void) | undefined;
  title: unknown;
  icon: unknown;
  description: unknown;
  children: unknown;
  size: DialogSize;
  placement: DialogPlacement;
  primaryAction: PluginDialogAction | undefined;
  secondaryAction: PluginDialogAction | undefined;
  hint: unknown;
  footer: unknown;
  dismissible: unknown;
  layer: unknown;
  testId: unknown;
}

/**
 * The host dialog with a plugin's title, body and footer: the `Dialog` card,
 * or a `Sheet` against the window's edge. The chrome is host-owned; the body
 * and a custom footer are the plugin's, scoped to its styles.
 */
export function KitDialogFrame({
  open,
  onClose,
  title,
  icon,
  description,
  children,
  size,
  placement,
  primaryAction,
  secondaryAction,
  hint,
  footer,
  dismissible,
  layer,
  testId,
}: KitDialogFrameProps) {
  const primary = readDialogAction(primaryAction);
  const secondary = readDialogAction(secondaryAction);
  const custom = content(footer);
  const footerHint =
    scopedContent(hint) ?? (custom === undefined ? disabledReasonOf(primaryAction) : undefined);
  return (
    // Context reaches through the dialog's portal, so kit overlays opened
    // inside it can stack above a nested dialog.
    <PluginKitLayerContext.Provider value={layerOf(layer)}>
      <AppDialog
        isOpen={open === true}
        onClose={fn(onClose) ?? noop}
        size={size}
        placement={placement}
        dismissible={dismissible !== false}
        zIndex={zIndexOf(layer)}
        data-testid={nonEmpty(testId)}
      >
        <AppDialog.Header>
          <AppDialog.Title icon={iconNode(icon)}>{scopedContent(title)}</AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        <AppDialog.Body>
          <PluginStyleScope block className="space-y-3">
            {hasContent(description) ? (
              <AppDialog.Description>{node(description)}</AppDialog.Description>
            ) : null}
            {node(children)}
          </PluginStyleScope>
        </AppDialog.Body>
        {custom !== undefined ? (
          <AppDialog.Footer hint={footerHint}>
            {/* One container: a hint spreads the footer, and loose controls would scatter across it. */}
            <PluginStyleScope block className="flex shrink-0 items-center gap-3">
              {custom}
            </PluginStyleScope>
          </AppDialog.Footer>
        ) : primary || secondary ? (
          <AppDialog.Footer primaryAction={primary} secondaryAction={secondary} hint={footerHint} />
        ) : null}
      </AppDialog>
    </PluginKitLayerContext.Provider>
  );
}
