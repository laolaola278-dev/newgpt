//! Phase 6 — Native Git Inspection, Diff Analysis & Commit Helper Tools.
//!
//! Invokes `git` directly via `std::process::Command` with discrete `argv`
//! vectors (zero shell interpolation), working directory pinned to the
//! canonicalized workspace root, and path arguments separated after `--`.

use std::path::Path;
use std::process::Command;

use serde_json::{json, Value};

use crate::sandbox::{relative_display, resolve_target_path, resolve_workspace_root};

pub const STATUS_NAME: &str = "git_status";
pub const DIFF_NAME: &str = "git_diff";
pub const LOG_NAME: &str = "git_log";
pub const STAGE_NAME: &str = "git_stage";
pub const COMMIT_NAME: &str = "git_commit";

const MAX_DIFF_CHARS: usize = 65_536;

fn run_git(root: &Path, args: &[String]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if !output.status.success() {
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(format!("git command failed: {detail}"));
    }

    Ok(stdout)
}

pub fn status(params: &Value) -> Result<Value, String> {
    let root = resolve_workspace_root(params)?;
    let raw = run_git(
        &root,
        &[
            "status".into(),
            "--porcelain=v1".into(),
            "--branch".into(),
        ],
    )?;

    let mut branch = String::from("HEAD");
    let mut files = Vec::new();

    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            branch = rest.split("...").next().unwrap_or(rest).trim().to_string();
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let status_code = line[..2].to_string();
        let file_path = line[3..].trim().to_string();
        files.push(json!({
            "status": status_code,
            "path": file_path,
        }));
    }

    Ok(json!({
        "branch": branch,
        "clean": files.is_empty(),
        "files": files,
    }))
}

pub fn diff(params: &Value) -> Result<Value, String> {
    let root = resolve_workspace_root(params)?;
    let staged = params.get("staged").and_then(Value::as_bool).unwrap_or(false);
    let context = params
        .get("contextLines")
        .and_then(Value::as_u64)
        .unwrap_or(3)
        .min(20);

    let mut args = vec![
        "diff".to_string(),
        "--no-ext-diff".to_string(),
        "--no-color".to_string(),
        format!("-U{context}"),
    ];
    if staged {
        args.push("--staged".to_string());
    }

    if let Some(p) = params.get("path").and_then(Value::as_str) {
        if !p.trim().is_empty() {
            let target = resolve_target_path(&root, p, true)?;
            let rel = relative_display(&root, &target);
            args.push("--".to_string());
            args.push(rel);
        }
    }

    let raw = run_git(&root, &args)?;
    let total_chars = raw.chars().count();
    let truncated = total_chars > MAX_DIFF_CHARS;
    let diff_text: String = if truncated {
        raw.chars().take(MAX_DIFF_CHARS).collect()
    } else {
        raw
    };

    Ok(json!({
        "staged": staged,
        "truncated": truncated,
        "diff": diff_text,
    }))
}

pub fn log(params: &Value) -> Result<Value, String> {
    let root = resolve_workspace_root(params)?;
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(10)
        .clamp(1, 50);

    let raw = run_git(
        &root,
        &[
            "log".into(),
            format!("-n{limit}"),
            "--date=iso-strict".into(),
            "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e".into(),
        ],
    )?;

    let mut commits = Vec::new();
    for record in raw.split('\x1e') {
        let trimmed = record.trim();
        if trimmed.is_empty() {
            continue;
        }
        let fields: Vec<&str> = trimmed.split('\x1f').collect();
        if fields.len() >= 5 {
            commits.push(json!({
                "hash": fields[0],
                "shortHash": fields[1],
                "author": fields[2],
                "date": fields[3],
                "subject": fields[4],
            }));
        }
    }

    Ok(json!({ "commits": commits }))
}

pub fn stage(params: &Value) -> Result<Value, String> {
    let root = resolve_workspace_root(params)?;
    let arr = params
        .get("paths")
        .and_then(Value::as_array)
        .ok_or("\"paths\" must be a non-empty array of strings")?;
    if arr.is_empty() {
        return Err("\"paths\" must contain at least one path".into());
    }

    let mut staged_paths = Vec::with_capacity(arr.len());
    for item in arr {
        let raw_path = item
            .as_str()
            .ok_or("every item in \"paths\" must be a string")?;
        let target = resolve_target_path(&root, raw_path, true)?;
        staged_paths.push(relative_display(&root, &target));
    }

    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(staged_paths.clone());
    run_git(&root, &args)?;

    Ok(json!({
        "staged": staged_paths,
        "count": staged_paths.len(),
    }))
}

pub fn commit(params: &Value) -> Result<Value, String> {
    let root = resolve_workspace_root(params)?;
    let message = params
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("\"message\" must be a non-empty commit message string")?;

    let output = run_git(&root, &["commit".into(), "-m".into(), message.into()])?;
    let head = run_git(&root, &["rev-parse".into(), "--short".into(), "HEAD".into()])
        .unwrap_or_default()
        .trim()
        .to_string();

    Ok(json!({
        "commit": head,
        "message": message,
        "summary": output.trim(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn full_git_lifecycle_inside_confined_workspace() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("gptpp_git_test_{nanos}"));
        fs::create_dir_all(&dir).unwrap();

        run_git(&dir, &["init".into()]).unwrap();
        run_git(&dir, &["config".into(), "user.email".into(), "test@gptpp.local".into()]).unwrap();
        run_git(&dir, &["config".into(), "user.name".into(), "GPT++ Test".into()]).unwrap();

        fs::write(dir.join("hello.txt"), "line 1\n").unwrap();
        let ws = dir.to_string_lossy().into_owned();

        let st1 = status(&json!({ "workspaceRoot": ws })).unwrap();
        assert_eq!(st1["clean"], false);

        let stg = stage(&json!({
            "workspaceRoot": ws,
            "paths": ["hello.txt"]
        }))
        .unwrap();
        assert_eq!(stg["count"], 1);

        let df = diff(&json!({
            "workspaceRoot": ws,
            "staged": true,
            "path": "hello.txt"
        }))
        .unwrap();
        assert!(df["diff"].as_str().unwrap().contains("+line 1"));

        let cm = commit(&json!({
            "workspaceRoot": ws,
            "message": "feat: initial test commit"
        }))
        .unwrap();
        assert!(!cm["commit"].as_str().unwrap().is_empty());

        let lg = log(&json!({ "workspaceRoot": ws, "limit": 5 })).unwrap();
        assert_eq!(lg["commits"][0]["subject"], "feat: initial test commit");

        let _ = fs::remove_dir_all(&dir);
    }
}
