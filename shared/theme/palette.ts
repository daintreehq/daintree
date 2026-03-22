export interface ThemeStrategy {
  shadowStyle?: "none" | "crisp" | "soft" | "atmospheric";
  noiseOpacity?: number;
  materialBlur?: number;
  materialSaturation?: number;
  radiusScale?: number;
  panelStateEdge?: boolean;
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
