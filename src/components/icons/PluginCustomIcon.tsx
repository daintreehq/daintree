import { useSyncExternalStore, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { svgToDataUrl } from "@/lib/svg";
import type { PluginIconComponent, PluginIconProps } from "./pluginIconRegistry";
import { getPluginCustomIcon, subscribePluginCustomIcons } from "./pluginCustomIconStore";

const components = new Map<string, Map<PluginIconComponent, PluginIconComponent>>();

/**
 * A plugin-shipped SVG drawn as a CSS mask over `currentColor` (#13143). The
 * markup never enters the DOM: as a mask image it is processed in the SVG
 * image mode, which runs no script and fetches nothing, and the mask keeps
 * only its alpha, so the icon takes the surrounding text colour the way the
 * built-in glyphs do rather than its own fills.
 *
 * The mask is painted on an empty `<svg>` sized exactly like a Lucide glyph —
 * `width`/`height` attributes defaulting to 24, which any sizing class
 * overrides — so the `[&_svg]:size-4` and `svg.mr-2` rules that size and space
 * the built-in icons apply to this one too.
 *
 * Draws `fallback` while the asset is missing — before the first snapshot
 * arrives, or after its plugin unloads.
 */
function createPluginCustomIcon(
  key: string,
  Fallback: PluginIconComponent
): PluginIconComponent {
  function PluginCustomIcon(props: PluginIconProps) {
    const asset = useSyncExternalStore(subscribePluginCustomIcons, () => getPluginCustomIcon(key));
    if (!asset) return <Fallback {...props} />;
    const { className, size = 24, width, height, style, "aria-hidden": ariaHidden, ...rest } = props;
    const maskStyle: CSSProperties = {
      backgroundColor: "currentColor",
      // Forced-colors mode repaints backgrounds with the system Canvas colour,
      // which would hide the glyph; opting out keeps the inherited text colour.
      forcedColorAdjust: "none",
      maskImage: `url("${svgToDataUrl(asset.svg)}")`,
      maskMode: "alpha",
      maskSize: "contain",
      maskRepeat: "no-repeat",
      maskPosition: "center",
      ...style,
    };
    return (
      <svg
        {...rest}
        xmlns="http://www.w3.org/2000/svg"
        width={width ?? size}
        height={height ?? size}
        data-plugin-icon={key}
        aria-hidden={ariaHidden ?? true}
        className={cn("shrink-0", className)}
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
