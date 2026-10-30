//! Trailers: resolves a YouTube trailer to direct stream URLs with yt-dlp, so it plays in
//! Kinly's own player. The embedded libmpv runs with `ytdl=no`, `config=no` and no scripts, so
//! mpv's ytdl hook is never loaded; resolution happens here instead, with a fixed argument list,
//! a validated video id and a time budget. The UI falls back to an in-app YouTube embed when this
//! fails (yt-dlp missing, outdated, or the stream is refused).

use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

/// Best video and audio up to 1080p (two URLs), else the best single file up to 1080p, else any.
const FORMAT: &str = "bv*[height<=1080]+ba/b[height<=1080]/b";
const BUDGET: Duration = Duration::from_secs(35);
/// yt-dlp player clients to try in order. `None` is yt-dlp's own default; `mweb` still yields
/// formats on older yt-dlp releases where the default clients return none.
const CLIENTS: [Option<&str>; 2] = [None, Some("mweb")];
pub const MISSING: &str = "ytdlp-missing";

#[derive(Serialize, Debug, PartialEq)]
pub struct TrailerStream {
    pub video: String,
    /// Separate audio track (merged formats); added with `audio-add` after the video loads.
    pub audio: Option<String>,
}

/// A YouTube video id: exactly 11 characters of [A-Za-z0-9_-].
pub fn valid_yt_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The yt-dlp executable: PATH first, then the usual install locations.
pub fn find_ytdlp() -> Option<PathBuf> {
    let name = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
    #[allow(unused_mut)]
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    #[cfg(unix)]
    {
        dirs.push("/usr/bin".into());
        dirs.push("/usr/local/bin".into());
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join(".local/bin"));
        }
    }
    dirs.into_iter()
        .map(|d| d.join(name))
        .find(|p| p.is_file())
        // The copy the Windows installers put next to Kinly.exe (see tools.rs).
        .or_else(|| crate::tools::locate("yt-dlp"))
}

/// Parses `yt-dlp -g` output: one https URL per line, video first, then audio for merged formats.
pub fn parse_urls(stdout: &str) -> Option<TrailerStream> {
    let mut urls = stdout
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("https://") && l.len() <= 8192 && crate::net::check_url(l).is_ok())
        .map(str::to_string);
    let video = urls.next()?;
    Some(TrailerStream { video, audio: urls.next() })
}

async fn run(bin: &PathBuf, id: &str, client: Option<&str>, timeout: Duration) -> Result<TrailerStream, String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(["--ignore-config", "--no-playlist", "--no-warnings", "--quiet", "--socket-timeout", "15", "-g", "-f", FORMAT]);
    if let Some(c) = client {
        cmd.arg("--extractor-args").arg(format!("youtube:player_client={c}"));
    }
    cmd.arg("--").arg(format!("https://www.youtube.com/watch?v={id}"));
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let out = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| "yt-dlp timed out".to_string())?
        .map_err(|e| format!("yt-dlp could not start: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("failed").trim();
        return Err(format!("yt-dlp: {}", line.chars().take(200).collect::<String>()));
    }
    parse_urls(&String::from_utf8_lossy(&out.stdout)).ok_or_else(|| "yt-dlp returned no stream".to_string())
}

