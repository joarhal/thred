export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function durationToMs(input: string): number {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error("empty duration");
  }

  const unitToMs: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000
  };

  const partRegex = /(\d+)(ms|s|m|h)/g;
  let total = 0;
  let matchedLen = 0;

  for (const match of trimmed.matchAll(partRegex)) {
    const amount = Number(match[1]);
    const unit = match[2] as keyof typeof unitToMs | undefined;
    if (!unit || unitToMs[unit] === undefined) {
      throw new Error(`invalid duration unit: ${String(unit)}`);
    }
    total += amount * unitToMs[unit];
    matchedLen += match[0].length;
  }

  if (matchedLen !== trimmed.length || total <= 0) {
    throw new Error(`invalid duration: ${input}`);
  }

  return total;
}

export function formatElapsed(startedAt: number): string {
  const ms = Math.max(0, Date.now() - startedAt);
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;

  if (h > 0) {
    return `${h}h${m}m`;
  }
  if (m > 0) {
    return `${m}m${s}s`;
  }
  return `${s}s`;
}
