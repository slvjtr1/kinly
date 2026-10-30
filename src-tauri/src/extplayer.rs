//! External players: detect installed players that can pick subtitle and audio
//! tracks, and hand the current media over to one of them.
//!
//! Players are launched directly (no shell) with an argument list built by
//! `build_args`, detached from Kinly, and reaped by a waiter thread.
//!
//! Linux: `PATH`, then Flatpak. Windows: `PATH`, the registry's App Paths
//! (HKCU, then HKLM), then the usual install folders under Program Files and
//! `%LOCALAPPDATA%\Programs` (mpv, VLC, MPC-HC, PotPlayer, SMPlayer).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// How a player takes its options.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Mpv,
    Vlc,
    Celluloid,
    Smplayer,
    Haruna,
    Mplayer,
    /// MPC-HC (Windows).
    MpcHc,
    /// PotPlayer (Windows).
    PotPlayer,
}

// Unix reads `flatpak`, Windows the `win_*` fields.
#[allow(dead_code)]
struct Known {
    kind: Kind,
    name: &'static str,
    /// Player id (`[a-z0-9]+`, stored in settings) and its executable name on Unix.
    bin: &'static str,
    flatpak: Option<&'static str>,
    /// Windows executables, preferred first (PATH and App Paths lookups).
    win_exes: &'static [&'static str],
    /// Windows install locations relative to Program Files / %LOCALAPPDATA%\Programs.
    win_dirs: &'static [&'static str],
}

const KNOWN: &[Known] = &[
    Known {
        kind: Kind::Mpv,
        name: "mpv",
        bin: "mpv",
        flatpak: Some("io.mpv.Mpv"),
        win_exes: &["mpv.exe"],
        win_dirs: &["mpv\\mpv.exe"],
    },
    Known {
        kind: Kind::Vlc,
        name: "VLC",
        bin: "vlc",
        flatpak: Some("org.videolan.VLC"),
        win_exes: &["vlc.exe"],
        win_dirs: &["VideoLAN\\VLC\\vlc.exe"],
    },
    Known {
        kind: Kind::MpcHc,
        name: "MPC-HC",
        bin: "mpchc",
        flatpak: None,
        win_exes: &["mpc-hc64.exe", "mpc-hc.exe"],
        win_dirs: &["MPC-HC\\mpc-hc64.exe", "K-Lite Codec Pack\\MPC-HC64\\mpc-hc64.exe", "MPC-HC\\mpc-hc.exe"],
    },
    Known {
        kind: Kind::PotPlayer,
        name: "PotPlayer",
        bin: "potplayer",
        flatpak: None,
        win_exes: &["PotPlayerMini64.exe", "PotPlayerMini.exe"],
        win_dirs: &["DAUM\\PotPlayer\\PotPlayerMini64.exe", "PotPlayer\\PotPlayerMini64.exe", "DAUM\\PotPlayer\\PotPlayerMini.exe"],
    },
    Known { kind: Kind::Celluloid, name: "Celluloid", bin: "celluloid", flatpak: Some("io.github.celluloid_player.Celluloid"), win_exes: &[], win_dirs: &[] },
    Known {
        kind: Kind::Smplayer,
        name: "SMPlayer",
        bin: "smplayer",
        flatpak: Some("info.smplayer.SMPlayer"),
        win_exes: &["smplayer.exe"],
        win_dirs: &["SMPlayer\\smplayer.exe"],
    },
    Known { kind: Kind::Haruna, name: "Haruna", bin: "haruna", flatpak: Some("org.kde.haruna"), win_exes: &[], win_dirs: &[] },
    Known { kind: Kind::Mplayer, name: "MPlayer", bin: "mplayer", flatpak: None, win_exes: &[], win_dirs: &[] },
];

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ExternalPlayer {
    /// "mpv", "vlc", … for native installs; "flatpak:<app id>" for Flatpak ones.
    pub id: String,
    pub name: String,
    /// Human-readable launch command, e.g. "/usr/bin/mpv" or "flatpak run io.mpv.Mpv".
    pub command: String,
    #[serde(skip)]
    kind: Kind,
    #[serde(skip)]
    program: PathBuf,
    #[serde(skip)]
    prefix: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenArgs {
    pub player: String,
    pub url: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub start_sec: Option<f64>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub subtitles: Option<Vec<String>>,
}

/// Validated launch request.
#[derive(Debug, Default, PartialEq)]
pub struct Launch {
    pub url: String,
    pub local: bool,
    pub title: Option<String>,
    pub start_sec: Option<f64>,
    /// Header name/value pairs, sorted by name for stable argument order.
    pub headers: Vec<(String, String)>,
    pub subtitles: Vec<String>,
}

#[cfg(unix)]
fn find_in_path(bin: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(bin))
        .find(|p| p.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false))
}

