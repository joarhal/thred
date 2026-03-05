import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import { describe, expect, it } from "vitest";

import {
  buildDefaultReviewPipelineFile,
  loadReviewPipelineConfig,
  writeReviewPipelineFile
} from "../src/core/review/pipeline-config.js";

describe("review pipeline config", () => {
  it("uses built-in defaults when no config files exist", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-review-pipeline-default-"));
    const config = await loadReviewPipelineConfig(cwd, {
      maxReviewIterations: 3,
      maxExternalIterations: 4,
      reviewPatience: 2
    });

    expect(config.source).toBe("default");
    expect(config.passes).toHaveLength(3);
    expect(config.passes[0]?.id).toBe("baseline_scan");
  });

  it("builds balanced default pipeline with expected pass order and limits", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-review-pipeline-release-"));
    const config = await loadReviewPipelineConfig(cwd, {
      maxReviewIterations: 6,
      maxExternalIterations: 9,
      reviewPatience: 4
    });

    expect(config.source).toBe("default");
    expect(config.passes.map((pass) => pass.id)).toEqual([
      "baseline_scan",
      "stabilize",
      "final_gate"
    ]);

    const stabilize = config.passes[1];
    expect(stabilize).toMatchObject({
      id: "stabilize",
      kind: "fix_loop",
      severities: ["critical", "high", "medium", "low"],
      agents: ["implementation", "quality", "testing", "simplification"],
      maxIterations: 9,
      patience: 4
    });

    const baseline = config.passes[0];
    expect(baseline).toMatchObject({
      id: "baseline_scan",
      kind: "scan",
      agents: ["implementation", "quality", "testing", "simplification", "documentation"]
    });

    const finalGate = config.passes[2];
    expect(finalGate).toMatchObject({
      id: "final_gate",
      kind: "scan",
      agents: ["implementation", "quality", "testing", "simplification", "documentation"]
    });
  });

  it("loads reviewPipeline from .thred/settings.yaml when present", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-review-pipeline-local-"));
    await mkdir(path.join(cwd, ".thred"), { recursive: true });
    await writeFile(
      path.join(cwd, ".thred", "settings.yaml"),
      YAML.stringify({
        model: "inherit",
        reasoningEffort: "high",
        reviewPipeline: {
          version: 1,
          passes: {
            local_scan: {
              kind: "scan",
              severities: ["critical", "high", "medium", "low"]
            }
          }
        }
      }),
      "utf8"
    );

    const config = await loadReviewPipelineConfig(cwd, {
      maxReviewIterations: 3,
      maxExternalIterations: 4,
      reviewPatience: 2
    });

    expect(config.source).toBe("local");
    expect(config.passes[0]?.id).toBe("local_scan");
  });

  it("validates fix_loop maxIterations", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-review-pipeline-invalid-"));
    await mkdir(path.join(cwd, ".thred"), { recursive: true });
    await writeFile(
      path.join(cwd, ".thred", "settings.yaml"),
      YAML.stringify({
        model: "inherit",
        reasoningEffort: "high",
        reviewPipeline: {
          version: 1,
          passes: {
            bad_fix_loop: {
              kind: "fix_loop",
              severities: ["critical"],
              patience: 1
            }
          }
        }
      }),
      "utf8"
    );

    await expect(
      loadReviewPipelineConfig(cwd, {
        maxReviewIterations: 3,
        maxExternalIterations: 4,
        reviewPatience: 2
      })
    ).rejects.toThrow(/maxIterations/i);
  });

  it("falls back to legacy .thred/review-pipeline.json when yaml section is absent", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-review-pipeline-legacy-"));
    await mkdir(path.join(cwd, ".thred"), { recursive: true });
    await writeFile(path.join(cwd, ".thred", "settings.yaml"), YAML.stringify({ model: "inherit" }), "utf8");
    await writeFile(
      path.join(cwd, ".thred", "review-pipeline.json"),
      JSON.stringify({
        version: 1,
        passes: [
          {
            id: "legacy_scan",
            kind: "scan",
            severities: ["critical", "high", "medium", "low"]
          }
        ]
      }),
      "utf8"
    );

    const config = await loadReviewPipelineConfig(cwd, {
      maxReviewIterations: 3,
      maxExternalIterations: 4,
      reviewPatience: 2
    });

    expect(config.source).toBe("local");
    expect(config.passes[0]?.id).toBe("legacy_scan");
  });

  it("setup race: writeReviewPipelineFile preserves existing reviewPipeline under concurrent calls", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-review-pipeline-race-existing-"));
    await mkdir(path.join(cwd, ".thred"), { recursive: true });
    await writeFile(
      path.join(cwd, ".thred", "settings.yaml"),
      YAML.stringify({
        model: "inherit",
        reasoningEffort: "high",
        reviewPipeline: {
          version: 1,
          passes: {
            local_scan: {
              kind: "scan",
              severities: ["critical", "high"]
            }
          }
        }
      }),
      "utf8"
    );

    const defaults = buildDefaultReviewPipelineFile({
      maxReviewIterations: 3,
      maxExternalIterations: 4,
      reviewPatience: 2
    });
    await Promise.all([
      writeReviewPipelineFile(cwd, defaults),
      writeReviewPipelineFile(cwd, defaults),
      writeReviewPipelineFile(cwd, defaults),
      writeReviewPipelineFile(cwd, defaults),
      writeReviewPipelineFile(cwd, defaults)
    ]);

    const settings = YAML.parse(await readFile(path.join(cwd, ".thred", "settings.yaml"), "utf8")) as {
      reviewPipeline?: { passes?: Record<string, unknown> };
    };
    expect(Object.keys(settings.reviewPipeline?.passes ?? {})).toEqual(["local_scan"]);
  });

  it("setup race: writeReviewPipelineFile creates reviewPipeline once when absent", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "thred-review-pipeline-race-absent-"));
    await mkdir(path.join(cwd, ".thred"), { recursive: true });
    await writeFile(path.join(cwd, ".thred", "settings.yaml"), YAML.stringify({ model: "inherit" }), "utf8");

    const defaults = buildDefaultReviewPipelineFile({
      maxReviewIterations: 3,
      maxExternalIterations: 4,
      reviewPatience: 2
    });

    await Promise.all([
      writeReviewPipelineFile(cwd, defaults),
      writeReviewPipelineFile(cwd, defaults),
      writeReviewPipelineFile(cwd, defaults),
      writeReviewPipelineFile(cwd, defaults),
      writeReviewPipelineFile(cwd, defaults)
    ]);

    const settings = YAML.parse(await readFile(path.join(cwd, ".thred", "settings.yaml"), "utf8")) as {
      model: string;
      reviewPipeline?: { version?: number; passes?: Record<string, unknown> };
    };
    expect(settings.model).toBe("inherit");
    expect(settings.reviewPipeline?.version).toBe(1);
    expect(Object.keys(settings.reviewPipeline?.passes ?? {})).toHaveLength(3);
  });
});
