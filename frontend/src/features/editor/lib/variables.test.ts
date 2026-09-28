import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { StepSchema, WorkflowSchema } from "@/gen/glyph/v1/workflow_pb";
import {
  availableVariables,
  completeToken,
  openTokenAt,
  tokenMatches,
  variableTokens,
} from "./variables";

describe("prompt variables (spec 0018)", () => {
  it("matches the backend token charset and trims names", () => {
    expect(variableTokens("Hi {{ topic }} and {{Depth_2}} and {{topic}}")).toEqual([
      "topic",
      "Depth_2",
    ]);
  });

  it("ignores brace-heavy literals such as JSON", () => {
    expect(variableTokens('Return {{"a": 1}} please')).toEqual([]);
  });

  it("reports positions for highlighting", () => {
    expect(tokenMatches("a {{x}} b")).toEqual([{ name: "x", start: 2, end: 7 }]);
  });

  it("lists step inputs then workflow values, de-duplicated", () => {
    const step = create(StepSchema, { inputs: [{ name: "draft" }, { name: "topic" }] });
    const workflow = create(WorkflowSchema, { inputs: [{ name: "topic" }, { name: "tone" }] });
    expect(availableVariables(step, workflow)).toEqual([
      { name: "draft", source: "input" },
      { name: "topic", source: "input" },
      { name: "tone", source: "value" },
    ]);
  });

  it("detects an open token before the caret", () => {
    expect(openTokenAt("Write {{to", 10)).toEqual({ query: "to", start: 6 });
    expect(openTokenAt("Write {{", 8)).toEqual({ query: "", start: 6 });
    expect(openTokenAt("Write {{topic}} now", 19)).toBeNull();
    expect(openTokenAt("no token", 8)).toBeNull();
  });

  it("completes the open token and swallows typed closing braces", () => {
    expect(completeToken("Write {{to", 6, 10, "topic")).toEqual({
      text: "Write {{topic}}",
      caret: 15,
    });
    expect(completeToken("Write {{to}} now", 6, 10, "topic")).toEqual({
      text: "Write {{topic}} now",
      caret: 15,
    });
  });
});
