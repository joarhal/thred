import path from "node:path";

export function toDisplayPath(cwd: string, targetPath: string): string {
  const absoluteCwd = path.resolve(cwd);
  const absoluteTarget = path.resolve(targetPath);
  const relative = path.relative(absoluteCwd, absoluteTarget);

  if (!relative || relative === ".") {
    return ".";
  }

  // Keep external paths absolute to avoid confusing `../../..` output.
  if (relative.startsWith("..")) {
    return absoluteTarget;
  }

  return relative;
}
