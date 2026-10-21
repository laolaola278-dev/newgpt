//! Workspace confinement sandbox for the GPT++ Rust Native Host.
//!
//! Security invariants:
//!  - Every filesystem, shell and git operation requires an explicit, existing
//!    `workspaceRoot` directory.
//!  - Both existing targets and newly created parent paths are resolved via
//!    `std::fs::canonicalize` so symlinks/junctions pointing outside the
//!    workspace root are unconditionally rejected.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

/// Extract and canonicalize `params["workspaceRoot"]`, confirming it is an existing directory.
pub fn resolve_workspace_root(params: &Value) -> Result<PathBuf, String> {
    let raw = params
        .get("workspaceRoot")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "missing required string \"workspaceRoot\"".to_string())?;

    if raw.contains('\0') {
        return Err("workspaceRoot contains illegal null byte".to_string());
    }

    let canon = fs::canonicalize(raw)
        .map_err(|e| format!("cannot access workspaceRoot \"{raw}\": {e}"))?;

    if !canon.is_dir() {
        return Err(format!("workspaceRoot \"{raw}\" is not a directory"));
    }

    Ok(canon)
}

/// Resolve `raw_path` inside `canon_root`, rejecting any traversal or symlink escape.
pub fn resolve_target_path(
    canon_root: &Path,
    raw_path: &str,
    allow_missing: bool,
) -> Result<PathBuf, String> {
    if raw_path.contains('\0') {
        return Err("path contains illegal null byte".to_string());
    }

    let trimmed = raw_path.trim();
    let effective = if trimmed.is_empty() { "." } else { trimmed };
    let input = Path::new(effective);
    let joined = if input.is_absolute() {
        input.to_path_buf()
    } else {
        canon_root.join(input)
    };

    if joined.exists() {
        let canon = fs::canonicalize(&joined)
            .map_err(|e| format!("cannot canonicalize \"{effective}\": {e}"))?;
        if !canon.starts_with(canon_root) {
            return Err(format!(
                "access denied: \"{effective}\" escapes workspace root"
            ));
        }
        return Ok(canon);
    }

    if !allow_missing {
        return Err(format!("path does not exist: \"{effective}\""));
    }

    // Walk backwards to the deepest existing ancestor, canonicalize it, and
    // verify the remaining new segments contain only plain normal components.
    let mut missing_tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = joined.as_path();

    while !cursor.exists() {
        match cursor.file_name() {
            Some(name) => {
                missing_tail.push(name.to_os_string());
                cursor = cursor
                    .parent()
                    .ok_or_else(|| format!("cannot resolve parent of \"{effective}\""))?;
            }
            None => return Err(format!("invalid target path \"{effective}\"")),
        }
    }

    // Reject `.` or `..` anywhere in non-existent tail components.
    for seg in &missing_tail {
        for comp in Path::new(seg).components() {
            if !matches!(comp, Component::Normal(_)) {
                return Err(format!(
                    "illegal path segment in target path \"{effective}\""
                ));
            }
        }
    }

    let mut canon_base = fs::canonicalize(cursor)
        .map_err(|e| format!("cannot canonicalize parent of \"{effective}\": {e}"))?;

    if !canon_base.starts_with(canon_root) {
        return Err(format!(
            "access denied: \"{effective}\" escapes workspace root"
        ));
    }

    for seg in missing_tail.into_iter().rev() {
        canon_base.push(seg);
    }

    if !canon_base.starts_with(canon_root) {
        return Err(format!(
            "access denied: \"{effective}\" escapes workspace root"
        ));
    }

    Ok(canon_base)
}

/// Render a clean forward-slash path relative to `canon_root`.
pub fn relative_display(canon_root: &Path, target: &Path) -> String {
    match target.strip_prefix(canon_root) {
        Ok(rel) => {
            let s = rel.to_string_lossy().replace('\\', "/");
            if s.is_empty() {
                ".".to_string()
            } else {
                s
            }
        }
        Err(_) => target.to_string_lossy().replace('\\', "/"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("gptpp_test_{label}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn allows_nested_paths_and_blocks_traversal() {
        let dir = make_temp_dir("sandbox");
        let sub = dir.join("src");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("lib.rs"), "pub fn ok() {}").unwrap();

        let root = resolve_workspace_root(&json!({
            "workspaceRoot": dir.to_string_lossy()
        }))
        .unwrap();

        let valid = resolve_target_path(&root, "src/lib.rs", false).unwrap();
        assert_eq!(relative_display(&root, &valid), "src/lib.rs");

        let new_file = resolve_target_path(&root, "src/new_mod/main.rs", true).unwrap();
        assert_eq!(relative_display(&root, &new_file), "src/new_mod/main.rs");

        let escape = resolve_target_path(&root, "../../etc/passwd", true);
        assert!(escape.is_err());

        let _ = fs::remove_dir_all(&dir);
    }
}
