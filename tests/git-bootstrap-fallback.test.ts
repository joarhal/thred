import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  runCommand: vi.fn()
}));

vi.mock("../src/core/util/process.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/util/process.js")>(
    "../src/core/util/process.js"
  );
  return {
    ...actual,
    runCommand: mocked.runCommand
  };
});

import { ensureGitWorkspaceReady } from "../src/core/git/bootstrap.js";

describe("git bootstrap identity fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses env-based identity fallback when initial commit fails with unknown identity", async () => {
    mocked.runCommand
      .mockResolvedValueOnce({ code: 0, stdout: "true\n", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "fatal: Needed a single revision" })
      .mockResolvedValueOnce({
        code: 128,
        stdout: "",
        stderr: "Author identity unknown\nPlease tell me who you are"
      })
      .mockResolvedValueOnce({ code: 0, stdout: "[main (root-commit) abc123] initial commit", stderr: "" });

    await ensureGitWorkspaceReady("/tmp/work");

    expect(mocked.runCommand).toHaveBeenCalledTimes(4);
    expect(mocked.runCommand).toHaveBeenNthCalledWith(
      4,
      "git",
      ["commit", "--allow-empty", "--no-verify", "-m", "initial commit"],
      {
        cwd: "/tmp/work",
        env: {
          GIT_AUTHOR_NAME: "thred",
          GIT_AUTHOR_EMAIL: "thred@local",
          GIT_COMMITTER_NAME: "thred",
          GIT_COMMITTER_EMAIL: "thred@local"
        }
      }
    );
  });

  it("throws when fallback commit attempt also fails", async () => {
    mocked.runCommand
      .mockResolvedValueOnce({ code: 0, stdout: "true\n", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "fatal: Needed a single revision" })
      .mockResolvedValueOnce({
        code: 128,
        stdout: "",
        stderr: "unable to auto-detect email address"
      })
      .mockResolvedValueOnce({
        code: 128,
        stdout: "",
        stderr: "fatal: unable to create commit"
      });

    await expect(ensureGitWorkspaceReady("/tmp/work")).rejects.toThrow(
      /failed to create initial git commit automatically\.[\s\S]*git commit output: fatal: unable to create commit/
    );
  });

  it("initializes repository when cwd is not already a git repository", async () => {
    mocked.runCommand
      .mockResolvedValueOnce({
        code: 128,
        stdout: "",
        stderr: "fatal: not a git repository"
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "Initialized empty Git repository in /tmp/work/.git/",
        stderr: ""
      })
      .mockResolvedValueOnce({ code: 0, stdout: "true\n", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "fatal: Needed a single revision" })
      .mockResolvedValueOnce({ code: 0, stdout: "[main (root-commit) abc123] initial commit", stderr: "" });

    await ensureGitWorkspaceReady("/tmp/work");

    expect(mocked.runCommand).toHaveBeenCalledTimes(5);
    expect(mocked.runCommand).toHaveBeenNthCalledWith(2, "git", ["init"], { cwd: "/tmp/work" });
  });

  it("initializes repository for non-English non-repository diagnostics", async () => {
    mocked.runCommand
      .mockResolvedValueOnce({
        code: 128,
        stdout: "",
        stderr: "fatal: Ce n'est pas un dépôt git"
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "Initialized empty Git repository in /tmp/work/.git/",
        stderr: ""
      })
      .mockResolvedValueOnce({ code: 0, stdout: "true\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "abc123\n", stderr: "" });

    await ensureGitWorkspaceReady("/tmp/work");

    expect(mocked.runCommand).toHaveBeenCalledTimes(4);
    expect(mocked.runCommand).toHaveBeenNthCalledWith(2, "git", ["init"], { cwd: "/tmp/work" });
  });

  it("throws for unrecoverable git workspace diagnostics", async () => {
    mocked.runCommand.mockResolvedValueOnce({
      code: 128,
      stdout: "",
      stderr: "fatal: detected dubious ownership in repository"
    });

    await expect(ensureGitWorkspaceReady("/tmp/work")).rejects.toThrow(/failed to validate git workspace\./);
    expect(mocked.runCommand).toHaveBeenCalledTimes(1);
  });

  it("throws when automatic git init fails", async () => {
    mocked.runCommand
      .mockResolvedValueOnce({
        code: 128,
        stdout: "",
        stderr: "fatal: not a git repository"
      })
      .mockResolvedValueOnce({
        code: 128,
        stdout: "",
        stderr: "fatal: cannot create directory at .git"
      });

    await expect(ensureGitWorkspaceReady("/tmp/work")).rejects.toThrow(
      /failed to initialize git repository automatically\./
    );
  });

  it("throws when HEAD verification fails for reasons other than missing commit", async () => {
    mocked.runCommand
      .mockResolvedValueOnce({ code: 0, stdout: "true\n", stderr: "" })
      .mockResolvedValueOnce({
        code: 128,
        stdout: "",
        stderr: "fatal: unable to read tree"
      });

    await expect(ensureGitWorkspaceReady("/tmp/work")).rejects.toThrow(
      /failed to verify git HEAD\./
    );
  });
});
