//! In-app downloads: a source's direct link is streamed into the user's download folder as
//! `<name>.part` and renamed when complete, so the Downloads page and its watcher (local.rs) pick
//! it up like any other finished download. Progress is emitted as `downloads:progress`.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

const VIDEO_EXTS: &[&str] = &["mkv", "mp4", "m4v", "avi", "mov", "webm", "ts", "m2ts", "wmv", "mpg", "mpeg"];
/// A stalled connection fails the download instead of hanging it forever.
const CHUNK_TIMEOUT: Duration = Duration::from_secs(60);
const EMIT_EVERY: Duration = Duration::from_millis(400);
const MAX_NAME: usize = 150;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: u64,
    pub name: String,
    pub received: u64,
    /// From Content-Length; 0 when the server does not say.
    pub total: u64,
    /// "running", "done", "failed" or "cancelled".
    pub state: &'static str,
    pub error: Option<String>,
}

struct Job {
    progress: Progress,
    cancel: Arc<AtomicBool>,
    part: PathBuf,
}

/// Running and failed downloads. Finished and cancelled ones are dropped (finished files are
/// listed from disk); failed ones stay until the user dismisses them.
#[derive(Default)]
pub struct Downloader {
    jobs: Mutex<HashMap<u64, Job>>,
    next: AtomicU64,
}

impl Downloader {
    fn update(&self, p: &Progress) {
        if let Ok(mut jobs) = self.jobs.lock() {
            match p.state {
                "done" | "cancelled" => {
                    jobs.remove(&p.id);
                }
                _ => {
                    if let Some(j) = jobs.get_mut(&p.id) {
                        j.progress = p.clone();
                    }
                }
            }
        }
    }
}

/// A file name that is safe on every platform: no separators, reserved characters or control
/// characters, no leading/trailing dots or spaces, no Windows device names, bounded length.
pub fn sanitize_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { ' ' } else { c })
        .collect();
    let mut name = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.chars().count() > MAX_NAME {
        name = name.chars().take(MAX_NAME).collect();
    }
    let name = name.trim_matches(|c: char| c == '.' || c == ' ').to_string();
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    match (name.is_empty(), reserved) {
        (true, _) => "Kinly download".into(),
        (false, true) => format!("_{name}"),
        _ => name,
    }
}

fn video_ext(s: &str) -> Option<&'static str> {
    let ext = s.rsplit_once('.')?.1.to_ascii_lowercase();
    VIDEO_EXTS.iter().copied().find(|e| *e == ext)
}

/// The extension for the saved file: the name's own, then the URL path's, then the response's
/// Content-Type, then mkv (mpv plays any container whatever the extension says).
pub fn pick_ext(name: &str, url_path: &str, content_type: &str) -> &'static str {
    if let Some(e) = video_ext(name).or_else(|| video_ext(url_path.rsplit('/').next().unwrap_or(""))) {
        return e;
    }
    match content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "video/x-msvideo" => "avi",
        "video/mp2t" => "ts",
        _ => "mkv",
    }
}

/// `<dir>/<stem>.<ext>`, or `<stem> (2).<ext>` … when that file (or its .part) already exists.
pub fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let free = |p: &Path| !p.exists() && !part_of(p).exists();
    let first = dir.join(format!("{stem}.{ext}"));
    if free(&first) {
        return first;
    }
    (2..1000).map(|n| dir.join(format!("{stem} ({n}).{ext}"))).find(|p| free(p)).unwrap_or(first)
}

fn part_of(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(".part");
    PathBuf::from(s)
}

/// Strips a known video extension so it is not doubled when the final one is added.
fn stem_of(name: &str) -> &str {
    match video_ext(name) {
        Some(e) => &name[..name.len() - e.len() - 1],
        None => name,
    }
}

fn header_ok(k: &str, v: &str) -> bool {
    let k = k.trim();
    !k.is_empty()
        && k.len() <= 64
        && v.len() <= 2048
        && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !v.contains(['\r', '\n'])
        && !matches!(k.to_ascii_lowercase().as_str(), "host" | "content-length" | "transfer-encoding" | "connection")
}

#[tauri::command]
pub async fn download_start(
    app: AppHandle,
    state: State<'_, Downloader>,
    url: String,
    name: String,
    headers: Option<HashMap<String, String>>,
) -> Result<Progress, String> {
    let parsed = crate::net::check_url(&url)?;
    let dir = crate::local::download_dir().ok_or("No Downloads folder was found on this computer.")?;
    let mut req = crate::net::client().get(parsed.clone());
    for (k, v) in headers.unwrap_or_default().into_iter().filter(|(k, v)| header_ok(k, v)).take(16) {
        req = req.header(k.trim(), v);
    }
    let resp = req.send().await.map_err(|e| format!("Could not connect: {}", crate::logging::redact(&e.to_string())))?;
    if !resp.status().is_success() {
        return Err(format!("The source answered HTTP {}.", resp.status().as_u16()));
    }
    let ctype = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if ctype.starts_with("text/html") || ctype.starts_with("application/json") {
        return Err("This link leads to a web page, not a video file.".into());
    }
    let name = sanitize_name(&name);
    let path = unique_path(&dir, stem_of(&name), pick_ext(&name, parsed.path(), &ctype));
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let part = part_of(&path);
    let file = tokio::fs::File::create(&part).await.map_err(|e| format!("Could not create the file: {e}"))?;

    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    let first = Progress { id, name: file_name, received: 0, total: resp.content_length().unwrap_or(0), state: "running", error: None };
    if let Ok(mut jobs) = state.jobs.lock() {
        jobs.insert(id, Job { progress: first.clone(), cancel: cancel.clone(), part: part.clone() });
    }
    log_info!("downloads", "start {}: {}", id, crate::logging::redact(&url));

    let mut p = first.clone();
    tauri::async_runtime::spawn(async move {
        let result = copy(resp, file, &mut p, &cancel, &app).await;
        let outcome = match result {
            Ok(()) => tokio::fs::rename(&part, &path).await.map_err(|e| format!("Could not finish the file: {e}")),
            Err(e) => Err(e),
        };
        match outcome {
            Ok(()) => p.state = "done",
            Err(e) => {
                let _ = tokio::fs::remove_file(&part).await;
                if cancel.load(Ordering::Relaxed) {
                    p.state = "cancelled";
                } else {
                    log_warn!("downloads", "{} failed: {}", p.id, e);
                    p.state = "failed";
                    p.error = Some(e);
                }
            }
        }
        app.state::<Downloader>().update(&p);
        let _ = app.emit("downloads:progress", p.clone());
    });
    Ok(first)
}

