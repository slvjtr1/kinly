//! Subtitle preparation: fetch (or read) a subtitle once, decode it to UTF-8,
//! parse cue timings, check its real language, and cache the normalized file
//! for mpv. Cue intervals stay in memory for Auto Sync.

pub mod detect;
pub mod parse;

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

const MAX_SUB_BYTES: usize = 8 * 1024 * 1024;
pub const SUB_EXTS: &[&str] = &["srt", "vtt", "ass", "ssa"];

pub struct SubCache {
    dir: PathBuf,
    intervals: Mutex<HashMap<String, Vec<(f32, f32)>>>,
}

impl SubCache {
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        prune(&dir, 400);
        SubCache { dir, intervals: Mutex::new(HashMap::new()) }
    }

    pub fn intervals(&self, path: &str) -> Option<Vec<(f32, f32)>> {
        self.intervals.lock().ok()?.get(path).cloned()
    }

    /// Write a retimed copy of a prepared subtitle next to it and return its path.
    /// Used by Auto Sync for corrections mpv cannot express (a different offset
    /// per segment). `map(cue_start) = (ratio, offset)`.
    pub fn write_retimed(&self, path: &str, tag: &str, map: impl Fn(f32) -> (f32, f32)) -> Result<String, String> {
        if self.intervals(path).is_none() {
            return Err("subtitle is not prepared; reload it".into());
        }
        let src = Path::new(path);
        let text = std::fs::read_to_string(src).map_err(|e| format!("read subtitle: {e}"))?;
        let format = parse::detect_format(&text).ok_or("not a recognised subtitle format")?;
        let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let tag: String = tag.chars().filter(char::is_ascii_alphanumeric).take(24).collect();
        let out = self.dir.join(format!("{stem}.sync-{tag}.{}", format.ext()));
        crate::store::atomic_write(&out, parse::retime(&text, format, map).as_bytes(), false)
            .map_err(|e| format!("cache write: {e}"))?;
        Ok(out.display().to_string())
    }
}

