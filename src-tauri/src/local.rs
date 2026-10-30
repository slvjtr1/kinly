//! Local media: the Downloads page (the XDG download folder plus folders the user adds) and a
//! background watcher that announces finished downloads.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const VIDEO_EXTS: &[&str] = &["mkv", "mp4", "m4v", "avi", "mov", "webm", "ts", "m2ts", "wmv", "mpg", "mpeg"];
/// Extensions browsers and download managers use while a file is still being written.
const PARTIAL_EXTS: &[&str] = &["crdownload", "part", "partial", "download", "opdownload", "tmp"];
const MAX_FILES: usize = 5000;
/// How deep to look inside the download folder (it is often a mess; extra folders get 5).
const DOWNLOAD_DEPTH: usize = 3;
const POLL: Duration = Duration::from_secs(5);
/// Without watcher data, a file written to this recently may still be growing.
const QUIET_SECS: u64 = 10;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified: u64,
}

#[tauri::command]
pub async fn local_scan(dir: String) -> Result<Vec<LocalFile>, String> {
    tokio::task::spawn_blocking(move || scan(Path::new(&dir), 5))
        .await
        .map_err(|e| e.to_string())?
}

fn is_video(p: &Path) -> bool {
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    VIDEO_EXTS.contains(&ext.as_str())
}

/// True for in-progress downloads: a partial extension, or a placeholder next to one
/// (Firefox writes an empty `movie.mkv` beside `movie.mkv.part`).
pub fn is_partial(p: &Path) -> bool {
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if PARTIAL_EXTS.contains(&ext.as_str()) {
        return true;
    }
    let Some(name) = p.file_name() else { return false };
    PARTIAL_EXTS.iter().any(|x| {
        let mut sib = name.to_os_string();
        sib.push(".");
        sib.push(x);
        p.with_file_name(sib).exists()
    })
}

fn mtime_secs(m: &std::fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
}

