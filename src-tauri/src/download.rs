//! In-app downloads. A source's direct link is streamed to `<folder>/<name>.part` and renamed when
//! complete. Every download Kinly starts is recorded in `downloads.json` (app data folder), which
//! is what the Downloads page manages: Kinly only ever deletes files listed there, by record id,
//! never a path handed over by the UI. Progress is emitted as `downloads:progress` (a Record).

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

const VIDEO_EXTS: &[&str] = &["mkv", "mp4", "m4v", "avi", "mov", "webm", "ts", "m2ts", "wmv", "mpg", "mpeg"];
/// A stalled connection fails the download instead of hanging it forever.
const CHUNK_TIMEOUT: Duration = Duration::from_secs(60);
const EMIT_EVERY: Duration = Duration::from_millis(400);
const MAX_NAME: usize = 150;
const MAX_RECORDS: usize = 2000;

pub const RUNNING: &str = "running";
pub const DONE: &str = "done";
pub const FAILED: &str = "failed";
/// Kinly closed (or crashed) before the download finished; its partial file was removed.
pub const INTERRUPTED: &str = "interrupted";
/// Finished, but the file is no longer there (moved or deleted outside Kinly). Never stored.
pub const MISSING: &str = "missing";

/// What the download is, for the Downloads page. All optional; shown as given.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub meta_id: Option<String>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub season: Option<u32>,
    #[serde(default)]
    pub episode: Option<u32>,
}

impl Info {
    fn bounded(self) -> Self {
        let cut = |s: Option<String>, n: usize| s.map(|s| s.chars().take(n).collect::<String>()).filter(|s| !s.trim().is_empty());
        Info { title: cut(self.title, 200), meta_id: cut(self.meta_id, 200), kind: cut(self.kind, 20), season: self.season, episode: self.episode }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: u64,
    /// File name of the finished file.
    pub name: String,
    /// Full path of the finished file (the partial file is this plus `.part`).
    pub path: String,
    pub received: u64,
    /// From Content-Length; 0 when the server does not say.
    pub total: u64,
    pub state: String,
    #[serde(default)]
    pub error: Option<String>,
    /// Unix seconds.
    pub created: u64,
    #[serde(default)]
    pub finished: Option<u64>,
    #[serde(default)]
    pub info: Info,
}

#[derive(Serialize, Deserialize, Default)]
struct Db {
    v: u32,
    records: Vec<Record>,
}

#[derive(Default)]
struct Inner {
    records: BTreeMap<u64, Record>,
    cancels: HashMap<u64, Arc<AtomicBool>>,
}

/// The download records, kept in memory and saved on every state change.
pub struct Downloader {
    db: Option<PathBuf>,
    inner: Mutex<Inner>,
    next: AtomicU64,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn part_of(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(".part");
    PathBuf::from(s)
}

impl Downloader {
    /// Loads `db` (a missing or unreadable file starts empty; an unreadable one is kept aside).
    /// Downloads that were running when Kinly last stopped become "interrupted" and their partial
    /// files are removed.
    pub fn load(db: PathBuf) -> Self {
        let parsed: Option<Db> = std::fs::read(&db).ok().and_then(|b| match serde_json::from_slice(&b) {
            Ok(d) => Some(d),
            Err(e) => {
                let aside = db.with_extension(format!("corrupt-{}.json", now_secs()));
                log_warn!("downloads", "downloads.json is unreadable ({e}); moved to {}", aside.display());
                let _ = std::fs::rename(&db, &aside);
                None
            }
        });
        let mut inner = Inner::default();
        let mut changed = false;
        for mut r in parsed.map(|d| d.records).unwrap_or_default() {
            if r.state == RUNNING {
                let _ = std::fs::remove_file(part_of(Path::new(&r.path)));
                r.state = INTERRUPTED.into();
                r.error = Some("Kinly closed before the download finished.".into());
                changed = true;
            }
            inner.records.insert(r.id, r);
        }
        let next = inner.records.keys().next_back().copied().unwrap_or(0);
        let d = Downloader { db: Some(db), inner: Mutex::new(inner), next: AtomicU64::new(next) };
        if changed {
            if let Ok(i) = d.inner.lock() {
                d.save(&i);
            }
        }
        d
    }

