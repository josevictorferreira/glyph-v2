// Delta application (spec 0024). Deltas carry character offsets into the
// published (redacted) assistant text; the client appends only the exact
// continuation and asks for a refetch when it cannot stitch the stream.
export interface ApplyDeltaInput {
  text: string;
  /** Characters of the message the client already has. */
  known: string;
  offset: number;
}
export interface ApplyDeltaResult {
  text: string;
  /** True when a delta could not be stitched: refetch the message. */
  refetch: boolean;
}
export function applyDelta({ text, known, offset }: ApplyDeltaInput): ApplyDeltaResult {
  const end = offset + text.length;
  if (end <= known.length) return { text: known, refetch: false };
  if (offset === known.length) return { text: known + text, refetch: false };
  return { text: known, refetch: true };
}
