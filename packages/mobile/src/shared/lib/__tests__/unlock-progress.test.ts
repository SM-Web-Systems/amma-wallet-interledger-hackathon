// Unlocking stretches the passphrase with 150,000 rounds in JavaScript, which
// takes tens of seconds on entry-level phones (seen on a Galaxy A04e). The lock
// screen must say what is happening instead of looking frozen.
import { describe, expect, it } from "vitest";
import { unlockProgressStage } from "../unlock-progress";

describe("unlockProgressStage", () => {
  it("shows nothing extra at first, so fast phones see no flicker", () => {
    expect(unlockProgressStage(0)).toBe("working");
    expect(unlockProgressStage(1_999)).toBe("working");
  });

  it("explains the wait after 2 seconds", () => {
    expect(unlockProgressStage(2_000)).toBe("slow");
    expect(unlockProgressStage(14_999)).toBe("slow");
  });

  it("reassures after 15 seconds that it has not frozen", () => {
    expect(unlockProgressStage(15_000)).toBe("slower");
    expect(unlockProgressStage(120_000)).toBe("slower");
  });
});
