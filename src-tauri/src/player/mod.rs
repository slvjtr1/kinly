//! Embedded libmpv player.
//!
//! One mpv core lives for the whole session; the first `player_load` creates it
//! and installs the video surface under the (transparent) webview: a GTK GLArea
//! fed by the libmpv render API on Linux (`render_linux.rs`), mpv's own d3d11
//! VO in a child window under WebView2 on Windows (`render_windows.rs`).
//! Property changes are pushed to the UI as `player:prop` events and lifecycle
//! as `player:event`; the commands and events are the same on every OS.

#[cfg(target_os = "linux")]
mod render_linux;
#[cfg(windows)]
mod render_windows;
pub mod trailer;
pub mod vsr;
pub mod ytdlp;

#[cfg(target_os = "linux")]
pub use render_linux::configure_linux_graphics;

use libmpv2::events::{Event, EventContext, PropertyData};
use libmpv2::mpv_node::MpvNode;
use libmpv2::{Format, Mpv};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::ffi::CString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct PlayerState {
    mpv: Mutex<Option<Arc<Mpv>>>,
    pub fonts_dir: Option<PathBuf>,
}

impl PlayerState {
    pub fn new(fonts_dir: Option<PathBuf>) -> Self {
        PlayerState { mpv: Mutex::new(None), fonts_dir }
    }

    pub fn get(&self) -> Result<Arc<Mpv>, String> {
        self.mpv
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or_else(|| "player not started".to_string())
    }
}

/// Properties forwarded to the UI. `time-pos` is throttled in the event loop.
const OBSERVED: &[(&str, Format)] = &[
    ("time-pos", Format::Double),
    ("duration", Format::Double),
    ("pause", Format::Flag),
    ("paused-for-cache", Format::Flag),
    ("seeking", Format::Flag),
    ("eof-reached", Format::Flag),
    ("cache-buffering-state", Format::Int64),
    ("demuxer-cache-time", Format::Double),
    ("track-list", Format::Node),
    ("sid", Format::Node),
    ("aid", Format::Node),
    ("volume", Format::Double),
    ("mute", Format::Flag),
    ("sub-delay", Format::Double),
    ("sub-speed", Format::Double),
    ("speed", Format::Double),
    ("video-params", Format::Node),
    ("media-title", Format::String),
];

pub fn node_to_json(node: MpvNode) -> Value {
    match node {
        MpvNode::String(s) => Value::String(s),
        MpvNode::Flag(b) => Value::Bool(b),
        MpvNode::Int64(i) => json!(i),
        MpvNode::Double(d) => json!(d),
        MpvNode::ArrayIter(it) => Value::Array(it.map(node_to_json).collect()),
        MpvNode::MapIter(it) => {
            Value::Object(it.map(|(k, v)| (k, node_to_json(v))).collect())
        }
        MpvNode::None => Value::Null,
    }
}

fn prop_to_json(data: PropertyData) -> Value {
    match data {
        PropertyData::Str(s) | PropertyData::OsdStr(s) => Value::String(s.to_string()),
        PropertyData::Flag(b) => Value::Bool(b),
        PropertyData::Int64(i) => json!(i),
        PropertyData::Double(d) => json!(d),
        PropertyData::Node(n) => node_to_json(n),
    }
}

/// `mpv_command` with an argv array; avoids the quoting pitfalls of the
/// string form for URLs and paths containing spaces or quotes.
pub fn command_argv(mpv: &Mpv, args: &[&str]) -> Result<(), String> {
    let owned: Vec<CString> = args
        .iter()
        .map(|a| CString::new(*a).map_err(|_| "argument contains NUL".to_string()))
        .collect::<Result<_, _>>()?;
    let mut ptrs: Vec<*const std::os::raw::c_char> = owned.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    let rc = unsafe { libmpv2_sys::mpv_command(mpv.ctx.as_ptr(), ptrs.as_mut_ptr()) };
    if rc < 0 {
        let msg = unsafe { std::ffi::CStr::from_ptr(libmpv2_sys::mpv_error_string(rc)) };
        return Err(format!("{} failed: {}", args.first().unwrap_or(&"command"), msg.to_string_lossy()));
    }
    Ok(())
}

