import { describe, expect, it } from "vitest";

import { createEventFromLegacyLog } from "../src/core/progress/events.js";

describe("progress event inference", () => {
  it("infers codex request metadata from legacy message", () => {
    const event = createEventFromLegacyLog({
      runId: "run-1",
      level: "INFO",
      message: "task 2: codex request 1/2 - implement checklist items for this task"
    });

    expect(event.kind).toBe("codex_request");
    expect(event.actor).toBe("codex");
    expect(event.taskNumber).toBe(2);
    expect(event.attempt).toEqual({ current: 1, total: 2 });
    expect(event.goal).toBe("implement checklist items for this task");
  });

  it("infers phase from PHASE logs", () => {
    const event = createEventFromLegacyLog({
      runId: "run-2",
      level: "PHASE",
      message: "plan"
    });

    expect(event.kind).toBe("phase_start");
    expect(event.phase).toBe("plan");
    expect(event.actor).toBe("system");
  });
});