    /// Not persisted (tests).
    pub fn in_memory() -> Self {
        Downloader { db: None, inner: Mutex::new(Inner::default()), next: AtomicU64::new(0) }
    }

    fn save(&self, inner: &Inner) {
        let Some(db) = &self.db else { return };
        let doc = Db { v: 1, records: inner.records.values().cloned().collect() };
        match serde_json::to_vec_pretty(&doc) {
            Ok(bytes) => {
                if let Err(e) = crate::store::atomic_write(db, &bytes, true) {
                    log_warn!("downloads", "could not save downloads.json: {e}");
                }
            }
            Err(e) => log_warn!("downloads", "could not encode downloads.json: {e}"),
        }
    }

    fn insert(&self, r: Record, cancel: Arc<AtomicBool>) {
        if let Ok(mut i) = self.inner.lock() {
            i.cancels.insert(r.id, cancel);
            i.records.insert(r.id, r);
            // Oldest finished records go first if the list ever gets very long.
            while i.records.len() > MAX_RECORDS {
                let Some(old) = i.records.iter().find(|(_, r)| r.state != RUNNING).map(|(k, _)| *k) else { break };
                i.records.remove(&old);
            }
            self.save(&i);
        }
    }

    /// Progress only: kept in memory, not written to disk.
    fn set_received(&self, id: u64, received: u64) -> Option<Record> {
        let mut i = self.inner.lock().ok()?;
        let r = i.records.get_mut(&id)?;
        r.received = received;
        Some(r.clone())
    }

    /// Final state of a download: bytes received and where the file ended up, or the error.
    /// `None` removes the record (cancelled).
    fn finish(&self, id: u64, outcome: Option<Result<(u64, PathBuf), String>>) -> Option<Record> {
        let mut i = self.inner.lock().ok()?;
        i.cancels.remove(&id);
        let out = match outcome {
            None => i.records.remove(&id).map(|mut r| {
                r.state = "cancelled".into();
                r
            }),
            Some(res) => {
                let r = i.records.get_mut(&id)?;
                match res {
                    Ok((received, path)) => {
                        r.received = received;
                        r.name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                        r.path = path.display().to_string();
                        r.state = DONE.into();
                        r.error = None;
                    }
                    Err(e) => {
                        r.state = FAILED.into();
                        r.error = Some(e);
                    }
                }
                r.finished = Some(now_secs());
                Some(r.clone())
            }
        };
        self.save(&i);
        out
    }

    /// All records, newest first; finished files that are gone are reported as "missing".
    pub fn list(&self) -> Vec<Record> {
        let Ok(i) = self.inner.lock() else { return vec![] };
        i.records
            .values()
            .rev()
            .map(|r| {
                let mut r = r.clone();
                if r.state == DONE && !Path::new(&r.path).is_file() {
                    r.state = MISSING.into();
                }
                r
            })
            .collect()
    }

    /// True when `path` is (or will be) a file Kinly downloaded.
    pub fn is_managed(&self, path: &str) -> bool {
        self.inner.lock().map(|i| i.records.values().any(|r| same_path(&r.path, path))).unwrap_or(false)
    }

    /// Cancels a running download; removes the record of one that failed or was interrupted.
    pub fn cancel(&self, id: u64) {
        let Ok(mut i) = self.inner.lock() else { return };
        let state = i.records.get(&id).map(|r| r.state.clone());
        match state.as_deref() {
            Some(RUNNING) => {
                if let Some(c) = i.cancels.get(&id) {
                    c.store(true, Ordering::Relaxed);
                }
            }
            Some(FAILED) | Some(INTERRUPTED) => {
                i.records.remove(&id);
                self.save(&i);
            }
            _ => {}
        }
    }

