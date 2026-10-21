//! Request dispatch on the GPT++ RPC envelope.
//!
//! Every request must carry: string `id`, string `method`, optional object
//! `params`. Anything else is rejected before a tool ever runs. The host
//! trusts nothing — the extension's permission layer is necessary but not
//! sufficient.

use serde_json::{json, Value};

use crate::errors::{
    error_response, success_response, INVALID_ARGUMENTS, PROTOCOL_VERSION_MISMATCH,
    UNKNOWN_METHOD,
};
use crate::tools::echo;

pub const HOST_NAME: &str = "com.gptpp.native";
pub const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROTOCOL_VERSION: u64 = 1;

/// Dispatch one parsed request. `Ok(None)` means "no reply possible"
/// (e.g. missing id) — the caller must not write anything.
pub fn dispatch(request: &Value) -> Result<Value, ()> {
    let id = match request.get("id") {
        Some(v) if v.is_string() => v.clone(),
        _ => {
            eprintln!("[gptpp-native] dropping request without string id");
            return Err(());
        }
    };
    let method = match request.get("method").and_then(Value::as_str) {
        Some(m) if !m.is_empty() => m,
        _ => {
            return Ok(error_response(
                &id,
                INVALID_ARGUMENTS,
                "request requires a non-empty string \"method\"",
            ))
        }
    };

    match method {
        "hello" => Ok(handshake(&id, request)),
        "cancel" => Ok(success_response(
            &id,
            json!({ "cancelled": request["params"]["requestId"].is_string() }),
        )),
        m if m == echo::NAME => match request.get("params") {
            Some(params) => match echo::run(params) {
                Ok(result) => Ok(success_response(&id, result)),
                Err(msg) => Ok(error_response(&id, INVALID_ARGUMENTS, &msg)),
            },
            None => Ok(error_response(
                &id,
                INVALID_ARGUMENTS,
                "arguments must be an object",
            )),
        },
        other => Ok(error_response(
            &id,
            UNKNOWN_METHOD,
            &format!("Unknown GPT++ native method: {other}"),
        )),
    }
}

fn handshake(id: &Value, request: &Value) -> Value {
    let requested = request["params"]["protocolVersion"].as_u64();
    match requested {
        Some(v) if v != PROTOCOL_VERSION => error_response(
            id,
            PROTOCOL_VERSION_MISMATCH,
            &format!(
                "extension speaks protocol v{v}, host supports v{PROTOCOL_VERSION}"
            ),
        ),
        _ => success_response(
            id,
            json!({
                "name": HOST_NAME,
                "version": HOST_VERSION,
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": [echo::NAME],
            }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn handshake_returns_capabilities() {
        let res = dispatch(&json!({
            "id": "r1",
            "method": "hello",
            "params": { "protocolVersion": 1 }
        }))
        .unwrap();
        assert_eq!(res["ok"], true);
        assert_eq!(res["result"]["name"], HOST_NAME);
        assert_eq!(res["result"]["protocolVersion"], 1);
        assert_eq!(res["result"]["capabilities"], json!(["native_echo"]));
        assert!(res["result"]["version"].is_string());
    }

    #[test]
    fn handshake_rejects_future_protocol_versions() {
        let res = dispatch(&json!({
            "id": "r2",
            "method": "hello",
            "params": { "protocolVersion": 99 }
        }))
        .unwrap();
        assert_eq!(res["error"]["code"], PROTOCOL_VERSION_MISMATCH);
    }

    #[test]
    fn native_echo_round_trip() {
        let res = dispatch(&json!({
            "id": "r3",
            "method": "native_echo",
            "params": { "text": "ping" }
        }))
        .unwrap();
        assert_eq!(res["ok"], true);
        assert_eq!(res["result"], json!({ "text": "ping", "host": "gptpp-native" }));
    }

    #[test]
    fn native_echo_validates_arguments() {
        let res = dispatch(&json!({ "id": "r5", "method": "native_echo", "params": {} })).unwrap();
        assert_eq!(res["error"]["code"], INVALID_ARGUMENTS);
        let res = dispatch(&json!({
            "id": "r6", "method": "native_echo", "params": { "text": 9 }
        }))
        .unwrap();
        assert_eq!(res["error"]["code"], INVALID_ARGUMENTS);
    }

    #[test]
    fn unknown_methods_get_structured_errors() {
        let res = dispatch(&json!({ "id": "r7", "method": "read_file" })).unwrap();
        assert_eq!(res["error"]["code"], UNKNOWN_METHOD);
        assert!(res["error"]["message"].as_str().unwrap().contains("read_file"));
    }

    #[test]
    fn requests_without_id_are_dropped_silently() {
        assert!(dispatch(&json!({ "method": "hello" })).is_err());
    }

    #[test]
    fn malformed_envelope_gets_invalid_arguments() {
        let res = dispatch(&json!({ "id": "r8" })).unwrap();
        assert_eq!(res["error"]["code"], INVALID_ARGUMENTS);
    }

    #[test]
    fn multiple_requests_keep_ids_straight() {
        let a = dispatch(&json!({ "id": "a", "method": "native_echo", "params": { "text": "1" } }))
            .unwrap();
        let b = dispatch(&json!({ "id": "b", "method": "native_echo", "params": { "text": "2" } }))
            .unwrap();
        assert_eq!(a["id"], "a");
        assert_eq!(b["id"], "b");
        assert_eq!(a["result"]["text"], "1");
        assert_eq!(b["result"]["text"], "2");
    }
}