/// True when the stream server answers a one-byte ranged request (YouTube refuses some
/// resolved URLs with 403, which mpv would only report after a long wait).
async fn reachable(url: &str) -> bool {
    let Ok(parsed) = crate::net::check_url(url) else { return false };
    crate::net::client()
        .get(parsed)
        .header(reqwest::header::RANGE, "bytes=0-1")
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Consecutive trailers yt-dlp could not resolve to a playable stream. After a few, this session
/// stops trying (an outdated yt-dlp fails every time) and the UI goes straight to the embed.
static FAILURES: AtomicU32 = AtomicU32::new(0);
const GIVE_UP_AFTER: u32 = 2;
pub const UNAVAILABLE: &str = "ytdlp-unavailable";

/// Tries each player client within the time budget.
async fn attempt(bin: &PathBuf, yt_id: &str) -> Result<TrailerStream, String> {
    let start = Instant::now();
    let mut last = String::from("no playable stream");
    for client in CLIENTS {
        let left = BUDGET.saturating_sub(start.elapsed());
        if left < Duration::from_secs(3) {
            break;
        }
        match run(bin, yt_id, client, left.min(Duration::from_secs(25))).await {
            Ok(s) => {
                // Video first: when it is refused, the audio (same host) is not probed.
                let ok = reachable(&s.video).await && match &s.audio {
                    Some(a) => reachable(a).await,
                    None => true,
                };
                if ok {
                    crate::log_info!("trailer", "resolved {yt_id} (client {})", client.unwrap_or("default"));
                    return Ok(s);
                }
                last = "the trailer stream was refused".into();
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// Resolves a YouTube trailer id to playable stream URLs. Uses a recent copy of Kinly's own
/// yt-dlp (see ytdlp.rs), else the bundled or an installed one, and downloads a new copy only when
/// none exists or the one tried fails. Errors with [`MISSING`] when there is none and
/// [`UNAVAILABLE`] once it has kept failing in this session.
#[tauri::command]
pub async fn trailer_resolve(paths: tauri::State<'_, crate::Paths>, yt_id: String) -> Result<TrailerStream, String> {
    if !valid_yt_id(&yt_id) {
        return Err("invalid trailer id".into());
    }
    if FAILURES.load(Ordering::Relaxed) >= GIVE_UP_AFTER {
        return Err(UNAVAILABLE.into());
    }
    let data = paths.data.clone();
    // A recent managed copy first, then the bundled or installed one. A new copy is downloaded
    // only when there is none or the one tried fails (YouTube may have changed), so a fresh
    // install does not fetch and run a program it already ships.
    let managed = super::ytdlp::managed_path(&data);
    let first = super::ytdlp::age(&managed).is_some_and(|a| a < super::ytdlp::STALE).then(|| managed.clone()).or_else(find_ytdlp);
    let mut result = match &first {
        Some(bin) => attempt(bin, &yt_id).await,
        None => Err(MISSING.to_string()),
    };
    if result.is_err() {
        let max_age = if first.is_some() { super::ytdlp::RETRY_AGE } else { super::ytdlp::STALE };
        match super::ytdlp::ensure(&data, max_age).await {
            // Retry unless `ensure` handed back the same copy that just failed, unchanged.
            Ok(fresh) if first.as_ref() != Some(&fresh) || super::ytdlp::age(&fresh).is_some_and(|a| a < Duration::from_secs(120)) => {
                result = attempt(&fresh, &yt_id).await;
            }
            Ok(_) => {}
            Err(e) => crate::log_warn!("trailer", "{e}"),
        }
    }
    match result {
        Ok(s) => {
            FAILURES.store(0, Ordering::Relaxed);
            Ok(s)
        }
        Err(last) => {
            crate::log_warn!("trailer", "{yt_id}: {last}");
            FAILURES.fetch_add(1, Ordering::Relaxed);
            Err(last)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_ids() {
        assert!(valid_yt_id("cdx31ak4KbQ"));
        assert!(valid_yt_id("JE9z-gy4De4"));
        assert!(valid_yt_id("a_b-c_d-e_f"));
        assert!(!valid_yt_id("short"));
        assert!(!valid_yt_id("cdx31ak4KbQx"));
        assert!(!valid_yt_id("--exec=evil"));
        assert!(!valid_yt_id("cdx31ak4Kb "));
        assert!(!valid_yt_id("cdx31ak4Kb/"));
        assert!(!valid_yt_id(""));
    }

    #[test]
    fn parses_ytdlp_output() {
        let two = "https://rr1.googlevideo.com/videoplayback?a=1\nhttps://rr1.googlevideo.com/videoplayback?a=2\n";
        assert_eq!(
            parse_urls(two),
            Some(TrailerStream {
                video: "https://rr1.googlevideo.com/videoplayback?a=1".into(),
                audio: Some("https://rr1.googlevideo.com/videoplayback?a=2".into()),
            })
        );
        let one = "  https://example.com/v.mp4  \n";
        assert_eq!(parse_urls(one).unwrap().audio, None);
        assert_eq!(parse_urls(""), None);
        assert_eq!(parse_urls("WARNING: something\nfile:///etc/passwd\nhttp://plain.example/x\n"), None);
    }
}
