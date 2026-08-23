//! Structured error responses on the GPT++ RPC envelope.

use serde_json::{json, Value};

pub const UNKNOWN_METHOD: &str = "UNKNOWN_METHOD";
pub const INVALID_ARGUMENTS: &str = "INVALID_ARGUMENTS";
pub const PROTOCOL_VERSION_MISMATCH: &str = "PROTOCOL_VERSION_MISMATCH";

/// `{ "id": ..., "ok": false, "error": { code, message } }`
pub fn error_response(id: &Value, code: &str, message: &str) -> Value {
    json!({
        "id": id,
        "ok": false,
        "error": { "code": code, "message": message }
    })
}

/// `{ "id": ..., "ok": true, "result": ... }`
pub fn success_response(id: &Value, result: Value) -> Value {
    json!({
        "id": id,
        "ok": true,
        "result": result
    })
}