/// The UI's hardware-decoding switch sends `hwdec=auto-safe` for "on"; that
/// means Kinly's probed list (d3d11va first on Windows, which RTX Video Super
/// Resolution needs; the VA-API/NVDEC order on Linux), whose last entry is
/// `auto-safe` anyway. Any other value is passed through.
fn resolve_hwdec<'a>(value: &'a str, probed: &'a str) -> &'a str {
    if value == "auto-safe" && !probed.is_empty() {
        probed
    } else {
        value
    }
}

/// Properties the webview may set. mpv also has properties that load scripts, open IPC sockets or
/// run programs, so anything outside this list is refused.
const SETTABLE: &[&str] = &[
    "pause", "mute", "volume", "volume-max", "speed", "aid", "sid", "audio-delay", "sub-delay",
    "sub-speed", "sub-pos", "sub-font", "sub-bold", "sub-font-size", "sub-color", "sub-border-size",
    "sub-border-color", "sub-shadow-offset", "sub-shadow-color", "sub-back-color", "sub-ass-override",
    "hwdec", "alang",
];

/// Properties the webview may read (playback state and the video info panel).
const READABLE: &[&str] = &[
    "width", "height", "video-codec", "hwdec-current", "container-fps", "estimated-vf-fps",
    "frame-drop-count", "decoder-frame-drop-count", "video-bitrate", "audio-codec-name", "track-list",
    "time-pos", "duration", "pause", "mute", "volume", "speed", "aid", "sid", "sub-delay", "sub-speed",
    "audio-delay", "paused-for-cache", "cache-buffering-state", "eof-reached",
];

/// The audio-normalisation filter the player toggles; the only `af` change the webview may make.
const NORM_LABEL: &str = "@kinlynorm";
const NORM_FILTER: &str = "@kinlynorm:lavfi=[dynaudnorm=f=250:g=15]";

fn is_number(s: &str) -> bool {
    s.parse::<f64>().is_ok_and(f64::is_finite)
}

fn check_settable(name: &str, value: &Value) -> Result<(), String> {
    if !SETTABLE.contains(&name) {
        return Err(format!("property {name} is not allowed"));
    }
    if name == "hwdec" && !matches!(value.as_str(), Some("no" | "auto-safe")) {
        return Err("hwdec must be no or auto-safe".into());
    }
    if value.is_object() || value.is_array() {
        return Err(format!("set {name}: unsupported value"));
    }
    Ok(())
}

/// The commands the webview may send, with their arguments checked. Everything else (`run`,
/// `subprocess`, `load-script`, `loadfile`, ...) is refused; loading goes through `player_load`.
fn check_command(args: &[String]) -> Result<(), String> {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    let ok = match a.as_slice() {
        ["seek", n] => is_number(n),
        ["seek", n, "relative" | "absolute"] => is_number(n),
        ["cycle", "pause" | "mute"] => true,
        ["sub-remove", id] | ["audio-remove", id] => id.parse::<u32>().is_ok(),
        ["af", "add", f] => *f == NORM_FILTER,
        ["af", "remove", l] => *l == NORM_LABEL,
        ["audio-add", url, "select" | "auto"] => url.starts_with("https://"),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(format!("command {} is not allowed", a.first().unwrap_or(&"")))
    }
}

