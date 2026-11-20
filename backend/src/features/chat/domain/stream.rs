//! `StreamBuffer`: incremental redaction for streaming agent text (spec
//! 0024). Secret shapes (an `sk-…` token, `Bearer …`, literal secret values)
//! can straddle chunk boundaries, and the token patterns have no fixed
//! length. The buffer therefore redacts the accumulated text on every push
//! and publishes only a prefix that later text cannot change: it holds back
//! `longest secret length − 1` characters plus the trailing (possibly
//! partial) word, where an incomplete secret or token can only live — an
//! incomplete token is always the trailing word, since token shapes contain
//! no whitespace. `finish` flushes the remainder. Invariant: for every way
//! of chunking a text, the published deltas concatenate to `redact(whole)`.
//!
//! Offsets count characters (Unicode scalar values), matching the frontend's
//! string indices and `ChatMessage.length`.

use crate::shared::redactor::Redactor;

/// Minimum hold-back when there are no known secrets: token shapes have no
/// fixed length, so a short tail can still grow into one (the trailing-word
/// rule does most of this work; this covers `Bearer ` prefixes).
const BASE_HOLD: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delta {
    /// Character offset into the final redacted text.
    pub offset: usize,
    pub text: String,
}

pub struct StreamBuffer {
    redactor: Redactor,
    /// The full raw text fed so far.
    raw: String,
    /// Redacted text already published (a prefix of `redact(raw)`).
    published: String,
}

impl StreamBuffer {
    pub fn new(redactor: Redactor) -> Self {
        Self {
            redactor,
            raw: String::new(),
            published: String::new(),
        }
    }

    /// Characters already published.
    pub fn published_len(&self) -> usize {
        self.published.chars().count()
    }

    /// The full redacted text published so far.
    pub fn published(&self) -> &str {
        &self.published
    }
    /// The redactor this buffer holds back with (a new segment reuses it).
    pub fn redactor(&self) -> &Redactor {
        &self.redactor
    }

    /// Feed one raw chunk; returns the (possibly empty) safe-to-publish delta.
    pub fn push(&mut self, chunk: &str) -> Option<Delta> {
        self.raw.push_str(chunk);
        let candidate = self.redactor.redact(&self.raw);
        let total = candidate.chars().count();
        let hold = self
            .redactor
            .longest_secret()
            .saturating_sub(1)
            .max(BASE_HOLD);
        let mut safe = total.saturating_sub(hold);
        if safe == 0 {
            return None;
        }
        // Never publish a partial trailing word: that is where an incomplete
        // token or secret fragment lives.
        let prefix: String = candidate.chars().take(safe).collect();
        let ws = prefix.rfind(|c: char| c.is_whitespace())?;
        safe = ws + 1;
        let already = self.published.chars().count();
        if safe <= already {
            return None;
        }
        let new_text: String = candidate.chars().take(safe).collect();
        let delta: String = new_text.chars().skip(already).collect();
        self.published = new_text;
        Some(Delta {
            offset: already,
            text: delta,
        })
    }

    /// The turn is over: redact everything left and flush the tail.
    pub fn finish(&mut self) -> Option<Delta> {
        let final_text = self.redactor.redact(&self.raw);
        let offset = self.published.chars().count();
        if final_text.chars().count() <= offset {
            return None;
        }
        let tail: String = final_text.chars().skip(offset).collect();
        self.published = final_text;
        Some(Delta { offset, text: tail })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "super-secret-test-key-123";

    fn buffer() -> StreamBuffer {
        StreamBuffer::new(Redactor::new([SECRET.to_string()]))
    }

    fn whole() -> String {
        let text =
            format!("the key is {SECRET} and sk-abc123def456ghi789 plus Bearer eyJtoken123456789");
        Redactor::new([SECRET.to_string()]).redact(&text)
    }

    /// Every two- and three-chunk split of the raw text must yield deltas
    /// that concatenate exactly to `redact(whole)`, with contiguous offsets.
    #[test]
    fn every_split_concatenates_to_the_whole_redaction() {
        let raw =
            format!("the key is {SECRET} and sk-abc123def456ghi789 plus Bearer eyJtoken123456789");
        for parts in [2usize, 3] {
            for i in 1..raw.len() {
                let chunks: Vec<&str> = if parts == 2 {
                    vec![&raw[..i], &raw[i..]]
                } else {
                    let (a, rest) = raw.split_at(i);
                    let mid = rest.len() / 2;
                    vec![a, &rest[..mid], &rest[mid..]]
                };
                let mut b = buffer();
                let mut all = String::new();
                let mut expected_offset = 0usize;
                for chunk in &chunks {
                    if let Some(d) = b.push(chunk) {
                        assert_eq!(d.offset, expected_offset, "contiguous offsets");
                        all.push_str(&d.text);
                        expected_offset += d.text.chars().count();
                    }
                }
                if let Some(d) = b.finish() {
                    assert_eq!(d.offset, expected_offset, "contiguous offsets at finish");
                    all.push_str(&d.text);
                }
                assert_eq!(all, whole(), "chunks: {chunks:?}");
            }
        }
    }

    #[test]
    fn no_delta_contains_a_secret_fragment() {
        let raw = format!("leak {SECRET} now");
        for i in 1..raw.len() {
            let mut b = buffer();
            let mut seen = String::new();
            if let Some(d) = b.push(&raw[..i]) {
                seen.push_str(&d.text);
            }
            if let Some(d) = b.push(&raw[i..]) {
                seen.push_str(&d.text);
            }
            if let Some(d) = b.finish() {
                seen.push_str(&d.text);
            }
            assert!(!seen.contains("super-secret"), "raw prefix leaked");
            assert!(!seen.contains("sk-abc123def456"), "token fragment leaked");
        }
    }

    #[test]
    fn plain_prose_publishes_up_to_the_last_word_boundary() {
        let mut b = StreamBuffer::new(Redactor::default());
        let d = b.push("hello world this is fine").unwrap();
        // The hold-back keeps the trailing word; what is published ends on a
        // word boundary.
        assert_eq!(d.text, "hello world ");
        let d2 = b.push(" and more words arrive now").unwrap();
        assert_eq!(d2.offset, d.offset + d.text.chars().count());
    }

    #[test]
    fn finish_flushes_the_tail() {
        let mut b = StreamBuffer::new(Redactor::default());
        b.push("the quick brown fox");
        let d = b.finish().unwrap();
        assert_eq!(b.published(), "the quick brown fox");
        assert!(d.text.contains("fox"));
        assert!(b.finish().is_none(), "second finish flushes nothing");
    }

    #[test]
    fn offsets_count_characters_not_bytes() {
        let mut b = StreamBuffer::new(Redactor::default());
        let d1 = b.push("héllo wörld 你好 something longer arrives").unwrap();
        assert_eq!(d1.offset, 0);
        let count = d1.text.chars().count();
        let d2 = b.push(" and still more words to publish").unwrap();
        assert_eq!(d2.offset, count, "offset counts characters");
    }
}