async fn copy(mut resp: reqwest::Response, file: tokio::fs::File, p: &mut Progress, cancel: &AtomicBool, app: &AppHandle) -> Result<(), String> {
    let mut out = tokio::io::BufWriter::with_capacity(1 << 20, file);
    let mut last = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let chunk = tokio::time::timeout(CHUNK_TIMEOUT, resp.chunk())
            .await
            .map_err(|_| "The source stopped sending data.".to_string())?
            .map_err(|e| format!("The connection broke: {}", crate::logging::redact(&e.to_string())))?;
        let Some(chunk) = chunk else { break };
        out.write_all(&chunk).await.map_err(|e| format!("Could not write the file: {e}"))?;
        p.received += chunk.len() as u64;
        if last.elapsed() >= EMIT_EVERY {
            last = Instant::now();
            app.state::<Downloader>().update(p);
            let _ = app.emit("downloads:progress", p.clone());
        }
    }
    out.flush().await.map_err(|e| format!("Could not write the file: {e}"))?;
    if p.total > 0 && p.received < p.total {
        return Err("The download ended early.".into());
    }
    Ok(())
}

/// Cancels a running download, or dismisses a failed one.
#[tauri::command]
pub fn download_cancel(state: State<'_, Downloader>, id: u64) {
    let Ok(mut jobs) = state.jobs.lock() else { return };
    let running = jobs.get(&id).map(|j| j.progress.state == "running");
    match running {
        Some(true) => {
            if let Some(j) = jobs.get(&id) {
                j.cancel.store(true, Ordering::Relaxed);
            }
        }
        Some(false) => {
            jobs.remove(&id);
        }
        None => {}
    }
}

/// Running and failed downloads, oldest first (for pages opened after a download started).
#[tauri::command]
pub fn downloads_active(state: State<'_, Downloader>) -> Vec<Progress> {
    let mut v: Vec<Progress> = state.jobs.lock().map(|j| j.values().map(|j| j.progress.clone()).collect()).unwrap_or_default();
    v.sort_by_key(|p| p.id);
    v
}

/// Stops running downloads when the app exits and removes their .part files (best effort: the
/// tasks don't get to clean up after the runtime stops).
pub fn cancel_all(state: &Downloader) {
    let Ok(jobs) = state.jobs.lock() else { return };
    for j in jobs.values().filter(|j| j.progress.state == "running") {
        j.cancel.store(true, Ordering::Relaxed);
        let _ = std::fs::remove_file(&j.part);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_safe() {
        assert_eq!(sanitize_name("Dune: Part Two (2024)"), "Dune Part Two (2024)");
        assert_eq!(sanitize_name("../../etc/passwd"), "etc passwd");
        assert_eq!(sanitize_name("a\\b/c\u{0}d"), "a b c d");
        assert_eq!(sanitize_name("  ...  "), "Kinly download");
        assert_eq!(sanitize_name("CON"), "_CON");
        assert_eq!(sanitize_name("com1.mkv"), "_com1.mkv");
        assert_eq!(sanitize_name("Console"), "Console");
        assert_eq!(sanitize_name(&"x".repeat(400)).len(), MAX_NAME);
    }

    #[test]
    fn extension_choice() {
        assert_eq!(pick_ext("Movie.2024.1080p.MKV", "/x", ""), "mkv");
        assert_eq!(pick_ext("Movie", "/dl/file.mp4", ""), "mp4");
        assert_eq!(pick_ext("Movie", "/dl/stream", "video/webm; charset=binary"), "webm");
        assert_eq!(pick_ext("Movie 1.5", "/dl/stream", "application/octet-stream"), "mkv");
        assert_eq!(stem_of("Movie.2024.mp4"), "Movie.2024");
        assert_eq!(stem_of("Movie 1.5"), "Movie 1.5");
    }

    #[test]
    fn unique_paths() {
        let dir = std::env::temp_dir().join(format!("kinly-dl-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(unique_path(&dir, "a", "mkv"), dir.join("a.mkv"));
        std::fs::write(dir.join("a.mkv"), b"").unwrap();
        std::fs::write(dir.join("a (2).mkv.part"), b"").unwrap();
        assert_eq!(unique_path(&dir, "a", "mkv"), dir.join("a (3).mkv"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn headers_filtered() {
        assert!(header_ok("Referer", "https://example.com/"));
        assert!(!header_ok("Host", "evil"));
        assert!(!header_ok("X-A", "a\r\nB: c"));
        assert!(!header_ok("Bad Name", "v"));
    }
}