fn set_json(mpv: &Mpv, name: &str, value: &Value) -> Result<(), String> {
    if let (true, Value::String(v)) = (name == "hwdec", value) {
        let caps = crate::caps::get();
        let hw = resolve_hwdec(v, &caps.mpv_hwdec);
        return mpv.set_property(name, hw).map_err(|e| format!("set {name}: {e:?}"));
    }
    let r = match value {
        Value::Bool(b) => mpv.set_property(name, *b),
        Value::Number(n) if n.is_i64() => mpv.set_property(name, n.as_i64().unwrap_or(0)),
        Value::Number(n) => mpv.set_property(name, n.as_f64().unwrap_or(0.0)),
        Value::String(s) => mpv.set_property(name, s.as_str()),
        Value::Null => mpv.set_property(name, "no"),
        _ => return Err("unsupported value type".into()),
    };
    r.map_err(|e| format!("set {name}: {e:?}"))
}

#[cfg(target_os = "linux")]
extern "C" {
    fn setlocale(category: std::os::raw::c_int, locale: *const std::os::raw::c_char) -> *mut std::os::raw::c_char;
}
/// glibc's LC_NUMERIC.
#[cfg(target_os = "linux")]
const LC_NUMERIC: std::os::raw::c_int = 1;

/// Demuxer cache (forward, back) in MiB. About 2-3 % of RAM forward: 150 MiB
/// holds ~50 s of a 25 Mbit/s 4K stream on an 8 GB machine without pushing a
/// 4 GB one into swap.
pub fn demuxer_cache_mib(ram_mb: u64) -> (u64, u64) {
    match ram_mb {
        0 => (150, 50),
        r if r < 3072 => (64, 16),
        r if r < 6144 => (100, 32),
        r if r < 12288 => (150, 50),
        _ => (300, 100),
    }
}

/// `wid`: the window mpv's own VO renders into (Windows); `None` selects the
/// libmpv render API (Linux).
fn create_mpv(fonts_dir: Option<&PathBuf>, wid: Option<i64>) -> Result<Mpv, String> {
    // GTK adopts the system locale; libmpv refuses to start unless numbers use
    // the C locale ("Non-C locale detected"). Only number formatting changes.
    #[cfg(target_os = "linux")]
    unsafe {
        setlocale(LC_NUMERIC, c"C".as_ptr())
    };
    let caps = crate::caps::get();
    crate::log_info!("player", "hwdec={} vaapi-device={:?} profile={}", caps.mpv_hwdec, caps.vaapi_device, if caps.weak_gpu { "fast" } else { "default" });
    #[cfg(windows)]
    let d3d11_adapter = {
        let st = crate::gpu::state();
        crate::gpu_windows::d3d11_adapter(&st.gpus, &st.decision)
    };
    Mpv::with_initializer(|init| {
        match wid {
            Some(w) => {
                // Native d3d11 VO in a child of `wid` (see render_windows.rs).
                init.set_property("wid", w)?;
                init.set_property("vo", "gpu-next,gpu")?;
                init.set_property("gpu-api", "d3d11").ok();
                init.set_property("gpu-context", "d3d11").ok();
                init.set_property("input-cursor", "no").ok();
                init.set_property("cursor-autohide", "no").ok();
                #[cfg(windows)]
                if let Some(name) = d3d11_adapter.as_deref() {
                    init.set_property("d3d11-adapter", name).ok();
                }
            }
            None => init.set_property("vo", "libmpv")?,
        }
        init.set_property("config", "no")?;
        init.set_property("terminal", "no")?;
        init.set_property("input-default-bindings", "no")?;
        init.set_property("input-vo-keyboard", "no")?;
        init.set_property("osc", "no")?;
        init.set_property("ytdl", "no")?;
        init.set_property("idle", "yes")?;
        init.set_property("keep-open", "yes")?;
        init.set_property("force-window", "no")?;
        // Hardware decode chosen from the probed capabilities (see caps): the
        // rendering GPU's zero-copy API first, then copy-back, then auto-safe.
        // vaapi-device pins copy-back to the GPU that has VA-API (libva's
        // default node can be the NVIDIA card, which has no VA-API driver).
        init.set_property("hwdec", caps.mpv_hwdec.as_str())?;
        init.set_property("hwdec-codecs", "all")?;
        if let Some(dev) = caps.vaapi_device.as_deref() {
            init.set_property("vaapi-device", dev).ok();
        }
        // Decoder threads = CPU count (0 is auto); matters for software decode on weak CPUs.
        init.set_property("vd-lavc-threads", "0")?;
        // Integrated GPUs: bilinear scaling, no dithering/sigmoid/peak compute.
        // Not on discrete GPUs: even on low-end ones it did not reduce dropped frames.
        if caps.weak_gpu {
            init.set_property("profile", "fast").ok();
        }
        // Renamed in newer mpv (0.37: `background`); cosmetic, so never fatal.
        if init.set_property("background-color", "#000000").is_err() {
            init.set_property("background", "#000000").ok();
        }
        init.set_property("osd-level", "0")?;
        init.set_property("media-controls", "no").ok();
        // Network streams: modest cache, reconnect on transient errors.
        init.set_property("cache", "yes")?;
        let (fwd, back) = demuxer_cache_mib(caps.ram_mb);
        init.set_property("demuxer-max-bytes", format!("{fwd}MiB").as_str())?;
        init.set_property("demuxer-max-back-bytes", format!("{back}MiB").as_str())?;
        init.set_property("network-timeout", "30")?;
        init.set_property(
            "stream-lavf-o",
            "reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=5",
        )
        .ok();
        // Subtitles: libass with complex shaping (HarfBuzz + FriBidi), which
        // is what Arabic needs. Selection is done by Kinly, not mpv.
        init.set_property("sub-ass-shaper", "complex").ok();
        // libass defaults to a left-to-right base direction (VSFilter compat), which
        // puts trailing punctuation of Arabic lines on the wrong side. Encoding=-1
        // makes it detect the base direction per line from the first strong letter.
        init.set_property("sub-ass-style-overrides", "Encoding=-1").ok();
        init.set_property("sub-auto", "no")?;
        init.set_property("sid", "no")?;
        init.set_property("sub-codepage", "auto").ok();
        init.set_property("embeddedfonts", "yes")?;
        // Windows builds of mpv find system fonts through DirectWrite.
        init.set_property("sub-font-provider", if cfg!(windows) { "auto" } else { "fontconfig" }).ok();
        if let Some(dir) = fonts_dir.and_then(|d| d.to_str()) {
            init.set_property("sub-fonts-dir", dir)?;
        }
        init.set_property("user-agent", crate::net::USER_AGENT)?;
        Ok(())
    })
    .map_err(|e| format!("mpv init: {e:?}"))
}