    /// Deletes a finished (or missing) download's file and its record. Refuses running downloads
    /// and the file that is playing. Only the recorded path is touched, and only if it is a video
    /// file; a file that is already gone just loses its record.
    pub fn delete(&self, id: u64, playing: Option<&str>) -> Result<(), String> {
        let mut i = self.inner.lock().map_err(|_| "Downloads are busy. Try again.".to_string())?;
        let r = i.records.get(&id).cloned().ok_or("This download is no longer listed.")?;
        if r.state == RUNNING {
            return Err("This download is still running. Cancel it first.".into());
        }
        if playing.is_some_and(|p| same_path(p, &r.path)) {
            return Err("This video is playing. Close the player first.".into());
        }
        let path = PathBuf::from(&r.path);
        if !path.is_absolute() || !is_video(&path) || r.path.contains('\0') {
            return Err("Kinly won't delete this file because its recorded location is not valid.".into());
        }
        match std::fs::symlink_metadata(&path) {
            Ok(m) if m.is_dir() => return Err("Kinly won't delete a folder.".into()),
            Ok(_) => std::fs::remove_file(&path).map_err(|e| format!("Couldn't delete the file: {e}"))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Couldn't reach the file: {e}")),
        }
        let _ = std::fs::remove_file(part_of(&path));
        i.records.remove(&id);
        self.save(&i);
        log_info!("downloads", "deleted {}", r.name);
        Ok(())
    }

    /// Stops running downloads when the app exits and removes their partial files (best effort:
    /// the tasks don't get to clean up after the runtime stops). They load as "interrupted".
    pub fn cancel_all(&self) {
        let Ok(i) = self.inner.lock() else { return };
        for r in i.records.values().filter(|r| r.state == RUNNING) {
            if let Some(c) = i.cancels.get(&r.id) {
                c.store(true, Ordering::Relaxed);
            }
            let _ = std::fs::remove_file(part_of(Path::new(&r.path)));
        }
    }
}

/// Path equality as the OS sees it: case-insensitive on Windows, `file://` prefix ignored.
pub fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let s = s.strip_prefix("file://").unwrap_or(s);
        if cfg!(windows) {
            s.replace('/', "\\").to_lowercase()
        } else {
            s.to_string()
        }
    };
    norm(a) == norm(b)
}

fn is_video(p: &Path) -> bool {
    p.file_name().and_then(|n| video_ext(&n.to_string_lossy())).is_some()
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

/// Numbered names tried for one title before giving up: `<stem>.<ext>`, `<stem> (2).<ext>` …
const MAX_COPIES: u32 = 999;

/// `<dir>/<stem>.<ext>`, then `<stem> (2).<ext>` … `<stem> (999).<ext>`.
fn candidates<'a>(dir: &'a Path, stem: &'a str, ext: &'a str) -> impl Iterator<Item = PathBuf> + 'a {
    std::iter::once(dir.join(format!("{stem}.{ext}"))).chain((2..=MAX_COPIES).map(move |n| dir.join(format!("{stem} ({n}).{ext}"))))
}

