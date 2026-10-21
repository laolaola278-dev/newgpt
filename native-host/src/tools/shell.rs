//! Phase 4 — Controlled workspace shell execution (`shell_exec`).

use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::sandbox::{relative_display, resolve_target_path, resolve_workspace_root};

pub const NAME: &str = "shell_exec";

const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const MAX_STREAM_BYTES: usize = 32 * 1024;

fn read_bounded<R: Read + Send + 'static>(mut stream: R) -> thread::JoinHandle<(String, bool)> {
    thread::spawn(move || {
        let mut buf = Vec::with_capacity(4096);
        let mut chunk = [0u8; 4096];
        let mut truncated = false;

        loop {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let remaining = MAX_STREAM_BYTES.saturating_sub(buf.len());
                    if remaining > 0 {
                        let take = remaining.min(n);
                        buf.extend_from_slice(&chunk[..take]);
                        if take < n {
                            truncated = true;
                        }
                    } else {
                        truncated = true;
                    }
                }
                Err(_) => break,
            }
        }
        (String::from_utf8_lossy(&buf).into_owned(), truncated)
    })
}

pub fn run(params: &Value) -> Result<Value, String> {
    let root = resolve_workspace_root(params)?;
    let command = params
        .get("command")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "missing required non-empty string \"command\"".to_string())?;

    let raw_cwd = params.get("cwd").and_then(Value::as_str).unwrap_or(".");
    let cwd = resolve_target_path(&root, raw_cwd, false)?;
    if !cwd.is_dir() {
        return Err(format!("cwd \"{raw_cwd}\" is not a directory"));
    }

    let timeout_ms = params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(100, MAX_TIMEOUT_MS);

    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };

    cmd.current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let started = Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn command: {e}"))?;

    let stdout_handle = child.stdout.take().map(read_bounded);
    let stderr_handle = child.stderr.take().map(read_bounded);

    let deadline = Duration::from_millis(timeout_ms);
    let mut timed_out = false;
    let exit_code: i32;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code().unwrap_or(-1);
                break;
            }
            Ok(None) => {
                if started.elapsed() >= deadline {
                    timed_out = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    exit_code = -1;
                    break;
                }
                thread::sleep(Duration::from_millis(15));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("error waiting for command: {e}"));
            }
        }
    }

    let (stdout, out_trunc) = stdout_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    let (stderr, err_trunc) = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();

    Ok(json!({
        "cwd": relative_display(&root, &cwd),
        "exitCode": exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "timedOut": timed_out,
        "truncated": out_trunc || err_trunc,
        "durationMs": started.elapsed().as_millis() as u64,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_command_inside_workspace() {
        let ws = std::env::temp_dir().to_string_lossy().into_owned();
        let out = run(&json!({
            "workspaceRoot": ws,
            "command": "echo gptpp_shell_ok"
        }))
        .unwrap();
        assert_eq!(out["exitCode"], 0);
        assert!(out["stdout"].as_str().unwrap().contains("gptpp_shell_ok"));
    }
}
