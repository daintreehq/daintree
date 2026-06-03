export interface ThemeStrategy {
  shadowStyle?: "none" | "crisp" | "soft" | "atmospheric" | "light";
  noiseOpacity?: number;
  materialBlur?: number;
  materialSaturation?: number;
  radiusScale?: number;
  panelStateEdge?: boolean;
  /**
   * Override the ink the engine composites into the border ladder
   * (border-subtle/strong/divider/interactive). The engine defaults to a cool
   * near-black on light / additive white on dark. Warm or cool light themes can
   * set an on-temperature ink (e.g. a warm charcoal for Atacama) to get borders
   * that match their identity without overriding all four border tokens by hand.
   * Hex string; falls back to the engine default when omitted.
   */
  borderInkOverride?: string;
  /**
   * Scalar multiplier (default 1) applied to the per-polarity alpha of every
   * status surface wash (success/warning/danger/info). Lets a theme dial the
   * tint intensity of banners/pills up or down — e.g. lighter washes on a
   * high-key light palette — without redefining each surface token.
   */
  statusSurfaceOpacity?: number;
}

export interface ThemePalette {
  type: "dark" | "light";
  surfaces: {
    grid: string;
    sidebar: string;
    canvas: string;
    panel: string;
    elevated: string;
  };
  text: {
    primary: string;
    secondary: string;
    muted: string;
    inverse: string;
  };
  border: string;
  accent: string;
  accentSecondary?: string;
  status: {
    success: string;
    warning: string;
    danger: string;
    info: string;
  };
  activity: {
    active: string;
    idle: string;
    working: string;
    waiting: string;
  };
  overlayTint?: string;
  terminal?: {
    background?: string;
    foreground?: string;
    muted?: string;
    cursor?: string;
    selection: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
  syntax: {
    comment: string;
    punctuation: string;
    number: string;
    string: string;
    operator: string;
    keyword: string;
    function: string;
    link: string;
    quote: string;
    chip: string;
  };
  strategy?: ThemeStrategy;
}