#[cfg(windows)]
fn find_in_path(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(exe)).find(|p| p.is_file())
}

/// `HKCU`/`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\<exe>` (default value).
#[cfg(windows)]
fn app_path(exe: &str) -> Option<PathBuf> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ};
    let key = HSTRING::from(format!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{exe}"));
    for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let mut buf = vec![0u16; 1024];
        let mut size = (buf.len() * 2) as u32;
        let rc = unsafe {
            RegGetValueW(
                root,
                &key,
                PCWSTR::null(),
                RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if rc.is_err() {
            continue;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let p = PathBuf::from(String::from_utf16_lossy(&buf[..len]).trim().trim_matches('"'));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Where a known player is installed on Windows: PATH, App Paths, then the usual folders.
#[cfg(windows)]
fn find_windows(k: &Known) -> Option<PathBuf> {
    if let Some(p) = k.win_exes.iter().find_map(|e| find_in_path(e)) {
        return Some(p);
    }
    if let Some(p) = k.win_exes.iter().find_map(|e| app_path(e)) {
        return Some(p);
    }
    let roots: Vec<PathBuf> = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .chain(std::env::var_os("LOCALAPPDATA").map(|l| PathBuf::from(l).join("Programs")))
        .collect();
    windows_candidates(&roots, k.win_dirs).into_iter().find(|p| p.is_file())
}

/// Every root/dir combination, roots first (pure; tested on every OS).
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_candidates(roots: &[PathBuf], dirs: &[&str]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for r in roots {
        for d in dirs {
            let p = r.join(d.replace('\\', std::path::MAIN_SEPARATOR_STR));
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

#[cfg(unix)]
fn flatpak_apps(flatpak: &Path) -> Vec<String> {
    Command::new(flatpak)
        .args(["list", "--app", "--columns=application"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

/// Installed players, natives first, in `KNOWN` order.
#[cfg(windows)]
pub fn detect() -> Vec<ExternalPlayer> {
    KNOWN
        .iter()
        .filter_map(|k| {
            let p = find_windows(k)?;
            Some(ExternalPlayer {
                id: k.bin.to_string(),
                name: k.name.to_string(),
                command: p.display().to_string(),
                kind: k.kind,
                program: p,
                prefix: vec![],
            })
        })
        .collect()
}

/// Installed players, natives first, in `KNOWN` order.
#[cfg(unix)]
pub fn detect() -> Vec<ExternalPlayer> {
    let mut out = Vec::new();
    for k in KNOWN.iter().filter(|k| !matches!(k.kind, Kind::MpcHc | Kind::PotPlayer)) {
        if let Some(p) = find_in_path(k.bin) {
            out.push(ExternalPlayer {
                id: k.bin.to_string(),
                name: k.name.to_string(),
                command: p.display().to_string(),
                kind: k.kind,
                program: p,
                prefix: vec![],
            });
        }
    }
    if let Some(fp) = find_in_path("flatpak") {
        let apps = flatpak_apps(&fp);
        for k in KNOWN {
            let Some(app) = k.flatpak else { continue };
            if apps.iter().any(|a| a == app) {
                out.push(ExternalPlayer {
                    id: format!("flatpak:{app}"),
                    name: format!("{} (Flatpak)", k.name),
                    command: format!("flatpak run {app}"),
                    kind: k.kind,
                    program: fp.clone(),
                    prefix: vec!["run".into(), app.to_string()],
                });
            }
        }
    }
    out
}

fn header_name_ok(k: &str) -> bool {
    !k.is_empty() && k.len() <= 128 && k.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

/// Check and normalise the request. Errors are user-facing.
pub fn validate(args: &OpenArgs) -> Result<Launch, String> {
    let url = args.url.trim();
    let lower = url.to_ascii_lowercase();
    let (url, local) = if lower.starts_with("http://") || lower.starts_with("https://") {
        if url.chars().any(|c| c.is_control() || c == ' ') {
            return Err("The stream address is not valid.".into());
        }
        (url.to_string(), false)
    } else {
        let path = local_path(url);
        let p = Path::new(path);
        if !p.is_absolute() || !p.is_file() {
            return Err("Only web streams (http/https) and existing local files can be opened externally.".into());
        }
        (path.to_string(), true)
    };
    let title = args
        .title
        .as_deref()
        .map(|t| t.chars().filter(|c| !c.is_control()).take(200).collect::<String>())
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let start_sec = args.start_sec.filter(|s| s.is_finite() && *s >= 1.0 && *s < 1.0e7);
    let mut headers: Vec<(String, String)> = args
        .headers
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|(k, v)| header_name_ok(k) && v.len() <= 4096 && !v.contains(['\r', '\n', '\0']))
        .collect();
    headers.sort();
    let mut subtitles = Vec::new();
    for s in args.subtitles.clone().unwrap_or_default().into_iter().take(8) {
        let p = Path::new(&s);
        if !p.is_absolute() || !p.is_file() {
            return Err(format!("Subtitle file not found: {s}"));
        }
        subtitles.push(s);
    }
    Ok(Launch { url, local, title, start_sec, headers, subtitles })
}

/// `file:///C:/x.mkv` -> `C:/x.mkv` on Windows, `file:///x` -> `/x` elsewhere.
fn local_path(url: &str) -> &str {
    let path = url.strip_prefix("file://").unwrap_or(url);
    let b = path.as_bytes();
    if cfg!(windows) && b.len() > 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        return &path[1..];
    }
    path
}

/// `h:mm:ss.mmm`.
fn clock(s: f64) -> String {
    let ms = (s * 1000.0).round() as u64;
    format!("{}:{:02}:{:02}.{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

fn secs(s: f64) -> String {
    format!("{s:.3}")
}

/// mpv-style list values cannot carry the separator; such headers are dropped.
fn header_list(h: &[(String, String)]) -> Option<String> {
    let v: Vec<String> = h.iter().filter(|(k, v)| !k.contains(',') && !v.contains(',')).map(|(k, v)| format!("{k}: {v}")).collect();
    (!v.is_empty()).then(|| v.join(","))
}

fn header<'a>(h: &'a [(String, String)], name: &str) -> Option<&'a str> {
    h.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

/// Arguments after the program (and after `flatpak run <id>`), media last.
/// `flatpak` adds file forwarding so a sandboxed player may read a local file.
pub fn build_args(kind: Kind, l: &Launch, flatpak: bool) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    match kind {
        // Windows players take the media first, then `/switch` options.
        Kind::MpcHc => {
            a.push(l.url.clone());
            if let Some(s) = l.start_sec {
                a.push("/start".into());
                a.push(format!("{}", (s * 1000.0).round() as u64));
            }
            for s in &l.subtitles {
                a.push("/sub".into());
                a.push(s.clone());
            }
            return a;
        }
        Kind::PotPlayer => {
            a.push(l.url.clone());
            if let Some(s) = l.start_sec {
                a.push(format!("/seek={}", clock(s)));
            }
            if let Some(s) = l.subtitles.first() {
                a.push(format!("/sub={s}"));
            }
            if let Some(ua) = header(&l.headers, "User-Agent") {
                a.push(format!("/user_agent={ua}"));
            }
            if let Some(r) = header(&l.headers, "Referer") {
                a.push(format!("/referer={r}"));
            }
            return a;
        }
        Kind::Mpv => {
            a.push("--force-window=immediate".into());
            if let Some(s) = l.start_sec {
                a.push(format!("--start={}", secs(s)));
            }
            if let Some(t) = &l.title {
                a.push(format!("--force-media-title={t}"));
            }
            for s in &l.subtitles {
                a.push(format!("--sub-file={s}"));
            }
            for (k, v) in &l.headers {
                // -append adds one item; no list separator issues.
                a.push(format!("--http-header-fields-append={k}: {v}"));
            }
            a.push("--".into());
        }
        Kind::Celluloid => {
            a.push("--new-window".into());
            if let Some(s) = l.start_sec {
                a.push(format!("--mpv-start={}", secs(s)));
            }
            if let Some(t) = &l.title {
                a.push(format!("--mpv-force-media-title={t}"));
            }
            if !l.subtitles.is_empty() && l.subtitles.iter().all(|s| !s.contains(':')) {
                a.push(format!("--mpv-sub-files={}", l.subtitles.join(":")));
            }
            if let Some(h) = header_list(&l.headers) {
                a.push(format!("--mpv-http-header-fields={h}"));
            }
        }
        Kind::Vlc => {
            if let Some(s) = l.start_sec {
                a.push(format!("--start-time={}", secs(s)));
            }
            if let Some(t) = &l.title {
                a.push(format!("--meta-title={t}"));
            }
            // VLC takes one subtitle file.
            if let Some(s) = l.subtitles.first() {
                a.push(format!("--sub-file={s}"));
            }
            if let Some(ua) = header(&l.headers, "User-Agent") {
                a.push(format!("--http-user-agent={ua}"));
            }
            if let Some(r) = header(&l.headers, "Referer") {
                a.push(format!("--http-referrer={r}"));
            }
        }
        Kind::Smplayer => {
            if let Some(s) = l.start_sec {
                a.push("-start".into());
                a.push(format!("{}", s.floor() as u64));
            }
            if let Some(t) = &l.title {
                a.push("-media-title".into());
                a.push(t.clone());
            }
            if let Some(s) = l.subtitles.first() {
                a.push("-sub".into());
                a.push(s.clone());
            }
        }
        Kind::Mplayer => {
            if let Some(s) = l.start_sec {
                a.push("-ss".into());
                a.push(secs(s));
            }
            if let Some(t) = &l.title {
                a.push("-title".into());
                a.push(t.clone());
            }
            if !l.subtitles.is_empty() && l.subtitles.iter().all(|s| !s.contains(',')) {
                a.push("-sub".into());
                a.push(l.subtitles.join(","));
            }
            if let Some(ua) = header(&l.headers, "User-Agent") {
                a.push("-user-agent".into());
                a.push(ua.to_string());
            }
            let rest: Vec<(String, String)> = l.headers.iter().filter(|(k, _)| !k.eq_ignore_ascii_case("User-Agent")).cloned().collect();
            if let Some(h) = header_list(&rest) {
                a.push("-http-header-fields".into());
                a.push(h);
            }
        }
        // Haruna has no command-line options for position, title or subtitles.
        Kind::Haruna => {}
    }
    if flatpak && l.local {
        a.extend(["@@".to_string(), l.url.clone(), "@@".to_string()]);
    } else {
        a.push(l.url.clone());
    }
    a
}

fn spawn_detached(program: &Path, args: &[String]) -> Result<(), String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // Own process group: closing Kinly or Ctrl+C in its terminal leaves the player running.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start the player: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[tauri::command]
pub async fn external_players() -> Result<Vec<ExternalPlayer>, String> {
    tauri::async_runtime::spawn_blocking(detect).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn external_open(args: OpenArgs) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let launch = validate(&args)?;
        let p = detect()
            .into_iter()
            .find(|p| p.id == args.player)
            .ok_or_else(|| format!("{} is not installed.", args.player))?;
        let flatpak = !p.prefix.is_empty();
        let mut argv = p.prefix.clone();
        if flatpak && launch.local {
            // `--file-forwarding` must come before the app id.
            argv.insert(1, "--file-forwarding".into());
        }
        argv.extend(build_args(p.kind, &launch, flatpak));
        crate::log_info!("extplayer", "open in {} ({}): {}", p.name, p.command, crate::logging::redact(&launch.url));
        spawn_detached(&p.program, &argv)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch() -> Launch {
        Launch {
            url: "https://example.com/v.mkv".into(),
            local: false,
            title: Some("Show · S1E2".into()),
            start_sec: Some(83.5),
            headers: vec![("Referer".into(), "https://a.example/".into()), ("User-Agent".into(), "Kinly/1".into())],
            subtitles: vec!["/tmp/a.srt".into(), "/tmp/b.ass".into()],
        }
    }

    #[test]
    fn mpv_args() {
        assert_eq!(
            build_args(Kind::Mpv, &launch(), false),
            vec![
                "--force-window=immediate",
                "--start=83.500",
                "--force-media-title=Show · S1E2",
                "--sub-file=/tmp/a.srt",
                "--sub-file=/tmp/b.ass",
                "--http-header-fields-append=Referer: https://a.example/",
                "--http-header-fields-append=User-Agent: Kinly/1",
                "--",
                "https://example.com/v.mkv",
            ]
        );
    }

    #[test]
    fn vlc_args_take_one_subtitle_and_known_headers() {
        assert_eq!(
            build_args(Kind::Vlc, &launch(), false),
            vec![
                "--start-time=83.500",
                "--meta-title=Show · S1E2",
                "--sub-file=/tmp/a.srt",
                "--http-user-agent=Kinly/1",
                "--http-referrer=https://a.example/",
                "https://example.com/v.mkv",
            ]
        );
    }

    #[test]
    fn celluloid_passes_mpv_options() {
        let a = build_args(Kind::Celluloid, &launch(), false);
        assert_eq!(a[0], "--new-window");
        assert!(a.contains(&"--mpv-start=83.500".to_string()));
        assert!(a.contains(&"--mpv-sub-files=/tmp/a.srt:/tmp/b.ass".to_string()));
        assert!(a.contains(&"--mpv-http-header-fields=Referer: https://a.example/,User-Agent: Kinly/1".to_string()));
        assert_eq!(a.last().unwrap(), "https://example.com/v.mkv");
    }

    #[test]
    fn smplayer_mplayer_haruna() {
        let l = launch();
        assert_eq!(
            build_args(Kind::Smplayer, &l, false),
            vec!["-start", "83", "-media-title", "Show · S1E2", "-sub", "/tmp/a.srt", "https://example.com/v.mkv"]
        );
        assert_eq!(
            build_args(Kind::Mplayer, &l, false),
            vec![
                "-ss", "83.500", "-title", "Show · S1E2", "-sub", "/tmp/a.srt,/tmp/b.ass", "-user-agent", "Kinly/1",
                "-http-header-fields", "Referer: https://a.example/", "https://example.com/v.mkv",
            ]
        );
        assert_eq!(build_args(Kind::Haruna, &l, false), vec!["https://example.com/v.mkv"]);
    }

    #[test]
    fn windows_players() {
        let l = launch();
        assert_eq!(
            build_args(Kind::MpcHc, &l, false),
            vec!["https://example.com/v.mkv", "/start", "83500", "/sub", "/tmp/a.srt", "/sub", "/tmp/b.ass"]
        );
        assert_eq!(
            build_args(Kind::PotPlayer, &l, false),
            vec![
                "https://example.com/v.mkv",
                "/seek=0:01:23.500",
                "/sub=/tmp/a.srt",
                "/user_agent=Kinly/1",
                "/referer=https://a.example/",
            ]
        );
        assert_eq!(clock(3725.25), "1:02:05.250");
        let roots = [PathBuf::from("PF"), PathBuf::from("PF86")];
        let c = windows_candidates(&roots, &["VideoLAN\\VLC\\vlc.exe"]);
        assert_eq!(c.len(), 2);
        assert!(c[0].starts_with("PF") && c[0].ends_with("vlc.exe"));
        // Ids are stored in settings and must match its `[a-z0-9]+` rule.
        assert!(KNOWN.iter().all(|k| k.bin.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())));
    }

    #[test]
    fn minimal_and_flatpak_local() {
        let l = Launch { url: "/media/a b.mkv".into(), local: true, ..Default::default() };
        assert_eq!(build_args(Kind::Mpv, &l, false), vec!["--force-window=immediate", "--", "/media/a b.mkv"]);
        assert_eq!(build_args(Kind::Vlc, &l, true), vec!["@@", "/media/a b.mkv", "@@"]);
    }

    #[test]
    fn validation() {
        let dir = std::env::temp_dir().join(format!("kinly-ext-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let video = dir.join("v.mkv");
        let sub = dir.join("v.srt");
        std::fs::write(&video, b"x").unwrap();
        std::fs::write(&sub, b"x").unwrap();

        let ok = validate(&OpenArgs {
            player: "mpv".into(),
            url: format!("file://{}", video.display()),
            title: Some("  A\u{7}B\n ".into()),
            start_sec: Some(0.4),
            headers: Some(HashMap::from([
                ("X-Ok".into(), "1".into()),
                ("Bad Name".into(), "1".into()),
                ("X-Inject".into(), "a\r\nB: c".into()),
            ])),
            subtitles: Some(vec![sub.display().to_string()]),
        })
        .unwrap();
        assert!(ok.local);
        assert_eq!(ok.url, video.display().to_string());
        assert_eq!(ok.title.as_deref(), Some("AB"));
        assert_eq!(ok.start_sec, None);
        assert_eq!(ok.headers, vec![("X-Ok".to_string(), "1".to_string())]);

        let bad = |url: &str| validate(&OpenArgs { url: url.into(), ..Default::default() }).is_err();
        assert!(bad("ftp://example.com/a"));
        assert!(bad("relative/file.mkv"));
        assert!(bad("/definitely/missing.mkv"));
        assert!(bad("https://example.com/a b"));
        assert!(bad("--script=/tmp/x.lua"));
        assert!(!bad("HTTPS://example.com/a.mkv"));
        assert!(validate(&OpenArgs { url: "https://e.com/a".into(), subtitles: Some(vec!["/missing.srt".into()]), ..Default::default() }).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn detect_ids_are_unique() {
        let ps = detect();
        let mut ids: Vec<&str> = ps.iter().map(|p| p.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), ps.len());
    }
}
