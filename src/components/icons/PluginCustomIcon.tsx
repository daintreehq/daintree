import { useSyncExternalStore, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { svgToDataUrl } from "@/lib/svg";
import type { PluginIconComponent, PluginIconProps } from "./pluginIconRegistry";
import { getPluginCustomIcon, subscribePluginCustomIcons } from "./pluginCustomIconStore";

const components = new Map<string, Map<PluginIconComponent, PluginIconComponent>>();

/** Whether `className` already sizes the box (`w-4`, `h-3.5`, `size-5`, …). */
function hasSizingClass(className: string | undefined): boolean {
  return /(?:^|\s)(?:[\w-]+:)*(?:size|w|h)-\S/.test(className ?? "");
}

/**
 * A plugin-shipped SVG drawn as a CSS mask over `currentColor` (#13143). The
 * markup never enters the DOM: as a mask image it is processed in the SVG
 * image mode, which runs no script and fetches nothing, and the mask keeps
 * only its alpha, so the icon takes the surrounding text colour the way the
 * built-in glyphs do rather than its own fills.
 *
 * Draws `fallback` while the asset is missing — before the first snapshot
 * arrives, or after its plugin unloads.
 */
function createPluginCustomIcon(
  key: string,
  Fallback: PluginIconComponent
): PluginIconComponent {
  function PluginCustomIcon({
    className,
    size,
    width,
    height,
    style,
    "aria-hidden": ariaHidden,
  }: PluginIconProps) {
    const asset = useSyncExternalStore(subscribePluginCustomIcons, () => getPluginCustomIcon(key));
    if (!asset) {
      return (
        <Fallback
          className={className}
          size={size}
          width={width}
          height={height}
          style={style}
          aria-hidden={ariaHidden}
        />
      );
    }
    const resolvedWidth = width ?? size;
    const resolvedHeight = height ?? size;
    const mask = `url("${svgToDataUrl(asset.svg)}")`;
    const maskStyle: CSSProperties = {
      width: resolvedWidth,
      height: resolvedHeight,
      backgroundColor: "currentColor",
      // Forced-colors mode repaints backgrounds with the system Canvas colour,
      // which would hide the glyph; opting out keeps the inherited text colour.
      forcedColorAdjust: "none",
      maskImage: mask,
      maskMode: "alpha",
      maskSize: "contain",
      maskRepeat: "no-repeat",
      maskPosition: "center",
      ...style,
    };
    return (
      <span
        data-plugin-icon={key}
        aria-hidden={ariaHidden ?? true}
        // Lucide's 24px default only when the caller sizes nothing. Left out
        // rather than overridden when a class sizes it: tailwind-merge keeps
        // `size-6` beside `w-4 h-4`, and stylesheet order would pick the winner.
        className={cn(
          "inline-block shrink-0",
          resolvedWidth === undefined &&
            resolvedHeight === undefined &&
            !hasSizingClass(className) &&
            "size-6",
          className
        )}
        style={maskStyle}
      />
    );
  }
  return PluginCustomIcon;
}

/**
 * The component for custom-icon `key` with `fallback`. Cached so a caller
 * resolving the same pair on every render gets a stable component identity
 * and React never remounts it.
 */
export function getPluginCustomIconComponent(
  key: string,
  fallback: PluginIconComponent
): PluginIconComponent {
  let byFallback = components.get(key);
  if (!byFallback) {
    byFallback = new Map();
    components.set(key, byFallback);
  }
  let component = byFallback.get(fallback);
  if (!component) {
    component = createPluginCustomIcon(key, fallback);
    byFallback.set(fallback, component);
  }
  return component;
}
