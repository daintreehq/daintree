// Mutable WebGL pool size, isolated from xterm imports so the eager renderer
// chunk can update it (via useResourceProfile) without pulling @xterm/addon-webgl.
// Initial value matches the balanced resource profile (see RESOURCE_PROFILE_CONFIGS).
let maxContexts = 16;

export function getMaxContexts(): number {
  return maxContexts;
}

export function setMaxContexts(n: number): void {
  maxContexts = Math.max(1, n);
}

// Passive-mode gate: once this many agent terminals already hold (or are
// queued for) a WebGL context, new acquisitions are suppressed and those
// terminals render via the DOM renderer instead. This stops the release/
// reacquire churn that flashes terminals when a large fleet (20+) is visible
// at once. Initial value matches the balanced resource profile.
let passiveThreshold = 12;

export function getPassiveThreshold(): number {
  return passiveThreshold;
}

export function setPassiveThreshold(n: number): void {
  passiveThreshold = Math.max(1, n);
}