/// Keep the cache bounded: drop the oldest files beyond `keep`.
fn prune(dir: &Path, keep: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = rd
        .flatten()
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort();
    for (_, p) in files.iter().take(files.len() - keep) {
        let _ = std::fs::remove_file(p);
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreparedSub {
    pub path: String,
    pub format: parse::SubFormat,
    pub encoding: &'static str,
    pub cue_count: usize,
    pub first_cue_sec: f32,
    pub last_cue_sec: f32,
    pub content: detect::ContentInfo,
}

pub fn prepare_bytes(cache: &SubCache, key: &str, bytes: &[u8]) -> Result<PreparedSub, String> {
    if bytes.starts_with(b"PK\x03\x04") {
        return Err("subtitle is a zip archive (unsupported)".into());
    }
    let (text, encoding) = parse::decode(bytes);
    let format = parse::detect_format(&text).ok_or("not a recognised subtitle format")?;
    let cues = parse::parse(&text, format);
    if cues.is_empty() {
        return Err("subtitle has no cues".into());
    }
    let digest = hex(&Sha256::digest(key.as_bytes())[..12]);
    let out = cache.dir.join(format!("{digest}.{}", format.ext()));
    crate::store::atomic_write(&out, text.as_bytes(), false).map_err(|e| format!("cache write: {e}"))?;
    let path = out.display().to_string();
    let content = detect::analyze(&cues);
    let prepared = PreparedSub {
        path: path.clone(),
        format,
        encoding,
        cue_count: cues.len(),
        first_cue_sec: cues.first().map(|c| c.start).unwrap_or(0.0),
        last_cue_sec: cues.iter().map(|c| c.end).fold(0.0, f32::max),
        content,
    };
    if let Ok(mut m) = cache.intervals.lock() {
        if m.len() > 64 {
            m.clear();
        }
        m.insert(path, parse::dialogue_intervals(&cues));
    }
    Ok(prepared)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[tauri::command]
pub async fn subs_fetch(cache: State<'_, SubCache>, url: String) -> Result<PreparedSub, String> {
    let bytes = crate::net::fetch_bytes(&url, Duration::from_secs(20)).await?;
    if bytes.len() > MAX_SUB_BYTES {
        return Err("subtitle too large".into());
    }
    prepare_bytes(&cache, &url, &bytes)
}

#[tauri::command]
pub async fn subs_load_local(cache: State<'_, SubCache>, path: String) -> Result<PreparedSub, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path}: not a file"));
    }
    if meta.len() as usize > MAX_SUB_BYTES {
        return Err("subtitle too large".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("read subtitle: {e}"))?;
    prepare_bytes(&cache, &format!("file:{path}:{}", meta.len()), &bytes)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Sidecar {
    pub path: String,
    pub name: String,
    /// Lower-cased tokens after the video's stem, e.g. ["ar", "forced"].
    pub tokens: Vec<String>,
}

/// Subtitle files next to a local video: `<stem>*.srt` in the same folder, or any
/// subtitle inside `Subs/` or `Subtitles/` beside it.
#[tauri::command]
pub fn subs_find_sidecars(video_path: String) -> Vec<Sidecar> {
    find_sidecars(Path::new(&video_path))
}

pub fn find_sidecars(video: &Path) -> Vec<Sidecar> {
    let Some(dir) = video.parent() else { return vec![] };
    let stem = video.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut out = Vec::new();
    let mut scan = |d: &Path, require_stem: bool| {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let Some(ext) = p.extension().map(|x| x.to_string_lossy().to_lowercase()) else { continue };
            if !SUB_EXTS.contains(&ext.as_str()) {
                continue;
            }
            let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let fstem = p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
            if require_stem && !fstem.starts_with(&stem) {
                continue;
            }
            let rest = if fstem.starts_with(&stem) { &fstem[stem.len()..] } else { fstem.as_str() };
            let tokens = rest
                .split(|c: char| c == '.' || c == '_' || c == '-' || c == ' ' || c == '[' || c == ']')
                .filter(|t| !t.is_empty())
                .map(|t| t.to_string())
                .collect();
            out.push(Sidecar { path: p.display().to_string(), name, tokens });
        }
    };
    scan(dir, true);
    for d in crate::paths::unique_dirs(["Subs", "subs", "Subtitles", "subtitles"].map(|s| dir.join(s))) {
        scan(&d, false);
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.dedup_by(|a, b| a.path == b.path);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_sidecars_with_language_tokens() {
        let dir = std::env::temp_dir().join(format!("kinly-sidecar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Subs")).unwrap();
        let video = dir.join("Movie.2020.1080p.mkv");
        std::fs::write(&video, b"").unwrap();
        std::fs::write(dir.join("Movie.2020.1080p.ar.srt"), b"").unwrap();
        std::fs::write(dir.join("Movie.2020.1080p.eng.forced.srt"), b"").unwrap();
        std::fs::write(dir.join("Other.Film.srt"), b"").unwrap();
        std::fs::write(dir.join("Subs").join("2_Arabic.srt"), b"").unwrap();
        let found = find_sidecars(&video);
        let tokens: Vec<_> = found.iter().map(|s| s.tokens.join(",")).collect();
        assert_eq!(found.len(), 3, "{found:?}");
        assert!(tokens.contains(&"ar".to_string()));
        assert!(tokens.contains(&"eng,forced".to_string()));
        assert!(tokens.contains(&"2,arabic".to_string()));
    }

    #[test]
    fn prepare_rejects_html_error_pages() {
        let cache = SubCache::new(std::env::temp_dir().join(format!("kinly-subcache-{}", std::process::id())));
        assert!(prepare_bytes(&cache, "k", b"<html>Not found</html>").is_err());
        let ok = prepare_bytes(&cache, "k2", "1\n00:00:01,000 --> 00:00:02,000\nمرحبا\n".as_bytes()).unwrap();
        assert_eq!(ok.cue_count, 1);
        assert_eq!(ok.content.language, Some("ara"));
        assert!(cache.intervals(&ok.path).is_some());
        let re = cache.write_retimed(&ok.path, "t1", |_| (1.0, 2.5)).unwrap();
        let cues = parse::parse(&std::fs::read_to_string(&re).unwrap(), parse::SubFormat::Srt);
        assert!((cues[0].start - 3.5).abs() < 1e-3, "{cues:?}");
        assert!(cache.write_retimed("/etc/passwd", "x", |_| (1.0, 0.0)).is_err());
    }
}
