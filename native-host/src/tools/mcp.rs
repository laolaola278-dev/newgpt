//! Phase 8 — Model Context Protocol (MCP `2024-11-05`) Stdio Client Bridge.
//!
//! Speaks standard newline-delimited JSON-RPC 2.0 over `stdin`/`stdout` with
//! user-allowlisted local MCP servers (`initialize` -> `notifications/initialized`
//! -> `tools/list` or `tools/call`), enforcing strict timeouts and clean child
//! process teardown using pure Rust `std` + `serde_json`.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::sandbox::resolve_workspace_root;

pub const LIST_TOOLS_NAME: &str = "mcp_list_tools";
pub const CALL_TOOL_NAME: &str = "mcp_call_tool";

const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const MAX_TIMEOUT_MS: u64 = 60_000;

struct McpSession {
    child: Child,
    rx: mpsc::Receiver<Result<Value, String>>,
}

impl McpSession {
    fn spawn(command: &str, args: &[String], cwd: Option<PathBuf>) -> Result<Self, String> {
        let mut cmd = Command::new(command);
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn MCP server \"{command}\": {e}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture MCP server stdout".to_string())?;

        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(raw) => {
                        let trimmed = raw.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                            if tx.send(Ok(parsed)).is_err() {
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(format!("MCP stdout read error: {e}")));
                        break;
                    }
                }
            }
        });

        Ok(Self { child, rx })
    }

    fn send_json(&mut self, msg: &Value) -> Result<(), String> {
        let stdin = self
            .child
            .stdin
            .as_mut()
            .ok_or_else(|| "MCP server stdin closed".to_string())?;
        let serialized =
            serde_json::to_string(msg).map_err(|e| format!("JSON serialize error: {e}"))?;
        stdin
            .write_all(serialized.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("failed writing to MCP stdin: {e}"))
    }

    fn request(&mut self, id: u64, method: &str, params: Value, deadline: Instant) -> Result<Value, String> {
        self.send_json(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))?;

        loop {
            let now = Instant::now();
            if now >= deadline {
                return Err(format!("MCP request \"{method}\" timed out"));
            }
            let remaining = deadline.duration_since(now);
            match self.rx.recv_timeout(remaining) {
                Ok(Ok(frame)) => {
                    if frame.get("id").and_then(Value::as_u64) == Some(id) {
                        if let Some(err) = frame.get("error") {
                            return Err(format!("MCP error response: {err}"));
                        }
                        return Ok(frame.get("result").cloned().unwrap_or(Value::Null));
                    }
                    // Ignore server notifications or unrelated frames while awaiting `id`.
                }
                Ok(Err(e)) => return Err(e),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err(format!("MCP request \"{method}\" timed out"));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(format!(
                        "MCP server exited before replying to \"{method}\""
                    ));
                }
            }
        }
    }

    fn handshake(&mut self, deadline: Instant) -> Result<Value, String> {
        let init_result = self.request(
            1,
            "initialize",
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {
                    "name": "gptpp-native",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }),
            deadline,
        )?;
        self.send_json(&json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        }))?;
        Ok(init_result)
    }
}

impl Drop for McpSession {
    fn drop(&mut self) {
        let _ = self.child.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn parse_launch_config(params: &Value) -> Result<(String, Vec<String>, Option<PathBuf>, Instant), String> {
    let command = params
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("\"command\" must be a non-empty string")?
        .to_string();

    let mut args = Vec::new();
    if let Some(arr) = params.get("args").and_then(Value::as_array) {
        for item in arr {
            let s = item
                .as_str()
                .ok_or("every item in \"args\" must be a string")?;
            args.push(s.to_string());
        }
    }

    let cwd = if params.get("workspaceRoot").and_then(Value::as_str).is_some() {
        Some(resolve_workspace_root(params)?)
    } else {
        None
    };

    let timeout_ms = params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(500, MAX_TIMEOUT_MS);

    Ok((
        command,
        args,
        cwd,
        Instant::now() + Duration::from_millis(timeout_ms),
    ))
}

pub fn list_tools(params: &Value) -> Result<Value, String> {
    let (command, args, cwd, deadline) = parse_launch_config(params)?;
    let mut session = McpSession::spawn(&command, &args, cwd)?;
    let server_info = session.handshake(deadline)?;
    let list_result = session.request(2, "tools/list", json!({}), deadline)?;

    Ok(json!({
        "serverInfo": server_info.get("serverInfo").cloned().unwrap_or(Value::Null),
        "tools": list_result.get("tools").cloned().unwrap_or_else(|| json!([])),
    }))
}

pub fn call_tool(params: &Value) -> Result<Value, String> {
    let (command, args, cwd, deadline) = parse_launch_config(params)?;
    let tool_name = params
        .get("toolName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("\"toolName\" must be a non-empty string")?;
    let tool_args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let mut session = McpSession::spawn(&command, &args, cwd)?;
    session.handshake(deadline)?;
    let result = session.request(
        2,
        "tools/call",
        json!({
            "name": tool_name,
            "arguments": tool_args,
        }),
        deadline,
    )?;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn end_to_end_stdio_mcp_handshake_discover_and_call() {
        let mock_server_script = concat!(
            "while IFS= read -r line; do ",
            "case \"$line\" in ",
            "*'\"method\":\"initialize\"'*) echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2024-11-05\",\"serverInfo\":{\"name\":\"mock-mcp\",\"version\":\"1.0.0\"},\"capabilities\":{}}}' ;; ",
            "*'\"method\":\"tools/list\"'*) echo '{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"ping_mcp\",\"description\":\"test\"}]}}' ; exit 0 ;; ",
            "*'\"method\":\"tools/call\"'*) echo '{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"pong-from-mcp\"}]}}' ; exit 0 ;; ",
            "esac; ",
            "done"
        );

        let listed = list_tools(&json!({
            "command": "sh",
            "args": ["-c", mock_server_script]
        }))
        .unwrap();
        assert_eq!(listed["serverInfo"]["name"], "mock-mcp");
        assert_eq!(listed["tools"][0]["name"], "ping_mcp");

        let called = call_tool(&json!({
            "command": "sh",
            "args": ["-c", mock_server_script],
            "toolName": "ping_mcp",
            "arguments": { "msg": "hi" }
        }))
        .unwrap();
        assert_eq!(called["content"][0]["text"], "pong-from-mcp");
    }
}
