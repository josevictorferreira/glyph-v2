// toAppError (spec 0015): every ConnectError shape maps onto the AppError
// model, including the rich FAILED_PRECONDITION details. ErrorInfo has no
// generated schema, so tests hand-encode its wire bytes.
import { describe, expect, it } from "vitest";
import { ConnectError, Code } from "@connectrpc/connect";
import { create, toBinary } from "@bufbuild/protobuf";
import { DefinitionErrorsSchema, ValidationIssuesSchema, IssueSchema } from "@/gen/glyph/v1/common_pb";
import { toAppError } from "./errors";

type IncomingDetail = { type: string; value: Uint8Array };

function withDetails(err: ConnectError, details: IncomingDetail[]): ConnectError {
  Object.assign(err, { details: [...err.details, ...details] });
  return err;
}

function encodeErrorInfo(info: { reason: string; domain: string; metadata?: Record<string, string> }): Uint8Array {
  const enc = new TextEncoder();
  const parts: number[] = [];
  const field = (no: number, bytes: Uint8Array) => {
    parts.push((no << 3) | 2);
    // varint length (safe for test-sized payloads)
    let len = bytes.length;
    while (len >= 0x80) {
      parts.push((len & 0x7f) | 0x80);
      len >>= 7;
    }
    parts.push(len);
    parts.push(...bytes);
  };
  field(1, enc.encode(info.reason));
  field(2, enc.encode(info.domain));
  for (const [k, v] of Object.entries(info.metadata ?? {})) {
    // map entry submessage: field 1 key, field 2 value
    const entry = new Uint8Array([...[(1 << 3) | 2, k.length], ...enc.encode(k), ...[(2 << 3) | 2, v.length], ...enc.encode(v)]);
    field(3, entry);
  }
  return new Uint8Array(parts);
}

describe("toAppError", () => {
  it("maps INVALID_ARGUMENT with DefinitionErrors", () => {
    const errors = create(DefinitionErrorsSchema, {
      errors: [{ path: "steps[0].prompt", line: 3, message: "is required" }],
    });
    const err = withDetails(new ConnectError("Definition is invalid", Code.InvalidArgument), [
      { type: "glyph.v1.DefinitionErrors", value: toBinary(DefinitionErrorsSchema, errors) },
    ]);
    const app = toAppError(err);
    expect(app.kind).toBe("invalid");
    if (app.kind !== "invalid") return;
    expect(app.message).toBe("Definition is invalid");
    expect(app.definitionErrors).toHaveLength(1);
    expect(app.definitionErrors[0]).toMatchObject({
      path: "steps[0].prompt",
      line: 3,
      message: "is required",
    });
  });

  it("maps FAILED_PRECONDITION with ErrorInfo + ValidationIssues", () => {
    const issues = create(ValidationIssuesSchema, {
      issues: [create(IssueSchema, { entityType: 2, entityId: "step-1", field: "model", message: "no longer available" })],
    });
    const err = withDetails(
      new ConnectError("This workflow cannot run yet", Code.FailedPrecondition),
      [
        { type: "google.rpc.ErrorInfo", value: encodeErrorInfo({ reason: "VALIDATION_FAILED", domain: "glyph", metadata: { existing_source_label: "Prompt" } }) },
        { type: "glyph.v1.ValidationIssues", value: toBinary(ValidationIssuesSchema, issues) },
      ],
    );
    const app = toAppError(err);
    expect(app.kind).toBe("precondition");
    if (app.kind !== "precondition") return;
    expect(app.reason).toBe("VALIDATION_FAILED");
    expect(app.metadata).toEqual({ existing_source_label: "Prompt" });
    expect(app.issues).toHaveLength(1);
    expect(app.issues[0]!.entityId).toBe("step-1");
    expect(app.issues[0]!.field).toBe("model");
  });

  it("maps FAILED_PRECONDITION without ErrorInfo", () => {
    const app = toAppError(new ConnectError("boom", Code.FailedPrecondition));
    expect(app).toEqual({ kind: "precondition", reason: "", message: "boom", metadata: {}, issues: [] });
  });

  it("maps ABORTED to conflict", () => {
    expect(toAppError(new ConnectError("stale fingerprint", Code.Aborted))).toEqual({
      kind: "conflict",
      message: "stale fingerprint",
    });
  });

  it("maps NOT_FOUND", () => {
    expect(toAppError(new ConnectError("no such workflow", Code.NotFound))).toEqual({
      kind: "not_found",
      message: "no such workflow",
    });
  });

  it("maps UNAVAILABLE and Canceled to unavailable", () => {
    expect(toAppError(new ConnectError("conn refused", Code.Unavailable)).kind).toBe("unavailable");
    expect(toAppError(new ConnectError("aborted", Code.Canceled)).kind).toBe("unavailable");
  });

  it("maps anything else to internal with rawMessage", () => {
    expect(toAppError(new ConnectError("kaboom", Code.Unknown))).toEqual({ kind: "internal", message: "kaboom" });
    expect(toAppError(new Error("weird"))).toEqual({ kind: "internal", message: "weird" });
    expect(toAppError("just a string")).toEqual({ kind: "internal", message: "just a string" });
  });
});
