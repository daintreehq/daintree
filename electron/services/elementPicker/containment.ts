import path from "node:path";

/** `paths` is the platform's own except where a test holds Windows paths to the same rule. */
export function isStrictlyInside(
  parent: string,
  child: string,
  paths: path.PlatformPath = path
): boolean {
  const relative = paths.relative(parent, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${paths.sep}`) &&
    !paths.isAbsolute(relative)
  );
}

export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
