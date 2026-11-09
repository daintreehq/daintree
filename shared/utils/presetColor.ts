const PRESET_HEX_COLOR = /^#[0-9a-fA-F]{3,4}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/;

/** The hex forms an agent preset colour is saved in: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`. */
export function isPresetHexColor(value: unknown): value is string {
  return typeof value === "string" && PRESET_HEX_COLOR.test(value);
}
