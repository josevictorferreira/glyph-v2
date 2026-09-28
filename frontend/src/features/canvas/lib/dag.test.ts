import { describe, expect, it } from "vitest";
import { topologicalOrder, wouldCreateCycle, type EdgeLike } from "./dag";

const edges: EdgeLike[] = [
  { source: "a", target: "b" },
  { source: "b", target: "c" },
];

describe("wouldCreateCycle", () => {
  it("allows forward edges in a chain", () => {
    expect(wouldCreateCycle(edges, "a", "c")).toBe(false);
  });

  it("rejects self edges", () => {
    expect(wouldCreateCycle(edges, "a", "a")).toBe(true);
  });

  it("rejects a direct back edge", () => {
    expect(wouldCreateCycle(edges, "c", "a")).toBe(true);
  });

  it("rejects an indirect back edge", () => {
    expect(wouldCreateCycle(edges, "c", "b")).toBe(true);
    expect(wouldCreateCycle(edges, "c", "a")).toBe(true);
  });

  it("allows edges into an unrelated subtree", () => {
    expect(wouldCreateCycle(edges, "x", "a")).toBe(false);
  });

  it("detects a longer cycle through transitivity", () => {
    // b → z exists: a duplicate b → z is not a cycle, but z → b is.
    expect(wouldCreateCycle([{ source: "b", target: "z" }], "b", "z")).toBe(false);
    expect(wouldCreateCycle([{ source: "b", target: "z" }], "z", "b")).toBe(true);
    // a → b, b → z, z → b: adding z → a closes the longer loop a → b → z → a.
    const existing = [
      { source: "b", target: "z" },
      { source: "z", target: "b" },
      { source: "a", target: "b" },
    ];
    expect(wouldCreateCycle(existing, "z", "a")).toBe(true);
  });
});

describe("topologicalOrder", () => {
  it("orders a chain", () => {
    expect(topologicalOrder(["c", "b", "a"], edges)).toEqual(["a", "b", "c"]);
  });

  it("orders ready nodes by input order and dependencies after them", () => {
    // b depends on a; d is independent. a and d start ready (a first: input order).
    expect(topologicalOrder(["b", "a", "d"], edges)).toEqual(["a", "d", "b"]);
  });

  it("ignores edges referencing unknown ids", () => {
    expect(topologicalOrder(["a", "b"], [{ source: "ghost", target: "a" }])).toEqual(["a", "b"]);
  });

  it("falls back to input order on a cycle", () => {
    expect(
      topologicalOrder(
        ["a", "b"],
        [
          { source: "a", target: "b" },
          { source: "b", target: "a" },
        ],
      ),
    ).toEqual(["a", "b"]);
  });
});
