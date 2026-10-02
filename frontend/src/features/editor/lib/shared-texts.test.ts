import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { StepKind } from "@/gen/glyph/v1/common_pb";
import { StepSchema, WorkflowSchema } from "@/gen/glyph/v1/workflow_pb";
import {
  renderPreview,
  stepsUsingText,
  suggestTextKey,
  textTokens,
  usedByCount,
} from "./shared-texts";

describe("shared texts (spec 0023)", () => {
  it("lists body tokens trimmed and de-duplicated in order", () => {
    expect(textTokens("Hi {{ who }} {{who}} and {{tone}}")).toEqual(["who", "tone"]);
    expect(textTokens('No tokens, just {"a": 1} braces.')).toEqual([]);
  });

  it("renders only the named vars and leaves the rest verbatim", () => {
    expect(renderPreview("Hi {{who}}, {{tone}}!", { who: "Ada" })).toBe("Hi Ada, {{tone}}!");
    expect(renderPreview("Hi {{ who }}", new Map([["who", "Ada"]]))).toBe("Hi Ada");
    expect(renderPreview("Hi {{who}} and {{who}}", { who: "Ada" })).toBe("Hi Ada and Ada");
    // A value containing a token is left for run time (single pass).
    expect(renderPreview("{{a}}", { a: "{{b}}" })).toBe("{{b}}");
    expect(renderPreview("No tokens here.", { x: "y" })).toBe("No tokens here.");
  });

  it("counts the steps whose fields reference the text", () => {
    const workflow = create(WorkflowSchema, {
      steps: [
        create(StepSchema, {
          id: "s1",
          kind: StepKind.PI,
          promptRef: { textId: "t1", vars: {} },
        }),
        create(StepSchema, {
          id: "s2",
          kind: StepKind.PI,
          contextRef: { textId: "t1", vars: {} },
          expectRef: { textId: "t1", vars: {} },
        }),
        create(StepSchema, { id: "s3", kind: StepKind.PI }),
      ],
    });
    expect(usedByCount(workflow, "t1")).toBe(2);
    expect(stepsUsingText(workflow, "t1").map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(usedByCount(workflow, "missing")).toBe(0);
  });

  it("suggests a key from the step name and field", () => {
    expect(suggestTextKey("Generate — GLM 5.3", "prompt")).toBe("generate_glm_5_3_prompt");
    expect(suggestTextKey("  Judge! ", "context")).toBe("judge_context");
    expect(suggestTextKey("", "expect")).toBe("expect");
  });
});
