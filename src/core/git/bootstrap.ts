import { runCommand } from "../util/process.js";

export async function ensureGitWorkspaceReady(cwd: string): Promise<void> {
  await ensureRepositoryExists(cwd);

  const head = await runCommand("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd });
  if (head.code === 0) {
    return;
  }

  if (!isMissingHeadOutput(head.stderr, head.stdout)) {
    throw new Error(
      [
        "failed to verify git HEAD.",
        formatGitOutput("git rev-parse --verify --quiet HEAD", head.stderr, head.stdout)
      ].join("\n")
    );
  }

  await createInitialCommit(cwd);
}

export async function isInsideGitWorkTree(cwd: string): Promise<boolean> {
  const check = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  return check.code === 0 && check.stdout.trim() === "true";
}

async function ensureRepositoryExists(cwd: string): Promise<void> {
  const check = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (check.code === 0 && check.stdout.trim() === "true") {
    return;
  }

  if (isUnrecoverableRepoCheckFailure(check.stderr, check.stdout)) {
    throw new Error(
      [
        "failed to validate git workspace.",
        formatGitOutput("git rev-parse --is-inside-work-tree", check.stderr, check.stdout)
      ].join("\n")
    );
  }

  const init = await runCommand("git", ["init"], { cwd });
  if (init.code !== 0) {
    throw new Error(
      [
        "failed to initialize git repository automatically.",
        formatGitOutput("git init", init.stderr, init.stdout)
      ].join("\n")
    );
  }

  const recheck = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (recheck.code !== 0 || recheck.stdout.trim() !== "true") {
    throw new Error(
      [
        "failed to validate git workspace after initialization.",
        formatGitOutput("git rev-parse --is-inside-work-tree", recheck.stderr, recheck.stdout)
      ].join("\n")
    );
  }
}

async function createInitialCommit(cwd: string): Promise<void> {
  const args = ["commit", "--allow-empty", "--no-verify", "-m", "initial commit"];
  const firstAttempt = await runCommand("git", args, { cwd });
  if (firstAttempt.code === 0) {
    return;
  }

  const combined = `${firstAttempt.stderr}\n${firstAttempt.stdout}`.toLowerCase();
  if (needsCommitIdentityFallback(combined)) {
    const fallbackAttempt = await runCommand("git", args, {
      cwd,
      env: {
        GIT_AUTHOR_NAME: "thred",
        GIT_AUTHOR_EMAIL: "thred@local",
        GIT_COMMITTER_NAME: "thred",
        GIT_COMMITTER_EMAIL: "thred@local"
      }
    });
    if (fallbackAttempt.code === 0) {
      return;
    }

    const fallbackOutput = `${fallbackAttempt.stderr}\n${fallbackAttempt.stdout}`.trim();
    throw new Error(
      [
        "failed to create initial git commit automatically.",
        fallbackOutput ? `git commit output: ${fallbackOutput}` : "git commit returned non-zero exit code."
      ].join("\n")
    );
  }

  const output = `${firstAttempt.stderr}\n${firstAttempt.stdout}`.trim();
  throw new Error(
    [
      "failed to create initial git commit automatically.",
      output ? `git commit output: ${output}` : "git commit returned non-zero exit code."
    ].join("\n")
  );
}

function needsCommitIdentityFallback(output: string): boolean {
  return (
    output.includes("author identity unknown") ||
    output.includes("unable to auto-detect email address") ||
    output.includes("please tell me who you are")
  );
}

function isUnrecoverableRepoCheckFailure(stderr: string, stdout: string): boolean {
  const output = `${stderr}\n${stdout}`.toLowerCase();
  return (
    output.includes("dubious ownership") ||
    output.includes("unsafe repository")
  );
}

function isMissingHeadOutput(stderr: string, stdout: string): boolean {
  const output = `${stderr}\n${stdout}`.toLowerCase().trim();
  if (output === "") {
    return true;
  }
  return (
    output.includes("needed a single revision") ||
    output.includes("unknown revision or path not in the working tree") ||
    output.includes("ambiguous argument 'head'")
  );
}

function formatGitOutput(command: string, stderr: string, stdout: string): string {
  const output = `${stderr}\n${stdout}`.trim();
  if (!output) {
    return `${command} returned non-zero exit code.`;
  }
  return `${command} output: ${output}`;
}
