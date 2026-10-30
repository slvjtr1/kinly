//! JSON document persistence under XDG directories.
//!
//! - Writes are atomic (temp file + fsync + rename).
//! - A document that fails to parse is renamed to `<name>.corrupt-<unix>.json`
//!   and reported to the UI; it is never deleted automatically.
//! - Every document is owner-only on Unix (folder 0700, files 0600): besides secrets, the
//!   library, settings and profile documents hold personal watch history and file paths.

use serde::Serialize;
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct Store {
    dir: PathBuf,
    lock: Mutex<()>,
}

#[derive(Serialize)]
pub struct LoadResult {
    pub value: Option<Value>,
    /// Set when the previous file was unreadable and moved aside.
    #[serde(rename = "recoveredFrom")]
    pub recovered_from: Option<String>,
}

const ALLOWED: &[&str] = &["settings", "library", "addons", "credentials", "subprefs", "account", "trakt", "profile", "searches"];

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        Store { dir, lock: Mutex::new(()) }
    }

    fn path(&self, name: &str) -> Result<PathBuf, String> {
        if !ALLOWED.contains(&name) {
            return Err(format!("unknown store document '{name}'"));
        }
        Ok(self.dir.join(format!("{name}.json")))
    }

    pub fn load(&self, name: &str) -> Result<LoadResult, String> {
        let _g = self.lock.lock().map_err(|e| e.to_string())?;
        let path = self.path(name)?;
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(LoadResult { value: None, recovered_from: None })
            }
            Err(e) => return Err(format!("read {name}: {e}")),
        };
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) => Ok(LoadResult { value: Some(v), recovered_from: None }),
            Err(err) => {
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let aside = self.dir.join(format!("{name}.corrupt-{stamp}.json"));
                crate::log_warn!("store", "{name}.json is unreadable ({err}); moved to {}", aside.display());
                std::fs::rename(&path, &aside).map_err(|e| format!("move corrupt {name}: {e}"))?;
                Ok(LoadResult { value: None, recovered_from: Some(aside.display().to_string()) })
            }
        }
    }

    pub fn save(&self, name: &str, value: &Value) -> Result<(), String> {
        let _g = self.lock.lock().map_err(|e| e.to_string())?;
        let path = self.path(name)?;
        let data = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
        atomic_write(&path, &data, true).map_err(|e| format!("write {name}: {e}"))
    }
}

pub fn atomic_write(path: &Path, data: &[u8], private: bool) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    // A leftover tmp file from a crash may have looser permissions; `mode` only applies on create.
    let _ = std::fs::remove_file(&tmp);
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        #[cfg(not(unix))]
        let _ = private; // Windows: the per-user profile folder's ACL already restricts it.
        let mut f = opts.open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kinly-store-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn roundtrip() {
        let s = Store::new(tmpdir("rt"));
        s.save("settings", &serde_json::json!({"a": 1})).unwrap();
        assert_eq!(s.load("settings").unwrap().value.unwrap()["a"], 1);
    }

    #[test]
    fn corrupt_file_is_moved_not_deleted() {
        let dir = tmpdir("corrupt");
        let s = Store::new(dir.clone());
        std::fs::write(dir.join("library.json"), b"{not json").unwrap();
        let r = s.load("library").unwrap();
        assert!(r.value.is_none());
        let aside = r.recovered_from.expect("should report recovery");
        assert_eq!(std::fs::read(&aside).unwrap(), b"{not json");
    }

    #[test]
    fn rejects_unknown_names() {
        let s = Store::new(tmpdir("names"));
        assert!(s.save("../etc/passwd", &Value::Null).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn every_document_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmpdir("private");
        let s = Store::new(dir.clone());
        let mode = |p: PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(dir.clone()), 0o700);
        for name in ALLOWED {
            // An older, world-readable file is replaced by an owner-only one on the next save.
            std::fs::write(dir.join(format!("{name}.json")), b"{}").unwrap();
            std::fs::set_permissions(dir.join(format!("{name}.json")), std::fs::Permissions::from_mode(0o644)).unwrap();
            s.save(name, &serde_json::json!({"k": "v"})).unwrap();
            assert_eq!(mode(dir.join(format!("{name}.json"))), 0o600, "{name}");
        }
    }
}