fn ensure_started(app: &AppHandle, state: &PlayerState) -> Result<Arc<Mpv>, String> {
    let mut slot = state.mpv.lock().map_err(|e| e.to_string())?;
    if let Some(m) = slot.as_ref() {
        return Ok(m.clone());
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    #[cfg(windows)]
    let wid = Some(render_windows::wid(&window)?);
    #[cfg(not(windows))]
    let wid = None;
    let mpv = Arc::new(create_mpv(state.fonts_dir.as_ref(), wid)?);

    #[cfg(target_os = "linux")]
    let ctx_addr = mpv.ctx.as_ptr() as usize;
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
    app.run_on_main_thread(move || {
        #[cfg(target_os = "linux")]
        let res = (|| {
            let p = std::ptr::NonNull::new(ctx_addr as *mut libmpv2_sys::mpv_handle)
                .ok_or_else(|| "null mpv handle".to_string())?;
            render_linux::prepare(p)?;
            let gtk_window = window.gtk_window().map_err(|e| format!("gtk_window: {e:?}"))?;
            let vbox = window.default_vbox().map_err(|e| format!("default_vbox: {e:?}"))?;
            render_linux::install(&gtk_window, &vbox)
        })();
        #[cfg(windows)]
        let res = render_windows::install(&window);
        #[cfg(not(any(target_os = "linux", windows)))]
        let res: Result<(), String> = {
            let _ = window;
            Err("no video surface for this platform".into())
        };
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "video surface install timed out".to_string())??;

    let ev = EventContext::new(mpv.ctx);
    let _ = ev.disable_deprecated_events();
    for (i, (name, fmt)) in OBSERVED.iter().enumerate() {
        if let Err(e) = ev.observe_property(name, *fmt, i as u64 + 1) {
            crate::log_warn!("player", "observe {name}: {e:?}");
        }
    }
    spawn_event_loop(app.clone(), mpv.clone(), ev);
    crate::log_info!("player", "mpv core started");
    *slot = Some(mpv.clone());
    Ok(mpv)
}

fn spawn_event_loop(app: AppHandle, mpv: Arc<Mpv>, mut ev: EventContext) {
    std::thread::Builder::new()
        .name("mpv-events".into())
        .spawn(move || {
            let mut last_time_emit = Instant::now() - Duration::from_secs(1);
            let mut last_hwdec = String::new();
            #[cfg(windows)]
            let mut vsr = vsr::Vsr::default();
            loop {
                match ev.wait_event(1.0) {
                    None => continue,
                    Some(Ok(Event::Shutdown)) => {
                        let _ = app.emit("player:event", json!({"type": "shutdown"}));
                        break;
                    }
                    Some(Ok(Event::PropertyChange { name, change, .. })) => {
                        if name == "time-pos" {
                            if last_time_emit.elapsed() < Duration::from_millis(250) {
                                continue;
                            }
                            last_time_emit = Instant::now();
                        }
                        let _ = app.emit("player:prop", json!({"name": name, "value": prop_to_json(change)}));
                    }
                    Some(Ok(Event::StartFile)) => {
                        #[cfg(windows)]
                        vsr.reset(&mpv);
                        let _ = app.emit("player:event", json!({"type": "start-file"}));
                    }
                    Some(Ok(Event::FileLoaded)) => {
                        let _ = mpv.set_property("start", "none");
                        let _ = app.emit("player:event", json!({"type": "file-loaded"}));
                    }
                    Some(Ok(Event::PlaybackRestart)) => {
                        let hw = mpv.get_property::<String>("hwdec-current").unwrap_or_else(|_| "?".into());
                        if hw != last_hwdec {
                            crate::log_info!("player", "decoder: hwdec-current={hw}");
                            last_hwdec = hw;
                        }
                        #[cfg(windows)]
                        {
                            let _ = app.run_on_main_thread(render_windows::restack);
                            vsr.update(&app, &mpv);
                        }
                        let _ = app.emit("player:event", json!({"type": "playback-restart"}));
                    }
                    #[cfg(windows)]
                    Some(Ok(Event::VideoReconfig)) => {
                        let _ = app.run_on_main_thread(render_windows::restack);
                    }
                    Some(Ok(Event::EndFile(reason))) => {
                        let _ = app.emit("player:event", json!({"type": "end-file", "reason": reason as i64}));
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        let msg = crate::logging::redact(&format!("{e:?}"));
                        crate::log_warn!("player", "mpv event error: {msg}");
                        let _ = app.emit("player:event", json!({"type": "error", "message": msg}));
                    }
                }
            }
        })
        .expect("spawn mpv event thread");
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadArgs {
    pub url: String,
    #[serde(default)]
    pub start_sec: Option<f64>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub headers: Option<std::collections::HashMap<String, String>>,
}

#[tauri::command]
pub async fn player_load(app: AppHandle, state: State<'_, PlayerState>, args: LoadArgs) -> Result<(), String> {
    let is_local = !args.url.contains("://") || args.url.starts_with("file://");
    if !is_local {
        crate::net::check_url(&args.url)?;
    }
    let mpv = ensure_started(&app, &state).map_err(|e| {
        crate::log_error!("player", "video engine failed to start: {e}");
        format!("The video engine could not start ({e}).")
    })?;
    LOAD_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    set_video_visible(&app, true);
    let _ = mpv.set_property("sid", "no");
    let _ = mpv.set_property("sub-delay", 0.0f64);
    let _ = mpv.set_property("sub-speed", 1.0f64);
    let _ = mpv.set_property("pause", false);
    match args.start_sec {
        Some(s) if s > 1.0 => mpv.set_property("start", format!("{s:.3}").as_str()),
        _ => mpv.set_property("start", "none"),
    }
    .map_err(|e| format!("start: {e:?}"))?;
    let title = args.title.unwrap_or_default();
    let _ = mpv.set_property("force-media-title", title.as_str());
    let header_fields = args
        .headers
        .unwrap_or_default()
        .into_iter()
        .filter(|(k, v)| !k.contains([',', '\r', '\n']) && !v.contains([',', '\r', '\n']))
        .map(|(k, v)| format!("{k}: {v}"))
        .collect::<Vec<_>>()
        .join(",");
    let _ = mpv.set_property("http-header-fields", header_fields.as_str());
    crate::log_info!("player", "loadfile {}", crate::logging::redact(&args.url));
    command_argv(&mpv, &["loadfile", &args.url, "replace"]).inspect_err(|e| crate::log_error!("player", "{e}"))
}

#[tauri::command]
pub async fn player_command(state: State<'_, PlayerState>, args: Vec<String>) -> Result<(), String> {
    check_command(&args)?;
    let mpv = state.get()?;
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    command_argv(&mpv, &refs)
}

#[tauri::command]
pub async fn player_set(state: State<'_, PlayerState>, name: String, value: Value) -> Result<(), String> {
    check_settable(&name, &value)?;
    let mpv = state.get()?;
    set_json(&mpv, &name, &value)
}

#[tauri::command]
pub async fn player_set_many(state: State<'_, PlayerState>, props: Vec<(String, Value)>) -> Result<Vec<String>, String> {
    let mpv = state.get()?;
    let mut errors = Vec::new();
    for (k, v) in props {
        if let Err(e) = check_settable(&k, &v).and_then(|()| set_json(&mpv, &k, &v)) {
            errors.push(e);
        }
    }
    Ok(errors)
}

#[tauri::command]
pub async fn player_get(state: State<'_, PlayerState>, name: String) -> Result<Value, String> {
    if !READABLE.contains(&name.as_str()) {
        return Err(format!("property {name} is not allowed"));
    }
    let mpv = state.get()?;
    mpv.get_property::<MpvNode>(&name)
        .map(node_to_json)
        .map_err(|e| format!("get {name}: {e:?}"))
}

#[derive(Serialize)]
pub struct SubAdded {
    pub sid: i64,
}

/// Add an external subtitle file. Returns the new track id.
#[tauri::command]
pub async fn player_sub_add(
    state: State<'_, PlayerState>,
    path: String,
    title: String,
    lang: String,
    select: bool,
) -> Result<SubAdded, String> {
    let mpv = state.get()?;
    let flag = if select { "select" } else { "auto" };
    command_argv(&mpv, &["sub-add", &path, flag, &title, &lang])?;
    let tracks = mpv
        .get_property::<MpvNode>("track-list")
        .map(node_to_json)
        .map_err(|e| format!("track-list: {e:?}"))?;
    let sid = tracks
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["type"] == "sub" && t["external-filename"] == Value::String(path.clone()))
        .filter_map(|t| t["id"].as_i64())
        .max()
        .ok_or_else(|| "subtitle track not found after sub-add".to_string())?;
    Ok(SubAdded { sid })
}

#[tauri::command]
pub async fn player_stop(app: AppHandle, state: State<'_, PlayerState>) -> Result<(), String> {
    use std::sync::atomic::Ordering::SeqCst;
    let gen = LOAD_GEN.load(SeqCst);
    if let Ok(mpv) = state.get() {
        command_argv(&mpv, &["stop"])?;
    }
    // Skip the hide if a newer load (e.g. autoplay next) started in the meantime.
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if LOAD_GEN.load(SeqCst) == gen {
            show_video_now(&app2, false);
        }
    });
    Ok(())
}

