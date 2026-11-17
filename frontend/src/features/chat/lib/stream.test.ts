// applyDelta semantics (spec 0024): append when the offset matches the known
// length, ignore deltas ending at or before it, signal a refetch on a gap.
import { describe, expect, it } from "vitest";
import { applyDelta } from "./stream";

describe("applyDelta", () => {
  it("appends when offset equals the known length", () => {
    expect(applyDelta({ text: "world", known: "hello", offset: 5 })).toEqual({
      text: "helloworld",
      refetch: false,
    });
  });

  it("ignores a delta ending at or before the known length", () => {
    expect(applyDelta({ text: "hello", known: "helloworld", offset: 0 })).toEqual({
      text: "helloworld",
      refetch: false,
    });
    expect(applyDelta({ text: "XY", known: "helloworld", offset: 3 })).toEqual({
      text: "helloworld",
      refetch: false,
    });
  });

  it("asks for a refetch on a gap", () => {
    expect(applyDelta({ text: "XY", known: "hello", offset: 9 })).toEqual({
      text: "hello",
      refetch: true,
    });
  });
});
