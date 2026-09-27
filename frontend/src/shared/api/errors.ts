// One error model for the whole app (spec 0015). Everything that can fail an
// RPC becomes an AppError here; screens never inspect ConnectError directly.
//
// FAILED_PRECONDITION errors carry google.rpc.ErrorInfo{reason, domain,
// metadata} and possibly glyph.v1.ValidationIssues as details. The generated
// code has no ErrorInfo schema (the glyph protos only reference it in
// comments), so its wire bytes are decoded by a small hand-rolled reader.
import { ConnectError, Code } from "@connectrpc/connect";
import { DefinitionErrorsSchema, ValidationIssuesSchema } from "@/gen/glyph/v1/common_pb";
import type { DefinitionError, Issue } from "@/gen/glyph/v1/common_pb";

export type AppError =
  | { kind: "invalid"; message: string; definitionErrors: DefinitionError[] } // INVALID_ARGUMENT (YAML parse → DefinitionErrors)
  | {
      kind: "precondition";
      reason: string;
      message: string;
      metadata: Record<string, string>;
      issues: Issue[];
    } // FAILED_PRECONDITION (ErrorInfo + optional ValidationIssues)
  | { kind: "conflict"; message: string } // ABORTED (stale fingerprint, YAML apply)
  | { kind: "not_found"; message: string }
  | { kind: "unavailable"; message: string } // network / UNAVAILABLE
  | { kind: "internal"; message: string };

/** Decoded google.rpc.ErrorInfo wire bytes (proto3). */
interface ErrorInfoDetail {
  reason: string;
  domain: string;
  metadata: Record<string, string>;
}

function decodeErrorInfo(bytes: Uint8Array): ErrorInfoDetail {
  const info: ErrorInfoDetail = { reason: "", domain: "", metadata: {} };
  let pos = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    while (pos < bytes.length) {
      const b = bytes[pos++]!;
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return value >>> 0;
      shift += 7;
    }
    return value >>> 0;
  };
  const lenDelim = (): Uint8Array => {
    const len = varint();
    const start = pos;
    pos += len;
    return bytes.subarray(start, pos);
  };
  const utf8 = (chunk: Uint8Array): string => new TextDecoder().decode(chunk);
  while (pos < bytes.length) {
    const key = varint();
    const field = key >>> 3;
    const wireType = key & 0x7;
    if (wireType !== 2) break; // all ErrorInfo fields are length-delimited
    const value = lenDelim();
    if (field === 1) info.reason = utf8(value);
    else if (field === 2) info.domain = utf8(value);
    else if (field === 3) {
      // map<string,string> entry: field 1 = key, field 2 = value
      let k = "";
      let v = "";
      let entryPos = 0;
      const readVarint = (buf: Uint8Array): number => {
        let val = 0;
        let shift = 0;
        while (entryPos < buf.length) {
          const b = buf[entryPos++]!;
          val |= (b & 0x7f) << shift;
          if ((b & 0x80) === 0) return val >>> 0;
          shift += 7;
        }
        return val >>> 0;
      };
      while (entryPos < value.length) {
        const entryKey = readVarint(value);
        const entryField = entryKey >>> 3;
        const len = readVarint(value);
        const chunk = value.subarray(entryPos, entryPos + len);
        entryPos += len;
        if (entryField === 1) k = utf8(chunk);
        else if (entryField === 2) v = utf8(chunk);
      }
      info.metadata[k] = v;
    }
  }
  return info;
}

/** Turns any thrown value into the single AppError model. */
export function toAppError(e: unknown): AppError {
  if (e instanceof ConnectError) {
    const definitionErrors = e.findDetails(DefinitionErrorsSchema).flatMap((d) => d.errors);
    const issues = e.findDetails(ValidationIssuesSchema).flatMap((d) => d.issues);
    const errorInfo = e.details.find(
      (d): d is { type: string; value: Uint8Array } =>
        "value" in d && "type" in d && d.type === "google.rpc.ErrorInfo",
    );
    switch (e.code) {
      case Code.InvalidArgument:
        return { kind: "invalid", message: e.rawMessage, definitionErrors };
      case Code.FailedPrecondition:
        if (errorInfo) {
          const info = decodeErrorInfo(errorInfo.value);
          return {
            kind: "precondition",
            reason: info.reason,
            message: e.rawMessage,
            metadata: info.metadata,
            issues,
          };
        }
        return { kind: "precondition", reason: "", message: e.rawMessage, metadata: {}, issues };
      case Code.Aborted:
        return { kind: "conflict", message: e.rawMessage };
      case Code.NotFound:
        return { kind: "not_found", message: e.rawMessage };
      case Code.Unavailable:
      case Code.Canceled:
        return { kind: "unavailable", message: e.rawMessage };
      default:
        return { kind: "internal", message: e.rawMessage };
    }
  }
  if (e instanceof Error && e.message === "Network Error") {
    return { kind: "unavailable", message: "Network error" };
  }
  return { kind: "internal", message: e instanceof Error ? e.message : String(e) };
}

/** Presentation helper: the message a toast should show for unhandled errors. */
export function appErrorToast(err: AppError): string {
  if (err.kind === "internal") return "Something went wrong";
  return err.message;
}
