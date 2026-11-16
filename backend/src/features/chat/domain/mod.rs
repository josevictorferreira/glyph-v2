//! Chat domain: model, statuses, title derivation, streaming buffer.
pub mod model;
pub mod stream;
#[cfg(test)]
mod tests {
    use super::model::*;
    #[test]
    fn title_from_trims_collapses_and_truncates() {
        assert_eq!(title_from("  hello   world  "), "hello world");
        let long = "a".repeat(80);
        let title = title_from(&long);
        assert_eq!(title.chars().count(), 60);
        assert!(title.ends_with('…'));
        assert_eq!(title_from("   "), "");
    }
    #[test]
    fn tool_call_serde_round_trips() {
        let call = ToolCall {
            name: "update_workflow".into(),
            summary: "Updated Demo".into(),
            is_error: false,
            workflow_id: Some("wf".into()),
            workflow_name: Some("Demo".into()),
            run_id: None,
            detail: None,
            revert: Some(Revert {
                previous_yaml: "name: Demo".into(),
                fingerprint: "abc123".into(),
            }),
            reverted: false,
        };
        let json = serde_json::to_string(&call).unwrap();
        let back: ToolCall = serde_json::from_str(&json).unwrap();
        assert_eq!(back, call);
        assert!(json.contains("previous_yaml"));
    }
    #[test]
    fn revertible_only_for_successful_unreverted_update_workflow_with_yaml() {
        let mut call = ToolCall {
            name: "update_workflow".into(),
            summary: String::new(),
            is_error: false,
            workflow_id: Some("wf".into()),
            workflow_name: None,
            run_id: None,
            detail: None,
            revert: Some(Revert {
                previous_yaml: "name: Demo".into(),
                fingerprint: "abc".into(),
            }),
            reverted: false,
        };
        assert!(call.revertible());
        call.reverted = true;
        assert!(!call.revertible());
        call.reverted = false;
        call.is_error = true;
        assert!(!call.revertible());
        call.is_error = false;
        call.revert = None;
        assert!(!call.revertible());
        call.name = "create_workflow".into();
        assert!(!call.revertible());
    }
    #[test]
    fn blank_message_is_rejected() {
        let err = Message::new_user("   ").unwrap_err();
        assert_eq!(err, "Write a message first.");
        assert!(Message::new_user("hi").is_ok());
    }
}
