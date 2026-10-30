//! Helper programs Kinly runs: ffmpeg (Auto Sync) and yt-dlp (trailers).
//!
//! Lookup order: next to the Kinly executable (the Windows installers put
//! `ffmpeg.exe` and `yt-dlp.exe` there, see tauri.windows.conf.json; an
//! AppImage may too), then `PATH`. On Windows the `.exe` suffix is added and
//! console programs are started without a console window.
//! When a tool is missing the feature that needs it reports itself as
//! unavailable (`app_info` exposes `ffmpeg` / `ytdlp` flags to the UI).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// `CREATE_NO_WINDOW`: a console program started from the GUI gets no console.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The file name of a program on this OS (`ffmpeg` -> `ffmpeg.exe` on Windows).
pub fn exe_name(name: &str) -> String {
    if cfg!(windows) && !name.to_ascii_lowercase().ends_with(".exe") {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Candidate paths, most preferred first (pure; tested on every OS).
fn candidates(exe_dir: Option<&Path>, path_var: Option<&OsStr>, file: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = exe_dir.map(|d| d.join(file)).into_iter().collect();
    if let Some(p) = path_var {
        out.extend(std::env::split_paths(p).filter(|d| !d.as_os_str().is_empty()).map(|d| d.join(file)));
    }
    out
}

/// Bundled copy first, then `PATH`.
pub fn locate(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok();
    let dir = exe.as_deref().and_then(Path::parent);
    let path = std::env::var_os("PATH");
    candidates(dir, path.as_deref(), &exe_name(name)).into_iter().find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_suffix_only_on_windows() {
        let want = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
        assert_eq!(exe_name("ffmpeg"), want);
        assert_eq!(exe_name("yt-dlp.exe"), "yt-dlp.exe");
    }

    #[test]
    fn bundled_copy_wins_over_path() {
        let path = std::env::join_paths([PathBuf::from("/opt/a"), PathBuf::from("/usr/bin")]).unwrap();
        let c = candidates(Some(Path::new("/app")), Some(&path), "ffmpeg");
        assert_eq!(c, vec![PathBuf::from("/app/ffmpeg"), PathBuf::from("/opt/a/ffmpeg"), PathBuf::from("/usr/bin/ffmpeg")]);
        assert!(candidates(None, None, "ffmpeg").is_empty());
    }

    #[test]
    fn finds_a_real_file() {
        let dir = std::env::temp_dir().join(format!("kinly-tools-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join(exe_name("kinly-fake-tool"));
        std::fs::write(&f, b"").unwrap();
        let path = std::env::join_paths([dir.clone()]).unwrap();
        let hit = candidates(None, Some(&path), &exe_name("kinly-fake-tool")).into_iter().find(|p| p.is_file());
        assert_eq!(hit, Some(f));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