/// Platform video surface visibility; runs on the main thread.
fn show_video_now(app: &AppHandle, visible: bool) {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        render_linux::set_video_visible(visible);
    }
    #[cfg(windows)]
    if let Some(w) = app.get_webview_window("main") {
        render_windows::set_video_visible(&w, visible);
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    let _ = (app, visible);
}

fn set_video_visible(app: &AppHandle, visible: bool) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || show_video_now(&app2, visible));
}

/// Incremented by every `player_load`; lets a late `player_stop` see it is stale.
static LOAD_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Save the current frame as a small JPEG for Continue watching (local files have no artwork).
#[tauri::command]
pub async fn player_thumbnail(app: AppHandle, state: State<'_, PlayerState>, key: String) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mpv = state.get()?;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("thumbs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name: String = Sha256::digest(key.as_bytes())[..10].iter().map(|b| format!("{b:02x}")).collect();
    let path = dir.join(format!("{name}.jpg"));
    let _ = mpv.set_property("screenshot-format", "jpg");
    let _ = mpv.set_property("screenshot-jpeg-quality", 80i64);
    let p = path.display().to_string();
    command_argv(&mpv, &["screenshot-to-file", &p, "video"])?;
    Ok(p)
}

#[tauri::command]
pub fn player_fonts_dir(state: State<'_, PlayerState>) -> Option<String> {
    state.fonts_dir.as_ref().map(|p| p.display().to_string())
}

