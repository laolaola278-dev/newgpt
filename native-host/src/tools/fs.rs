//! Phase 4 — Workspace-confined filesystem tools.

use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use crate::sandbox::{relative_display, resolve_target_path, resolve_workspace_root};

pub const LIST_DIR_NAME: &str = "fs_list_dir";
pub const READ_FILE_NAME: &str = "fs_read_file";
pub const WRITE_FILE_NAME: &str = "fs_write_file";
pub const SEARCH_NAME: &str = "fs_search";

const MAX_READ_BYTES: u64 = 128 * 1024;
const MAX_SEARCH_FILE_BYTES: u64 = 512 * 1024;
const IGNORED_DIRS: &[&str] = &[".git", "node_modules", "target", ".output", ".wxt", "dist"];

pub fn list_dir(params: &Value) -> Result<Value, String> {
    let root = resolve_workspace_root(params)?;
    let raw_path = params.get("path").and_then(Value::as_str).unwrap_or(".");
    let max_entries = params
        .get("maxEntries")
        .and_then(Value::as_u64)
        .unwrap_or(200)
        .clamp(1, 1000) as usize;

    let target = resolve_target_path(&root, raw_path, false)?;
    if !target.is_dir() {
        return Err(format!("not a directory: \"{raw_path}\""));
    }

    let mut entries = Vec::new();
    let mut truncated = false;

    let read = fs::read_dir(&target)
        .map_err(|e| format!("failed to read directory \"{raw_path}\": {e}"))?;

    let mut collected: Vec<_> = read.filter_map(Result::ok).collect();
    collected.sort_by_key(|e| e.file_name());

    for entry in collected {
        if entries.len() >= max_entries {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = fs::symlink_metadata(entry.path());
        let (kind, size) = match meta {
            Ok(m) if m.file_type().is_symlink() => ("symlink", m.len()),
            Ok(m) if m.is_dir() => ("dir", 0),
            Ok(m) => ("file", m.len()),
            Err(_) => ("unknown", 0),
        };
        entries.push(json!({
            "name": name,
            "kind": kind,
            "size": size,
        }));
    }

    Ok(json!({
        "path": relative_display(&root, &target),
        "entries": entries,
        "truncated": truncated,
    }))
}

pub fn read_file(params: &Value) -> Result<Value, String> {
    let root = resolve_workspace_root(params)?;
    let raw_path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing required string \"path\"".to_string())?;

    let target = resolve_target_path(&root, raw_path, false)?;
    if !target.is_file() {
        return Err(format!("not a regular file: \"{raw_path}\""));
    }

    let meta = fs::metadata(&target)
        .map_err(|e| format!("cannot stat \"{raw_path}\": {e}"))?;
    let bytes = fs::read(&target)
        .map_err(|e| format!("cannot read \"{raw_path}\": {e}"))?;

    let truncated_bytes = meta.len() > MAX_READ_BYTES;
    let slice = if bytes.len() > MAX_READ_BYTES as usize {
        &bytes[..MAX_READ_BYTES as usize]
    } else {
        &bytes[..]
    };

    if slice.contains(&0) {
        return Err(format!("\"{raw_path}\" appears to be a binary file"));
    }

    let content = String::from_utf8(slice.to_vec())
        .map_err(|_| format!("\"{raw_path}\" is not valid UTF-8 text"))?;

    let offset = params
        .get("offset")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1) as usize;
    let limit = params.get("limit").and_then(Value::as_u64).map(|n| n as usize);

    let all_lines: Vec<&str> = content.lines().collect();
    let total_lines = all_lines.len();
    let start = (offset - 1).min(total_lines);
    let end = match limit {
        Some(lim) => (start + lim).min(total_lines),
        None => total_lines,
    };

    Ok(json!({
        "path": relative_display(&root, &target),
        "content": all_lines[start..end].join("\n"),
        "totalLines": total_lines,
        "startLine": if total_lines == 0 { 0 } else { start + 1 },
        "endLine": end,
        "truncated": truncated_bytes || end < total_lines,
    }))
}