/// Complete video files under `dir` (symlinks followed, samples and partial downloads skipped).
pub fn scan(dir: &Path, depth: usize) -> Result<Vec<LocalFile>, String> {
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    let mut out = Vec::new();
    // Follow symlinks: linked media libraries are common. walkdir detects loops.
    for entry in walkdir::WalkDir::new(dir).max_depth(depth).follow_links(true).into_iter().flatten() {
        if out.len() >= MAX_FILES {
            break;
        }
        let p = entry.path();
        if !entry.file_type().is_file() || !is_video(p) || is_partial(p) {
            continue;
        }
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if name.starts_with('.') || crate::paths::is_sample(p, dir) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() == 0 {
            continue;
        }
        out.push(LocalFile { path: p.display().to_string(), name, size: meta.len(), modified: mtime_secs(&meta) });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// The user's download folder: the platform's (XDG user dirs on Linux, the Known
/// Folder on Windows, via `dirs`), then `xdg-user-dir DOWNLOAD` on Linux, then ~/Downloads.
pub fn download_dir() -> Option<PathBuf> {
    if let Some(d) = dirs::download_dir().filter(|d| d.is_dir()) {
        return Some(d);
    }
    #[cfg(target_os = "linux")]
    if let Ok(out) = std::process::Command::new("xdg-user-dir").arg("DOWNLOAD").output() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let p = PathBuf::from(&s);
        if !s.is_empty() && p.is_dir() && Some(p.as_path()) != dirs::home_dir().as_deref() {
            return Some(p);
        }
    }
    dirs::home_dir().map(|h| h.join("Downloads")).filter(|d| d.is_dir())
}

// ---------------------------------------------------------------------------------------------
// Completion tracking (pure, unit tested)

#[derive(Clone, Copy, Debug)]
struct Seen {
    size: u64,
    stable: bool,
}

/// Remembers file sizes between polls. A file is complete once its size is unchanged across two
/// polls; files already settled when tracking starts are never announced.
#[derive(Default)]
pub struct Tracker {
    seen: HashMap<String, Seen>,
    primed: bool,
}

impl Tracker {
    /// Feeds one poll (`(path, size, seconds since modified)`); returns the files that just completed.
    pub fn observe(&mut self, files: &[(String, u64, u64)]) -> Vec<String> {
        let mut next = HashMap::with_capacity(files.len());
        let mut done = Vec::new();
        for (path, size, age) in files {
            let stable = match self.seen.get(path) {
                Some(prev) if prev.stable && prev.size == *size => true,
                Some(prev) if prev.size == *size => {
                    done.push(path.clone());
                    true
                }
                Some(_) => false,
                // First poll: files that have been quiet for a while are old downloads.
                None => !self.primed && *age >= QUIET_SECS,
            };
            next.insert(path.clone(), Seen { size: *size, stable });
        }
        self.seen = next;
        self.primed = true;
        done
    }

    /// False while a file is known to be growing (or new and not yet confirmed).
    pub fn is_settled(&self, path: &str, age: u64) -> bool {
        match self.seen.get(path) {
            Some(s) => s.stable,
            None => age >= QUIET_SECS,
        }
    }
}

pub struct Downloads {
    tracker: std::sync::Mutex<Tracker>,
}

impl Downloads {
    pub fn new() -> Self {
        Self { tracker: std::sync::Mutex::new(Tracker::default()) }
    }
}

impl Default for Downloads {
    fn default() -> Self {
        Self::new()
    }
}

fn age_of(f: &LocalFile, now: u64) -> u64 {
    now.saturating_sub(f.modified)
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Polls the download folder every few seconds and emits `downloads:new` (a LocalFile) for each
/// video that finished downloading. Cheap: one directory walk per poll.
pub fn start_watcher(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    std::thread::Builder::new()
        .name("downloads-watch".into())
        .spawn(move || loop {
            if let Some(dir) = download_dir() {
                if let Ok(files) = scan(&dir, DOWNLOAD_DEPTH) {
                    let now = now_secs();
                    let polled: Vec<(String, u64, u64)> = files.iter().map(|f| (f.path.clone(), f.size, age_of(f, now))).collect();
                    let done = app.state::<Downloads>().tracker.lock().map(|mut t| t.observe(&polled)).unwrap_or_default();
                    let managed = app.state::<crate::download::Downloader>();
                    for path in done {
                        // Kinly's own downloads are announced when they finish (download.rs).
                        if managed.is_managed(&path) {
                            continue;
                        }
                        if let Some(f) = files.iter().find(|f| f.path == path) {
                            log_info!("downloads", "finished: {}", f.name);
                            let _ = app.emit("downloads:new", f.clone());
                        }
                    }
                }
            }
            std::thread::sleep(POLL);
        })
        .ok();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// The download folder, if there is one.
    pub dir: Option<String>,
    pub downloads: Vec<LocalFile>,
    /// One entry per extra folder, in the order given.
    pub folders: Vec<FolderListing>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub dir: String,
    pub files: Vec<LocalFile>,
    pub error: Option<String>,
}

/// Complete videos in the download folder (newest first) and in each extra folder.
#[tauri::command]
pub async fn downloads_list(state: tauri::State<'_, Downloads>, extra: Vec<String>) -> Result<Listing, String> {
    let dir = download_dir();
    let d2 = dir.clone();
    let (mut downloads, folders) = tokio::task::spawn_blocking(move || {
        let downloads = d2.as_deref().and_then(|d| scan(d, DOWNLOAD_DEPTH).ok()).unwrap_or_default();
        let folders: Vec<FolderListing> = extra
            .into_iter()
            .take(50)
            .map(|d| match scan(Path::new(&d), 5) {
                Ok(files) => FolderListing { dir: d, files, error: None },
                Err(e) => FolderListing { dir: d, files: vec![], error: Some(e) },
            })
            .collect();
        (downloads, folders)
    })
    .await
    .map_err(|e| e.to_string())?;
    let now = now_secs();
    if let Ok(t) = state.tracker.lock() {
        downloads.retain(|f| t.is_settled(&f.path, age_of(f, now)));
    }
    downloads.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.cmp(&b.name)));
    Ok(Listing { dir: dir.map(|d| d.display().to_string()), downloads, folders })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kinly-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_videos_including_symlinks_and_skips_samples() {
        let dir = tmp("scan");
        std::fs::create_dir_all(dir.join("Show/Season 1")).unwrap();
        std::fs::write(dir.join("Show/Season 1/Show.S01E01.mkv"), b"x").unwrap();
        std::fs::write(dir.join("movie-sample.mkv"), b"x").unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        std::fs::write(dir.join("real.mp4"), b"x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("real.mp4"), dir.join("Linked.Movie.2020.mp4")).unwrap();
        let names: Vec<String> = scan(&dir, 5).unwrap().into_iter().map(|f| f.name).collect();
        assert!(names.contains(&"Show.S01E01.mkv".to_string()));
        #[cfg(unix)]
        assert!(names.contains(&"Linked.Movie.2020.mp4".to_string()), "{names:?}");
        assert!(!names.iter().any(|n| n.contains("sample") || n.ends_with(".txt")));
    }

    #[test]
    fn skips_partial_downloads_and_their_placeholders() {
        let dir = tmp("partial");
        std::fs::write(dir.join("Done.Movie.mkv"), b"xx").unwrap();
        std::fs::write(dir.join("Chrome.mkv.crdownload"), b"xx").unwrap();
        std::fs::write(dir.join("Firefox.mp4"), b"").unwrap();
        std::fs::write(dir.join("Firefox.mp4.part"), b"xx").unwrap();
        std::fs::write(dir.join("Other.mkv"), b"xx").unwrap();
        std::fs::write(dir.join("Other.mkv.partial"), b"xx").unwrap();
        std::fs::write(dir.join("Empty.mkv"), b"").unwrap();
        let names: Vec<String> = scan(&dir, 3).unwrap().into_iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["Done.Movie.mkv".to_string()]);
        assert!(is_partial(&dir.join("x.download")));
    }

    #[test]
    fn tracker_announces_a_file_once_its_size_holds() {
        let mut t = Tracker::default();
        // Startup: an old file is settled silently; a fresh one is pending.
        assert!(t.observe(&[("old.mkv".into(), 10, 3600), ("fresh.mkv".into(), 5, 1)]).is_empty());
        assert!(t.is_settled("old.mkv", 3600));
        assert!(!t.is_settled("fresh.mkv", 1));
        // Still growing.
        assert!(t.observe(&[("old.mkv".into(), 10, 3605), ("fresh.mkv".into(), 8, 1)]).is_empty());
        // Unchanged across two polls: complete, announced exactly once.
        assert_eq!(t.observe(&[("old.mkv".into(), 10, 3610), ("fresh.mkv".into(), 8, 6)]), vec!["fresh.mkv".to_string()]);
        assert!(t.observe(&[("old.mkv".into(), 10, 3615), ("fresh.mkv".into(), 8, 11)]).is_empty());
        assert!(t.is_settled("fresh.mkv", 11));
        // A file renamed into place after startup is new even if its mtime is old.
        assert!(t.observe(&[("moved.mkv".into(), 7, 9999)]).is_empty());
        assert_eq!(t.observe(&[("moved.mkv".into(), 7, 9999)]), vec!["moved.mkv".to_string()]);
        // Unknown files fall back to the mtime rule.
        assert!(!t.is_settled("never-seen.mkv", 2));
        assert!(t.is_settled("never-seen.mkv", 60));
    }
}