pub fn shutdown(state: &PlayerState) {
    if let Ok(mut slot) = state.mpv.lock() {
        if let Some(m) = slot.take() {
            let _ = command_argv(&m, &["quit"]);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn hwdec_switch_uses_the_probed_list() {
        assert_eq!(super::resolve_hwdec("auto-safe", "d3d11va,d3d11va-copy,auto-safe"), "d3d11va,d3d11va-copy,auto-safe");
        assert_eq!(super::resolve_hwdec("no", "d3d11va,d3d11va-copy,auto-safe"), "no");
        assert_eq!(super::resolve_hwdec("auto-safe", ""), "auto-safe");
    }

    #[test]
    fn webview_commands_are_allowlisted() {
        let c = |a: &[&str]| super::check_command(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert!(c(&["seek", "12.50", "absolute"]).is_ok());
        assert!(c(&["seek", "-5"]).is_ok());
        assert!(c(&["cycle", "pause"]).is_ok());
        assert!(c(&["af", "add", "@kinlynorm:lavfi=[dynaudnorm=f=250:g=15]"]).is_ok());
        assert!(c(&["run", "sh", "-c", "id"]).is_err());
        assert!(c(&["subprocess", "x"]).is_err());
        assert!(c(&["load-script", "/tmp/x.lua"]).is_err());
        assert!(c(&["loadfile", "x"]).is_err());
        assert!(c(&["seek", "nan"]).is_err());
        assert!(c(&["af", "add", "lavfi=[movie=/etc/passwd]"]).is_err());
        assert!(c(&["audio-add", "file:///etc/passwd", "select"]).is_err());
        assert!(c(&["cycle", "input-ipc-server"]).is_err());
        assert!(super::check_settable("volume", &serde_json::json!(80)).is_ok());
        assert!(super::check_settable("hwdec", &serde_json::json!("auto-safe")).is_ok());
        assert!(super::check_settable("hwdec", &serde_json::json!("vulkan")).is_err());
        assert!(super::check_settable("input-ipc-server", &serde_json::json!("/tmp/s")).is_err());
        assert!(super::check_settable("scripts", &serde_json::json!("/tmp/x.lua")).is_err());
    }

    #[test]
    fn demuxer_cache_scales_with_ram() {
        assert_eq!(super::demuxer_cache_mib(7805), (150, 50));
        assert_eq!(super::demuxer_cache_mib(2048).0, 64);
        assert_eq!(super::demuxer_cache_mib(16000).0, 300);
    }
}
