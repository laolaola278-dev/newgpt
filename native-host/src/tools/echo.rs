//! native_echo — the first native capability.
//!
//! Purpose: prove the real Chrome Extension → Native Messaging → Rust →
//! Extension link with zero side effects. Strict argument validation here is
//! the template every future capability (fs/shell/git) must follow.

use serde_json::{json, Value};

pub const NAME: &str = "native_echo";

/// `{"text": "..."}` → `{"text": "...", "host": "gptpp-native"}`
/// Returns Err(message) when arguments are invalid.
pub fn run(args: &Value) -> Result<Value, String> {
    let obj = args.as_object().ok_or("arguments must be an object")?;
    let text = obj
        .get("text")
        .ok_or("missing required argument \"text\"")?
        .as_str()
        .ok_or("argument \"text\" must be a string")?;
    for key in obj.keys() {
        if key != "text" {
            return Err(format!("unexpected argument \"{key}\""));
        }
    }
    Ok(json!({ "text": text, "host": "gptpp-native" }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn echoes_text_with_host_marker() {
        let out = run(&json!({ "text": "hello" })).unwrap();
        assert_eq!(out, json!({ "text": "hello", "host": "gptpp-native" }));
    }

    #[test]
    fn rejects_missing_wrong_typed_and_extra_arguments() {
        assert!(run(&json!({})).is_err());
        assert!(run(&json!({ "text": 42 })).is_err());
        assert!(run(&json!({ "text": "a", "extra": true })).is_err());
        assert!(run(&json!("not-an-object")).is_err());
    }

    #[test]
    fn accepts_empty_string() {
        assert_eq!(
            run(&json!({ "text": "" })).unwrap(),
            json!({ "text": "", "host": "gptpp-native" })
        );
    }
}
