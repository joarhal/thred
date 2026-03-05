import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  loadThredSettings: vi.fn()
}));

vi.mock("../src/core/settings/service.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/settings/service.js")>(
    "../src/core/settings/service.js"
  );
  return {
    ...actual,
    loadThredSettings: mocked.loadThredSettings
  };
});

import { createProgram } from "../src/cli.js";

describe("cli bootstrap side effects", () => {
  it("does not load or write settings for --help", async () => {
    const program = createProgram();
    program.exitOverride();
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {}
    });

    await expect(program.parseAsync(["node", "thred", "--help"], { from: "user" })).rejects.toMatchObject({
      code: "commander.helpDisplayed"
    });
    expect(mocked.loadThredSettings).not.toHaveBeenCalled();
  });

  it("does not load or write settings for --version", async () => {
    const program = createProgram();
    program.exitOverride();
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {}
    });

    await expect(program.parseAsync(["node", "thred", "--version"], { from: "user" })).rejects.toMatchObject({
      code: "commander.version"
    });
    expect(mocked.loadThredSettings).not.toHaveBeenCalled();
  });

  it("does not load settings when commander rejects unknown options", async () => {
    const program = createProgram();
    program.exitOverride();
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {}
    });

    await expect(program.parseAsync(["node", "thred", "--definitely-unknown"], { from: "user" })).rejects.toMatchObject({
      code: "commander.unknownOption"
    });
    expect(mocked.loadThredSettings).not.toHaveBeenCalled();
  });
});
