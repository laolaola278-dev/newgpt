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
use crate::tools::{echo, fs as fs_tools, git as git_tools, shell};

pub const HOST_NAME: &str = "com.gptpp.native";
pub const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROTOCOL_VERSION: u64 = 1;

pub const CAPABILITIES: &[&str] = &[
    echo::NAME,
    fs_tools::LIST_DIR_NAME,
    fs_tools::READ_FILE_NAME,
    fs_tools::WRITE_FILE_NAME,
    fs_tools::SEARCH_NAME,
    shell::NAME,
    git_tools::STATUS_NAME,
    git_tools::DIFF_NAME,
    git_tools::LOG_NAME,
    git_tools::STAGE_NAME,
    git_tools::COMMIT_NAME,
];

fn require_params(request: &Value) -> Result<&Value, &'static str> {
    request.get("params").ok_or("arguments must be an object")
}

/// Dispatch one parsed request. `Err(())` means "no reply possible"
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

    let run_tool = |f: fn(&Value) -> Result<Value, String>| match require_params(request) {
        Ok(params) => match f(params) {
            Ok(result) => Ok(success_response(&id, result)),
            Err(msg) => Ok(error_response(&id, INVALID_ARGUMENTS, &msg)),
        },
        Err(msg) => Ok(error_response(&id, INVALID_ARGUMENTS, msg)),
    };

    match method {
        "hello" => Ok(handshake(&id, request)),
        "cancel" => Ok(success_response(
            &id,
            json!({ "cancelled": request["params"]["requestId"].is_string() }),
        )),
        m if m == echo::NAME => run_tool(echo::run),
        m if m == fs_tools::LIST_DIR_NAME => run_tool(fs_tools::list_dir),
        m if m == fs_tools::READ_FILE_NAME => run_tool(fs_tools::read_file),
        m if m == fs_tools::WRITE_FILE_NAME => run_tool(fs_tools::write_file),
        m if m == fs_tools::SEARCH_NAME => run_tool(fs_tools::search),
        m if m == shell::NAME => run_tool(shell::run),
        m if m == git_tools::STATUS_NAME => run_tool(git_tools::status),
        m if m == git_tools::DIFF_NAME => run_tool(git_tools::diff),
        m if m == git_tools::LOG_NAME => run_tool(git_tools::log),
        m if m == git_tools::STAGE_NAME => run_tool(git_tools::stage),
        m if m == git_tools::COMMIT_NAME => run_tool(git_tools::commit),
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
                "capabilities": CAPABILITIES,
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
        assert!(res["result"]["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("native_echo")));
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
    fn unknown_methods_get_structured_errors() {
        let res = dispatch(&json!({ "id": "r7", "method": "nonexistent_tool" })).unwrap();
        assert_eq!(res["error"]["code"], UNKNOWN_METHOD);
    }
}
