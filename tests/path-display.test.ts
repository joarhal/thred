import path from "node:path";

import { describe, expect, it } from "vitest";

import { toDisplayPath } from "../src/core/util/path-display.js";

describe("path display", () => {
  it("renders project-internal paths as relative", () => {
    const cwd = path.resolve("/tmp", "repo", "project");
    const target = path.join(cwd, "docs", "plans", "a.md");
    expect(toDisplayPath(cwd, target)).toBe(path.join("docs", "plans", "a.md"));
  });

  it("renders cwd itself as dot", () => {
    const cwd = path.resolve("/tmp", "repo", "project");
    expect(toDisplayPath(cwd, cwd)).toBe(".");
  });

  it("keeps external paths absolute", () => {
    const cwd = path.resolve("/tmp", "repo", "project");
    const external = path.resolve("/tmp", "another", "report.json");
    expect(toDisplayPath(cwd, external)).toBe(external);
  });
});