pub fn write_file(params: &Value) -> Result<Value, String> {
    let root = resolve_workspace_root(params)?;
    let raw_path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing required string \"path\"".to_string())?;
    let content = params
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing required string \"content\"".to_string())?;

    let target = resolve_target_path(&root, raw_path, true)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create parent directory: {e}"))?;
        let canon_parent = fs::canonicalize(parent)
            .map_err(|e| format!("cannot verify parent directory: {e}"))?;
        if !canon_parent.starts_with(&root) {
            return Err("access denied: parent directory escapes workspace root".to_string());
        }
    }

    fs::write(&target, content.as_bytes())
        .map_err(|e| format!("failed writing \"{raw_path}\": {e}"))?;

    Ok(json!({
        "path": relative_display(&root, &target),
        "bytesWritten": content.len(),
    }))
}

pub fn search(params: &Value) -> Result<Value, String> {
    let root = resolve_workspace_root(params)?;
    let query = params
        .get("query")
        .and_then(Value::as_str)
        .filter(|q| !q.is_empty())
        .ok_or_else(|| "missing required non-empty string \"query\"".to_string())?;
    let sub_raw = params.get("path").and_then(Value::as_str).unwrap_or(".");
    let max_results = params
        .get("maxResults")
        .and_then(Value::as_u64)
        .unwrap_or(50)
        .clamp(1, 200) as usize;

    let start_dir = resolve_target_path(&root, sub_raw, false)?;
    let mut matches = Vec::new();
    let mut truncated = false;
    search_walk(
        &root,
        &start_dir,
        query,
        max_results,
        &mut matches,
        &mut truncated,
    );

    Ok(json!({
        "query": query,
        "matches": matches,
        "truncated": truncated,
    }))
}

fn search_walk(
    root: &Path,
    dir: &Path,
    query: &str,
    max_results: usize,
    out: &mut Vec<Value>,
    truncated: &mut bool,
) {
    if out.len() >= max_results {
        *truncated = true;
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };

    let mut list: Vec<_> = entries.filter_map(Result::ok).collect();
    list.sort_by_key(|e| e.file_name());

    for entry in list {
        if out.len() >= max_results {
            *truncated = true;
            return;
        }
        let path = entry.path();
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if IGNORED_DIRS.contains(&name_str.as_ref()) {
                continue;
            }
            search_walk(root, &path, query, max_results, out, truncated);
        } else if meta.is_file() && meta.len() <= MAX_SEARCH_FILE_BYTES {
            let bytes = match fs::read(&path) {
                Ok(b) if !b.contains(&0) => b,
                _ => continue,
            };
            let text = match String::from_utf8(bytes) {
                Ok(t) => t,
                Err(_) => continue,
            };
            for (idx, line) in text.lines().enumerate() {
                if line.contains(query) {
                    if out.len() >= max_results {
                        *truncated = true;
                        return;
                    }
                    let preview: String = line.chars().take(200).collect();
                    out.push(json!({
                        "path": relative_display(root, &path),
                        "line": idx + 1,
                        "preview": preview,
                    }));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn write_read_list_and_search_inside_workspace() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("gptpp_fs_test_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        let ws = dir.to_string_lossy().into_owned();

        let w = write_file(&json!({
            "workspaceRoot": ws,
            "path": "notes/todo.txt",
            "content": "alpha\nbeta needle\ngamma"
        }))
        .unwrap();
        assert_eq!(w["bytesWritten"], 23);

        let r = read_file(&json!({
            "workspaceRoot": ws,
            "path": "notes/todo.txt",
            "offset": 2,
            "limit": 1
        }))
        .unwrap();
        assert_eq!(r["content"], "beta needle");
        assert_eq!(r["totalLines"], 3);

        let s = search(&json!({
            "workspaceRoot": ws,
            "query": "needle"
        }))
        .unwrap();
        assert_eq!(s["matches"][0]["line"], 2);

        let l = list_dir(&json!({
            "workspaceRoot": ws,
            "path": "notes"
        }))
        .unwrap();
        assert_eq!(l["entries"][0]["name"], "todo.txt");

        let _ = fs::remove_dir_all(&dir);
    }
}
