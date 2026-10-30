//! Kinly's own copy of yt-dlp, so trailers work without anyone installing it by hand.
//!
//! YouTube changes often and old yt-dlp releases stop working, so Kinly keeps a copy in its data
//! folder (`<data>/tools/`) and refreshes it when it is a week old, or sooner when it fails. The
//! file comes from yt-dlp's official GitHub releases and is checked against the SHA-256 list
//! published with the same release before it is used. It is only fetched when a trailer is opened.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const RELEASES: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const MAX_SIZE: usize = 120 * 1024 * 1024;
/// A copy older than this is refreshed before use.
pub const STALE: Duration = Duration::from_secs(7 * 24 * 3600);
/// After a failure, a copy older than this is refreshed and the trailer tried again.
pub const RETRY_AGE: Duration = Duration::from_secs(12 * 3600);

/// The release file for this OS and CPU (standalone builds; no Python needed).
fn asset() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("yt-dlp_linux"),
        ("linux", "aarch64") => Some("yt-dlp_linux_aarch64"),
        ("windows", "x86_64") => Some("yt-dlp.exe"),
        ("macos", _) => Some("yt-dlp_macos"),
        _ => None,
    }
}

pub fn managed_path(data_dir: &Path) -> PathBuf {
    data_dir.join("tools").join(crate::tools::exe_name("yt-dlp"))
}

/// How old the managed copy is, or None when there is none.
pub fn age(path: &Path) -> Option<Duration> {
    let m = std::fs::metadata(path).ok().filter(|m| m.is_file() && m.len() > 0)?;
    Some(SystemTime::now().duration_since(m.modified().ok()?).unwrap_or_default())
}

/// The SHA-256 of `file` in a `SHA2-256SUMS` listing (`<hex>  <name>`).
pub fn expected_sha(sums: &str, file: &str) -> Option<String> {
    sums.lines().find_map(|l| {
        let (hash, name) = l.trim().split_once(char::is_whitespace)?;
        (name.trim().trim_start_matches('*') == file && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| hash.to_ascii_lowercase())
    })
}

static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Downloads the latest yt-dlp into `<data>/tools/` unless the copy there is newer than `max_age`.
/// Only one download runs at a time; a failed download leaves the old copy in place.
pub async fn ensure(data_dir: &Path, max_age: Duration) -> Result<PathBuf, String> {
    let path = managed_path(data_dir);
    let _g = LOCK.lock().await;
    if age(&path).is_some_and(|a| a < max_age) {
        return Ok(path);
    }
    let file = asset().ok_or("no yt-dlp build for this system")?;
    let sums = String::from_utf8_lossy(&crate::net::fetch_bytes(&format!("{RELEASES}/SHA2-256SUMS"), Duration::from_secs(30)).await?).into_owned();
    let want = expected_sha(&sums, file).ok_or("yt-dlp checksum not published")?;
    let bytes = download(&format!("{RELEASES}/{file}")).await?;
    let got: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    if got != want {
        return Err("yt-dlp download did not match its checksum".into());
    }
    let dir = path.parent().ok_or("bad tools dir")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("tools dir: {e}"))?;
    let tmp = path.with_extension("download");
    let _ = std::fs::remove_file(&tmp);
    std::fs::write(&tmp, &bytes).map_err(|e| format!("save yt-dlp: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| format!("chmod yt-dlp: {e}"))?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("install yt-dlp: {e}"))?;
    crate::log_info!("trailer", "installed the latest yt-dlp ({} MB)", bytes.len() / (1024 * 1024));
    Ok(path)
}

async fn download(url: &str) -> Result<Vec<u8>, String> {
    let mut resp = crate::net::client()
        .get(crate::net::check_url(url)?)
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| format!("yt-dlp download failed: {}", crate::logging::redact(&e.to_string())))?;
    if !resp.status().is_success() {
        return Err(format!("yt-dlp download failed: http {}", resp.status().as_u16()));
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("yt-dlp download failed: {e}"))? {
        if out.len() + chunk.len() > MAX_SIZE {
            return Err("yt-dlp download too large".into());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_checksum_list() {
        let h = "a".repeat(64);
        let sums = format!("{}  yt-dlp\n{h}  yt-dlp_linux\n{}  yt-dlp.exe\n", "b".repeat(64), "c".repeat(64));
        assert_eq!(expected_sha(&sums, "yt-dlp_linux"), Some(h));
        assert_eq!(expected_sha(&sums, "yt-dlp.exe"), Some("c".repeat(64)));
        assert_eq!(expected_sha(&sums, "yt-dlp_macos"), None);
        assert_eq!(expected_sha("zz  yt-dlp_linux", "yt-dlp_linux"), None);
    }

    #[test]
    fn has_an_asset_here() {
        if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            assert_eq!(asset(), Some("yt-dlp_linux"));
        }
        assert!(managed_path(Path::new("/d")).starts_with("/d/tools"));
    }

    /// Live: downloads the real release and runs it. `cargo test -- --ignored ytdlp`
    #[tokio::test]
    #[ignore]
    async fn downloads_and_runs() {
        let dir = std::env::temp_dir().join(format!("kinly-ytdlp-{}", std::process::id()));
        let bin = ensure(&dir, STALE).await.expect("download");
        let out = std::process::Command::new(&bin).arg("--version").output().expect("run");
        assert!(out.status.success());
        println!("yt-dlp {}", String::from_utf8_lossy(&out.stdout).trim());
        assert_eq!(ensure(&dir, STALE).await.unwrap(), bin, "fresh copy is reused");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
