import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  commandExists: vi.fn(),
  ensureGitWorkspaceReady: vi.fn(),
  ensureThredWorkspace: vi.fn(),
  isInsideGitWorkTree: vi.fn()
}));

vi.mock("../src/core/util/process.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/util/process.js")>(
    "../src/core/util/process.js"
  );
  return {
    ...actual,
    commandExists: mocked.commandExists
  };
});

vi.mock("../src/core/git/bootstrap.js", () => ({
  ensureGitWorkspaceReady: mocked.ensureGitWorkspaceReady,
  isInsideGitWorkTree: mocked.isInsideGitWorkTree
}));

vi.mock("../src/core/artifacts/manager.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/artifacts/manager.js")>(
    "../src/core/artifacts/manager.js"
  );
  return {
    ...actual,
    ensureThredWorkspace: mocked.ensureThredWorkspace
  };
});

import { prepareExecutionBootstrap } from "../src/core/execute/run-plan.js";

describe("prepareExecutionBootstrap ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.commandExists.mockResolvedValue(true);
    mocked.isInsideGitWorkTree.mockResolvedValue(true);
    mocked.ensureGitWorkspaceReady.mockResolvedValue(undefined);
    mocked.ensureThredWorkspace.mockResolvedValue(undefined);
  });

  it("validates git workspace before mutating thred workspace in git mode", async () => {
    const result = await prepareExecutionBootstrap("/tmp/work");

    expect(result.cwd).toBe(path.resolve("/tmp/work"));
    expect(result.isGit).toBe(true);
    expect(mocked.commandExists).toHaveBeenNthCalledWith(1, "codex");
    expect(mocked.commandExists).toHaveBeenNthCalledWith(2, "git");
    expect(mocked.isInsideGitWorkTree).toHaveBeenCalledWith("/tmp/work");
    expect(mocked.ensureGitWorkspaceReady).toHaveBeenCalledWith("/tmp/work");
    expect(mocked.ensureThredWorkspace).toHaveBeenCalledWith("/tmp/work", { updateGitignore: true });
    expect(mocked.ensureGitWorkspaceReady.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.ensureThredWorkspace.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it("does not mutate thred workspace when git validation fails", async () => {
    mocked.ensureGitWorkspaceReady.mockRejectedValueOnce(new Error("git failure"));

    await expect(prepareExecutionBootstrap("/tmp/work")).rejects.toThrow("git failure");
    expect(mocked.ensureThredWorkspace).not.toHaveBeenCalled();
  });

  it("skips git bootstrap when not in git work tree", async () => {
    mocked.isInsideGitWorkTree.mockResolvedValue(false);

    const result = await prepareExecutionBootstrap("/tmp/work");

    expect(result.isGit).toBe(false);
    expect(mocked.ensureGitWorkspaceReady).not.toHaveBeenCalled();
    expect(mocked.ensureThredWorkspace).toHaveBeenCalledWith("/tmp/work", { updateGitignore: false });
  });

  it("skips git checks entirely in --no-git mode", async () => {
    const result = await prepareExecutionBootstrap("/tmp/work", { noGit: true });

    expect(result.isGit).toBe(false);
    expect(mocked.commandExists).toHaveBeenCalledTimes(1);
    expect(mocked.commandExists).toHaveBeenNthCalledWith(1, "codex");
    expect(mocked.isInsideGitWorkTree).not.toHaveBeenCalled();
    expect(mocked.ensureGitWorkspaceReady).not.toHaveBeenCalled();
    expect(mocked.ensureThredWorkspace).toHaveBeenCalledWith("/tmp/work", { updateGitignore: false });
  });
});
