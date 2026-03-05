import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerExecuteCommand } from "../src/commands/execute.js";

describe("cli command compatibility", () => {
  it("registers new/setup commands", () => {
    const program = new Command();
    registerExecuteCommand(program);

    const names = program.commands.map((command) => command.name());
    expect(names).toContain("new");
    expect(names).toContain("setup");
  });

  it("exposes model override flag on root and new alias command", () => {
    const program = new Command();
    registerExecuteCommand(program);

    const rootOptions = program.options.map((option) => option.long);
    expect(rootOptions).toContain("--model");

    const newAlias = program.commands.find((command) => command.name() === "new");
    expect(newAlias?.options.map((option) => option.long)).toContain("--model");
  });

  it("restores new command description", () => {
    const program = new Command();
    registerExecuteCommand(program);

    const newAlias = program.commands.find((command) => command.name() === "new");

    expect(newAlias?.description()).toBe("Create and execute a new plan from free-form input");
  });
});
