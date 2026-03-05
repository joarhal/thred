import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { isCliEntrypoint } from "../src/cli.js";

describe("cli entrypoint detection", () => {
  it("returns false when argv entry is missing", () => {
    expect(isCliEntrypoint(undefined, import.meta.url)).toBe(false);
  });

  it("treats symlinked argv path as entrypoint", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "thred-cli-entrypoint-"));
    const targetPath = path.join(tempDir, "cli.js");
    const symlinkPath = path.join(tempDir, "thred-cli-link");

    await writeFile(targetPath, "#!/usr/bin/env node\n");
    await symlink(targetPath, symlinkPath);

    expect(isCliEntrypoint(symlinkPath, pathToFileURL(targetPath).href)).toBe(true);
  });
});
