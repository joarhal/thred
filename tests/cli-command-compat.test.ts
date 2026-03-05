import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerExecuteCommand } from "../src/commands/execute.js";

describe("cli command compatibility", () => {
  it("registers run/new/setup commands", () => {
    const program = new Command();
    registerExecuteCommand(program);

    const names = program.commands.map((command) => command.name());
    expect(names).toContain("run");
    expect(names).toContain("new");
    expect(names).toContain("setup");
  });

  it("exposes model override flag on root and alias commands", () => {
    const program = new Command();
    registerExecuteCommand(program);

    const rootOptions = program.options.map((option) => option.long);
    expect(rootOptions).toContain("--model");

    const run = program.commands.find((command) => command.name() === "run");
    const newAlias = program.commands.find((command) => command.name() === "new");
    expect(run?.options.map((option) => option.long)).toContain("--model");
    expect(newAlias?.options.map((option) => option.long)).toContain("--model");
  });

  it("restores run/new command descriptions", () => {
    const program = new Command();
    registerExecuteCommand(program);

    const run = program.commands.find((command) => command.name() === "run");
    const newAlias = program.commands.find((command) => command.name() === "new");

    expect(run?.description()).toBe("Execute an existing plan");
    expect(newAlias?.description()).toBe("Create and execute a new plan from free-form input");
  });

  it("requires an existing plan path for run command", () => {
    const program = new Command();
    registerExecuteCommand(program);

    const run = program.commands.find((command) => command.name() === "run");
    expect(run?.registeredArguments[0]?.required).toBe(true);
    expect(run?.registeredArguments[0]?.name()).toBe("plan-path");
  });
});
