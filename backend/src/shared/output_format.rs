use serde::{Deserialize, Serialize};

/// Output file format shared by workflow steps and step runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputFileFormat {
    #[default]
    FreeTextMarkdown,
    Html,
    Json,
    Zip,
}

impl OutputFileFormat {
    pub const ALL: [Self; 4] = [Self::FreeTextMarkdown, Self::Html, Self::Json, Self::Zip];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::FreeTextMarkdown => "free_text_markdown",
            Self::Html => "html",
            Self::Json => "json",
            Self::Zip => "zip",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|f| f.as_str() == raw)
    }

    /// Unknown values fall back to markdown (Rails `save_step_output`).
    pub fn parse_or_default(raw: &str) -> Self {
        Self::parse(raw).unwrap_or_default()
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::FreeTextMarkdown => "Free text Markdown",
            Self::Html => "HTML file",
            Self::Json => "JSON file",
            Self::Zip => "ZIP archive",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::FreeTextMarkdown => "md",
            Self::Html => "html",
            Self::Json => "json",
            Self::Zip => "zip",
        }
    }

    pub fn mime_type(self) -> &'static str {
        match self {
            Self::FreeTextMarkdown => "text/markdown; charset=utf-8",
            Self::Html => "text/html; charset=utf-8",
            Self::Json => "application/json; charset=utf-8",
            Self::Zip => "application/zip",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table() {
        assert_eq!(
            OutputFileFormat::parse("html"),
            Some(OutputFileFormat::Html)
        );
        assert_eq!(
            OutputFileFormat::parse_or_default("pdf"),
            OutputFileFormat::FreeTextMarkdown
        );
        assert_eq!(OutputFileFormat::Zip.mime_type(), "application/zip");
        assert_eq!(OutputFileFormat::FreeTextMarkdown.extension(), "md");
        assert_eq!(OutputFileFormat::Json.label(), "JSON file");
    }
}
