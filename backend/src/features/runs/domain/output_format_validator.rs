//! Checks final (redacted) agent output against the declared file format
//! (Rails `Execution::OutputFormatValidator`). Violations carry a safe
//! human message only — never the offending content.

use std::io::Cursor;
use std::sync::LazyLock;

use base64::Engine;
use regex::Regex;

use crate::shared::output_format::OutputFileFormat;

pub const ZIP_MAX_DECODED_BYTES: usize = 100 * 1024 * 1024;
pub const ZIP_MAX_ENTRIES: usize = 1_000;
pub const ZIP_MAX_TOTAL_UNCOMPRESSED: u64 = 500 * 1024 * 1024;

const BAD_JSON: &str = "The agent did not produce valid JSON.";
const BAD_HTML: &str = "The agent did not produce a complete HTML document.";
const BAD_ZIP: &str = "The agent did not produce valid base64 ZIP data.";

static FENCE_OPEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^```[A-Za-z0-9_-]*[ \t]*\r?\n?").unwrap());
static HTML_DOCUMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)(<!doctype\s+html[^>]*>.*?</html>|<html[^>]*>.*?</html>)").unwrap()
});

/// Ok(value to store); the value differs from the input only for HTML
/// (the extracted document).
pub fn validate(format: OutputFileFormat, text: &str) -> Result<String, &'static str> {
    match format {
        OutputFileFormat::FreeTextMarkdown => Ok(text.to_string()),
        OutputFileFormat::Json => serde_json::from_str::<serde_json::Value>(text)
            .map(|_| text.to_string())
            .map_err(|_| BAD_JSON),
        OutputFileFormat::Html => extract_html(text).ok_or(BAD_HTML),
        OutputFileFormat::Zip => validate_zip(text).map(|_| text.to_string()),
    }
}

/// Models sometimes wrap a complete document in prose and a markdown fence;
/// extract the document itself. Fragments and prose alone are rejected.
fn extract_html(text: &str) -> Option<String> {
    let mut s = text.trim().to_string();
    if s.contains("```") {
        s = FENCE_OPEN
            .replace_all(&s, "")
            .replace("```", "")
            .trim()
            .to_string();
    }
    HTML_DOCUMENT.find(&s).map(|m| m.as_str().to_string())
}

fn validate_zip(text: &str) -> Result<(), &'static str> {
    if text.is_empty() {
        return Err(BAD_ZIP);
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|_| BAD_ZIP)?;
    if !decoded.starts_with(b"PK\x03\x04") {
        return Err(BAD_ZIP);
    }
    if decoded.len() > ZIP_MAX_DECODED_BYTES {
        return Err("The ZIP archive exceeds the size limit.");
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(decoded)).map_err(|_| BAD_ZIP)?;
    if archive.len() > ZIP_MAX_ENTRIES {
        return Err("The ZIP archive exceeds the entry count limit.");
    }
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let entry = archive.by_index_raw(i).map_err(|_| BAD_ZIP)?;
        total = total.saturating_add(entry.size());
        if total > ZIP_MAX_TOTAL_UNCOMPRESSED {
            return Err("The ZIP archive exceeds the size limit.");
        }
    }
    if archive.is_empty() {
        return Err("The ZIP archive is empty.");
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    pub fn zip_b64(entries: &[(&str, &[u8])]) -> String {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            for (name, bytes) in entries {
                w.start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                w.write_all(bytes).unwrap();
            }
            w.finish().unwrap();
        }
        base64::engine::general_purpose::STANDARD.encode(buf.into_inner())
    }

    #[test]
    fn markdown_always_passes() {
        assert!(validate(OutputFileFormat::FreeTextMarkdown, "anything").is_ok());
        assert!(validate(OutputFileFormat::FreeTextMarkdown, "").is_ok());
    }

    #[test]
    fn json() {
        assert!(validate(OutputFileFormat::Json, r#"{"a":1}"#).is_ok());
        assert!(validate(OutputFileFormat::Json, "[1,2,3]").is_ok());
        assert_eq!(validate(OutputFileFormat::Json, "not json"), Err(BAD_JSON));
    }

    #[test]
    fn html() {
        assert!(
            validate(
                OutputFileFormat::Html,
                "<!doctype html><html><body>Hi</body></html>"
            )
            .is_ok()
        );
        assert!(
            validate(
                OutputFileFormat::Html,
                "<html><head></head><body></body></html>"
            )
            .is_ok()
        );
        let wrapped = "Here is a self-contained HTML document.\n\n```html\n<!doctype html>\n<html><body>Hi</body></html>\n```\n";
        assert_eq!(
            validate(OutputFileFormat::Html, wrapped).unwrap(),
            "<!doctype html>\n<html><body>Hi</body></html>"
        );
        assert_eq!(
            validate(OutputFileFormat::Html, "just some text"),
            Err(BAD_HTML)
        );
        assert_eq!(
            validate(OutputFileFormat::Html, "<div>fragment</div>"),
            Err(BAD_HTML)
        );
    }

    #[test]
    fn zip() {
        assert!(
            validate(
                OutputFileFormat::Zip,
                &zip_b64(&[("file.txt", b"hello world")])
            )
            .is_ok()
        );
        assert_eq!(
            validate(OutputFileFormat::Zip, "not base64!!!"),
            Err(BAD_ZIP)
        );
        let not_zip = base64::engine::general_purpose::STANDARD.encode("just a string");
        assert_eq!(validate(OutputFileFormat::Zip, &not_zip), Err(BAD_ZIP));
        assert_eq!(validate(OutputFileFormat::Zip, ""), Err(BAD_ZIP));
        let truncated = base64::engine::general_purpose::STANDARD.encode(b"PK\x03\x04garbage");
        assert_eq!(validate(OutputFileFormat::Zip, &truncated), Err(BAD_ZIP));
    }

    #[test]
    fn zip_bomb_caps() {
        let many: Vec<(String, Vec<u8>)> = (0..=ZIP_MAX_ENTRIES)
            .map(|i| (format!("f{i}"), Vec::new()))
            .collect();
        let refs: Vec<(&str, &[u8])> = many
            .iter()
            .map(|(n, b)| (n.as_str(), b.as_slice()))
            .collect();
        assert_eq!(
            validate(OutputFileFormat::Zip, &zip_b64(&refs)),
            Err("The ZIP archive exceeds the entry count limit.")
        );

        // A tiny archive whose central directory declares a 2 GiB entry.
        let b64 = zip_b64(&[("big", b"x")]);
        let mut bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        let cd = bytes.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
        bytes[cd + 24..cd + 28].copy_from_slice(&0x7FFF_FFFFu32.to_le_bytes());
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        assert_eq!(
            validate(OutputFileFormat::Zip, &b64),
            Err("The ZIP archive exceeds the size limit.")
        );

        let empty = zip_b64(&[]);
        // An empty archive has no local header; it is rejected as not-a-zip.
        assert!(validate(OutputFileFormat::Zip, &empty).is_err());
    }
}