/// True when something (a file, folder or link, even a broken one) has this name.
fn taken(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

fn too_many(stem: &str) -> String {
    format!("The download folder already has too many files named “{stem}”. Move or rename some of them and try again.")
}

/// Picks the first free name and creates its `.part` file. A name is free when neither the file
/// nor its `.part` exists; the `.part` is created with `create_new`, so two downloads never share a
/// file and an existing file (or a link planted under that name) is never opened.
pub fn reserve(dir: &Path, stem: &str, ext: &str) -> Result<(PathBuf, std::fs::File), String> {
    for path in candidates(dir, stem, ext) {
        if taken(&path) {
            continue;
        }
        match std::fs::OpenOptions::new().write(true).create_new(true).open(part_of(&path)) {
            Ok(f) => return Ok((path, f)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Could not create the file: {e}")),
        }
    }
    Err(too_many(stem))
}

/// Moves a finished `.part` file to `path`. If a file of that name appeared during the download
/// (renaming would replace it), the next free name is used instead. Returns where the file is.
fn complete(part: &Path, path: &Path, stem: &str, ext: &str) -> Result<PathBuf, String> {
    let dir = path.parent().ok_or("Could not finish the file: no folder")?;
    let target = std::iter::once(path.to_path_buf())
        .chain(candidates(dir, stem, ext))
        .find(|p| !taken(p) && (p == path || !taken(&part_of(p))))
        .ok_or_else(|| too_many(stem))?;
    std::fs::rename(part, &target).map_err(|e| format!("Could not finish the file: {e}"))?;
    Ok(target)
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

/// The default download folder: the platform's Videos folder (the Videos known folder on Windows,
/// XDG_VIDEOS_DIR on Linux), else `~/Videos`, else the Downloads folder.
pub fn default_dir() -> Option<PathBuf> {
    if let Some(d) = dirs::video_dir().filter(|d| d.is_dir()) {
        return Some(d);
    }
    #[cfg(target_os = "linux")]
    if let Ok(out) = std::process::Command::new("xdg-user-dir").arg("VIDEOS").output() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let p = PathBuf::from(&s);
        if !s.is_empty() && p.is_dir() && Some(p.as_path()) != dirs::home_dir().as_deref() {
            return Some(p);
        }
    }
    dirs::home_dir().map(|h| h.join("Videos")).or_else(crate::local::download_dir)
}

/// Makes sure `dir` is an absolute folder Kinly can write to (creating it if needed).
pub fn ensure_writable(dir: &Path) -> Result<(), String> {
    if !dir.is_absolute() {
        return Err("Choose a full folder path.".into());
    }
    if dir.exists() && !dir.is_dir() {
        return Err("That location is a file, not a folder.".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("Kinly can't create this folder: {e}"))?;
    // A new, empty probe file: `create_new` never opens (or truncates) anything already there,
    // including a link planted under the same name, so only the probe itself is removed.
    for i in 0..64 {
        let probe = dir.join(format!(".kinly-write-test-{}-{i}", std::process::id()));
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
            Ok(f) => {
                drop(f);
                let _ = std::fs::remove_file(&probe);
                return Ok(());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Kinly can't write to this folder: {e}")),
        }
    }
    Err("Kinly can't write to this folder: too many leftover test files.".into())
}

fn resolve_dir(dir: Option<String>) -> Result<PathBuf, String> {
    let dir = match dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => default_dir().ok_or("No Videos or Downloads folder was found. Choose a download folder in Settings → Library.")?,
    };
    ensure_writable(&dir)?;
    Ok(dir)
}

#[tauri::command]
pub fn download_default_dir() -> Option<String> {
    default_dir().map(|d| d.display().to_string())
}

/// Checks a folder chosen as the download location; returns it as Kinly will use it.
#[tauri::command]
pub async fn download_dir_check(dir: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let p = PathBuf::from(dir.trim());
        ensure_writable(&p).map(|_| p.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn download_start(
    app: AppHandle,
    state: State<'_, Downloader>,
    url: String,
    name: String,
    headers: Option<HashMap<String, String>>,
    dir: Option<String>,
    info: Option<Info>,
) -> Result<Record, String> {
    let parsed = crate::net::check_url(&url)?;
    let dir = tokio::task::spawn_blocking(move || resolve_dir(dir)).await.map_err(|e| e.to_string())??;
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
    let ext = pick_ext(&name, parsed.path(), &ctype);
    let stem = stem_of(&name).to_string();
    let stem2 = stem.clone();
    let (path, file) = tokio::task::spawn_blocking(move || reserve(&dir, &stem2, ext)).await.map_err(|e| e.to_string())??;
    let file = tokio::fs::File::from_std(file);
    let part = part_of(&path);

    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    let record = Record {
        id,
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        path: path.display().to_string(),
        received: 0,
        total: resp.content_length().unwrap_or(0),
        state: RUNNING.into(),
        error: None,
        created: now_secs(),
        finished: None,
        info: info.unwrap_or_default().bounded(),
    };
    state.insert(record.clone(), cancel.clone());
    log_info!("downloads", "start {}: {}", id, crate::logging::redact(&url));

    tauri::async_runtime::spawn(async move {
        let result = copy(resp, file, id, &cancel, &app).await;
        let outcome = match result {
            Ok(n) => {
                let (part, path) = (part.clone(), path.clone());
                tokio::task::spawn_blocking(move || complete(&part, &path, &stem, ext))
                    .await
                    .map_err(|e| e.to_string())
                    .and_then(|r| r)
                    .map(|done| (n, done))
            }
            Err(e) => Err(e),
        };
        if outcome.is_err() {
            let _ = tokio::fs::remove_file(&part).await;
        }
        let outcome = match outcome {
            Err(_) if cancel.load(Ordering::Relaxed) => None,
            Err(e) => {
                log_warn!("downloads", "{id} failed: {e}");
                Some(Err(e))
            }
            Ok(n) => Some(Ok(n)),
        };
        if let Some(r) = app.state::<Downloader>().finish(id, outcome) {
            let _ = app.emit("downloads:progress", r);
        }
    });
    Ok(record)
}

async fn copy(mut resp: reqwest::Response, file: tokio::fs::File, id: u64, cancel: &AtomicBool, app: &AppHandle) -> Result<u64, String> {
    let total = resp.content_length().unwrap_or(0);
    let mut out = tokio::io::BufWriter::with_capacity(1 << 20, file);
    let mut received = 0u64;
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
        received += chunk.len() as u64;
        if last.elapsed() >= EMIT_EVERY {
            last = Instant::now();
            if let Some(r) = app.state::<Downloader>().set_received(id, received) {
                let _ = app.emit("downloads:progress", r);
            }
        }
    }
    out.flush().await.map_err(|e| format!("Could not write the file: {e}"))?;
    if total > 0 && received < total {
        return Err("The download ended early.".into());
    }
    Ok(received)
}

/// Cancels a running download, or dismisses a failed or interrupted one.
#[tauri::command]
pub fn download_cancel(state: State<'_, Downloader>, id: u64) {
    state.cancel(id);
}

/// Every download Kinly has made, newest first.
#[tauri::command]
pub fn downloads_managed(state: State<'_, Downloader>) -> Vec<Record> {
    state.list()
}

/// Deletes a finished download's file (see `Downloader::delete`).
#[tauri::command]
pub async fn download_delete(app: AppHandle, id: u64) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let playing = crate::player::playing_local();
        app.state::<Downloader>().delete(id, playing.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kinly-dl-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn rec(id: u64, path: &Path, state: &str) -> Record {
        Record {
            id,
            name: path.file_name().unwrap().to_string_lossy().into_owned(),
            path: path.display().to_string(),
            received: 1,
            total: 1,
            state: state.into(),
            error: None,
            created: 1,
            finished: None,
            info: Info::default(),
        }
    }

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
    fn reserved_names_are_unique() {
        let dir = tmp("unique");
        let (first, _f) = reserve(&dir, "a", "mkv").unwrap();
        assert_eq!(first, dir.join("a.mkv"));
        assert!(part_of(&first).is_file());
        // A second download of the same title while the first runs gets its own file.
        assert_eq!(reserve(&dir, "a", "mkv").unwrap().0, dir.join("a (2).mkv"));
        std::fs::write(dir.join("a (3).mkv"), b"keep").unwrap();
        assert_eq!(reserve(&dir, "a", "mkv").unwrap().0, dir.join("a (4).mkv"));
        assert_eq!(std::fs::read(dir.join("a (3).mkv")).unwrap(), b"keep");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn running_out_of_names_is_an_error_not_an_overwrite() {
        let dir = tmp("exhaust");
        std::fs::write(dir.join("a.mkv"), b"original").unwrap();
        for n in 2..=MAX_COPIES {
            std::fs::write(dir.join(format!("a ({n}).mkv")), b"x").unwrap();
        }
        let err = reserve(&dir, "a", "mkv").unwrap_err();
        assert!(err.contains("too many files named"), "{err}");
        assert_eq!(std::fs::read(dir.join("a.mkv")).unwrap(), b"original");
        assert!(!part_of(&dir.join("a.mkv")).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn finishing_never_replaces_a_file_that_appeared_meanwhile() {
        let dir = tmp("complete");
        let (path, f) = reserve(&dir, "a", "mkv").unwrap();
        drop(f);
        std::fs::write(part_of(&path), b"downloaded").unwrap();
        // Another program saved a file under the same name during the download.
        std::fs::write(&path, b"someone else's").unwrap();
        let done = complete(&part_of(&path), &path, "a", "mkv").unwrap();
        assert_eq!(done, dir.join("a (2).mkv"));
        assert_eq!(std::fs::read(&path).unwrap(), b"someone else's");
        assert_eq!(std::fs::read(&done).unwrap(), b"downloaded");
        // The usual case: the reserved name is still free.
        let (p2, f2) = reserve(&dir, "b", "mp4").unwrap();
        drop(f2);
        assert_eq!(complete(&part_of(&p2), &p2, "b", "mp4").unwrap(), p2);
        assert!(p2.is_file() && !part_of(&p2).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_write_check_leaves_existing_files_alone() {
        let dir = tmp("probe");
        // Files under the probe's names (left over, or planted) are neither emptied nor removed.
        for i in 0..3 {
            std::fs::write(dir.join(format!(".kinly-write-test-{}-{i}", std::process::id())), b"data").unwrap();
        }
        assert!(ensure_writable(&dir).is_ok());
        for i in 0..3 {
            assert_eq!(std::fs::read(dir.join(format!(".kinly-write-test-{}-{i}", std::process::id()))).unwrap(), b"data");
        }
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 3, "the probe itself is removed");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_write_check_does_not_follow_links() {
        let dir = tmp("probelink");
        let victim = dir.join("victim.txt");
        std::fs::write(&victim, b"precious").unwrap();
        std::fs::create_dir_all(dir.join("dl")).unwrap();
        for i in 0..64 {
            std::os::unix::fs::symlink(&victim, dir.join("dl").join(format!(".kinly-write-test-{}-{i}", std::process::id()))).unwrap();
        }
        // Every probe name is a link to someone else's file: the check fails without touching it.
        assert!(ensure_writable(&dir.join("dl")).is_err());
        assert_eq!(std::fs::read(&victim).unwrap(), b"precious");
        let _ = std::fs::remove_file(dir.join("dl").join(format!(".kinly-write-test-{}-0", std::process::id())));
        assert!(ensure_writable(&dir.join("dl")).is_ok());
        assert_eq!(std::fs::read(&victim).unwrap(), b"precious");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn headers_filtered() {
        assert!(header_ok("Referer", "https://example.com/"));
        assert!(!header_ok("Host", "evil"));
        assert!(!header_ok("X-A", "a\r\nB: c"));
        assert!(!header_ok("Bad Name", "v"));
    }

    #[test]
    fn writable_folders() {
        let dir = tmp("writable");
        assert!(ensure_writable(&dir.join("new/sub")).is_ok());
        assert!(dir.join("new/sub").is_dir());
        std::fs::write(dir.join("file"), b"x").unwrap();
        assert!(ensure_writable(&dir.join("file")).is_err());
        assert!(ensure_writable(Path::new("relative/dir")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn interrupted_downloads_are_cleaned_up_on_load() {
        let dir = tmp("load");
        let video = dir.join("a.mkv");
        std::fs::write(part_of(&video), b"partial").unwrap();
        let db = dir.join("downloads.json");
        let doc = Db { v: 1, records: vec![rec(7, &video, RUNNING)] };
        std::fs::write(&db, serde_json::to_vec(&doc).unwrap()).unwrap();
        let d = Downloader::load(db.clone());
        let l = d.list();
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].state, INTERRUPTED);
        assert!(!part_of(&video).exists());
        assert_eq!(d.next.load(Ordering::Relaxed), 7);
        // Saved: a second load sees it interrupted too.
        assert_eq!(Downloader::load(db).list()[0].state, INTERRUPTED);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn corrupt_database_is_moved_aside() {
        let dir = tmp("corrupt");
        let db = dir.join("downloads.json");
        std::fs::write(&db, b"{nope").unwrap();
        assert!(Downloader::load(db.clone()).list().is_empty());
        assert!(!db.exists());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn delete_only_touches_recorded_finished_videos() {
        let dir = tmp("delete");
        let d = Downloader::load(dir.join("downloads.json"));
        let done = dir.join("done.mkv");
        std::fs::write(&done, b"v").unwrap();
        let running = dir.join("running.mkv");
        let not_video = dir.join("notes.txt");
        std::fs::write(&not_video, b"keep").unwrap();
        d.insert(rec(1, &done, DONE), Arc::default());
        d.insert(rec(2, &running, RUNNING), Arc::default());
        d.insert(rec(3, &not_video, DONE), Arc::default());

        // Playing, running, or not a video: refused and untouched.
        assert!(d.delete(1, Some(&done.display().to_string())).is_err());
        assert!(done.exists());
        assert!(d.delete(2, None).unwrap_err().contains("running"));
        assert!(d.delete(3, None).is_err());
        assert!(not_video.exists());
        assert!(d.delete(99, None).is_err());

        d.delete(1, None).unwrap();
        assert!(!done.exists());
        assert!(d.list().iter().all(|r| r.id != 1));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_files_and_dismissal() {
        let dir = tmp("missing");
        let d = Downloader::in_memory();
        let gone = dir.join("gone.mp4");
        d.insert(rec(1, &gone, DONE), Arc::default());
        assert_eq!(d.list()[0].state, MISSING);
        assert!(d.is_managed(&gone.display().to_string()));
        // A missing file's record can still be removed.
        d.delete(1, None).unwrap();
        assert!(d.list().is_empty());

        d.insert(rec(2, &gone, FAILED), Arc::default());
        d.cancel(2);
        assert!(d.list().is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn finishing_and_cancelling() {
        let d = Downloader::in_memory();
        let p = std::env::temp_dir().join("kinly-finish.mkv");
        d.insert(rec(1, &p, RUNNING), Arc::default());
        assert_eq!(d.set_received(1, 50).unwrap().received, 50);
        assert_eq!(d.finish(1, Some(Err("broke".into()))).unwrap().state, FAILED);
        // A finished download records where the file ended up.
        d.insert(rec(3, &p, RUNNING), Arc::default());
        let moved = std::env::temp_dir().join("kinly-finish (2).mkv");
        let r = d.finish(3, Some(Ok((9, moved.clone())))).unwrap();
        assert_eq!((r.state.as_str(), r.received, r.name.as_str()), (DONE, 9, "kinly-finish (2).mkv"));
        assert_eq!(r.path, moved.display().to_string());
        d.insert(rec(2, &p, RUNNING), Arc::default());
        assert_eq!(d.finish(2, None).unwrap().state, "cancelled");
        assert!(d.list().iter().all(|r| r.id != 2));
    }

    #[test]
    fn path_equality() {
        assert!(same_path("file:///a/b.mkv", "/a/b.mkv"));
        assert!(!same_path("/a/b.mkv", "/a/c.mkv"));
        #[cfg(windows)]
        assert!(same_path(r"C:\Users\A\v.mkv", "c:/users/a/V.MKV"));
    }
}
