//! Minimal file + stderr logger. Lines are redacted before writing so that
//! credentials embedded in URLs (addon configs, tokens, API keys) never reach disk.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static SINK: OnceLock<Mutex<Option<File>>> = OnceLock::new();
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

pub fn init(dir: &Path) -> Option<PathBuf> {
    std::fs::create_dir_all(dir).ok()?;
    let path = dir.join("kinly.log");
    if std::fs::metadata(&path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("kinly.log.1"));
    }
    let file = OpenOptions::new().create(true).append(true).open(&path).ok();
    let _ = SINK.set(Mutex::new(file));
    Some(path)
}

pub fn write(level: &str, target: &str, msg: &str) {
    let line = format!(
        "{} {:5} [{}] {}",
        timestamp(),
        level,
        target,
        redact(msg)
    );
    eprintln!("{line}");
    if let Some(lock) = SINK.get() {
        if let Ok(mut guard) = lock.lock() {
            if let Some(f) = guard.as_mut() {
                let _ = writeln!(f, "{line}");
            }
        }
    }
}

fn timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

/// Strip things that look like secrets: URL userinfo, query strings, and the
/// configuration path segment Stremio addons use to carry API keys.
pub fn redact(input: &str) -> String {
    static RE_QUERY: OnceLock<regex::Regex> = OnceLock::new();
    static RE_USERINFO: OnceLock<regex::Regex> = OnceLock::new();
    static RE_LONGSEG: OnceLock<regex::Regex> = OnceLock::new();
    static RE_BEARER: OnceLock<regex::Regex> = OnceLock::new();
    let q = RE_QUERY.get_or_init(|| regex::Regex::new(r"(https?://[^\s?#]+)\?[^\s#]*").unwrap());
    let u = RE_USERINFO.get_or_init(|| regex::Regex::new(r"(https?://)[^/\s@]+@").unwrap());
    let l = RE_LONGSEG.get_or_init(|| regex::Regex::new(r"/[A-Za-z0-9%_\-=.|,]{40,}").unwrap());
    let b = RE_BEARER
        .get_or_init(|| regex::Regex::new(
            r#"(?i)((?:bearer|api[_-]?key|[a-z_]*token|secret|password|client_secret)"?)(\s*[=:]\s*"?|\s+)[^\s",}&]+"#,
        ).unwrap());
    let s = u.replace_all(input, "$1***@");
    let s = q.replace_all(&s, "$1?***");
    let s = l.replace_all(&s, "/***");
    b.replace_all(&s, "$1$2***").into_owned()
}

#[macro_export]
macro_rules! log_info { ($t:expr, $($a:tt)*) => { $crate::logging::write("INFO", $t, &format!($($a)*)) } }
#[macro_export]
macro_rules! log_warn { ($t:expr, $($a:tt)*) => { $crate::logging::write("WARN", $t, &format!($($a)*)) } }
#[macro_export]
macro_rules! log_error { ($t:expr, $($a:tt)*) => { $crate::logging::write("ERROR", $t, &format!($($a)*)) } }

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn strips_query_and_userinfo() {
        let r = redact("GET https://user:pw@host.tld/a/b?apikey=SECRET&x=1 ok");
        assert!(!r.contains("SECRET"));
        assert!(!r.contains("pw@"));
        assert!(r.contains("host.tld/a/b"));
    }

    #[test]
    fn strips_addon_config_segment() {
        let r = redact("https://addon.example/eyJkZWJyaWQiOiJ0b3Jib3giLCJrZXkiOiJhYmNkZWYxMjM0NTY3ODkwIn0/manifest.json");
        assert!(r.contains("/***/manifest.json"), "{r}");
    }

    #[test]
    fn strips_json_tokens() {
        let r = redact(r#"{"access_token":"AAA111","refresh_token": "BBB222","password":"hunter2"}"#);
        assert!(!r.contains("AAA111") && !r.contains("BBB222") && !r.contains("hunter2"), "{r}");
    }

    #[test]
    fn strips_tokens() {
        let r = redact("Authorization: Bearer abc.def.ghi");
        assert!(!r.contains("abc.def"));
    }
}
