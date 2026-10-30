#[macro_use]
pub mod logging;
pub mod net;
pub mod paths;
pub mod player;
pub mod store;
pub mod subs;
pub mod sync;
pub mod local;
pub mod gpu;
pub mod gpu_windows;
pub mod webview;
pub mod caps;
pub mod introdb;
pub mod authcb;
pub mod extplayer;
pub mod tools;

use std::path::PathBuf;
use tauri::{Manager, State};

pub struct Paths {
    pub config: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
    pub logs: PathBuf,
}

/// Bundled subtitle fonts: `<resources>/fonts` when packaged; the source tree in debug builds.
fn resolve_fonts_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("fonts"));
    }
    #[cfg(debug_assertions)]
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fonts"));
    candidates.into_iter().find(|p| p.join("NotoNaskhArabic-Regular.ttf").exists())
}

#[tauri::command]
fn store_load(store: State<'_, store::Store>, name: String) -> Result<store::LoadResult, String> {
    store.load(&name)
}

#[tauri::command]
fn store_save(store: State<'_, store::Store>, name: String, value: serde_json::Value) -> Result<(), String> {
    store.save(&name, &value)
}

#[tauri::command]
fn app_info(paths: State<'_, Paths>, player: State<'_, player::PlayerState>) -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "configDir": paths.config.display().to_string(),
        "dataDir": paths.data.display().to_string(),
        "cacheDir": paths.cache.display().to_string(),
        "logDir": paths.logs.display().to_string(),
        "fontsDir": player.fonts_dir.as_ref().map(|p| p.display().to_string()),
        "ffmpeg": sync::extract::locate_ffmpeg().is_some(),
        "ytdlp": player::ytdlp::age(&player::ytdlp::managed_path(&paths.data)).is_some() || player::trailer::find_ytdlp().is_some(),
        "os": std::env::consts::OS,
    })
}

/// A video passed on the command line (e.g. "Open with Kinly" from the file manager).
pub struct LaunchFile(std::sync::Mutex<Option<String>>);

#[tauri::command]
fn take_launch_file(state: State<'_, LaunchFile>) -> Option<String> {
    state.0.lock().ok()?.take()
}

#[tauri::command]
fn ui_log(level: String, message: String) {
    // Rate- and size-limited, one line per call, so the webview can't flood or forge log lines.
    static WINDOW: std::sync::Mutex<(u64, u32)> = std::sync::Mutex::new((0, 0));
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut w) = WINDOW.lock() {
        if w.0 != now {
            *w = (now, 0);
        }
        w.1 += 1;
        if w.1 > 20 {
            return;
        }
    }
    let level = match level.to_ascii_uppercase().as_str() {
        l @ ("INFO" | "WARN" | "ERROR" | "DEBUG") => l.to_string(),
        _ => "INFO".to_string(),
    };
    let message: String = message.chars().take(2000).map(|c| if c.is_control() { ' ' } else { c }).collect();
    logging::write(&level, "ui", &logging::redact(&message));
}

pub fn run() {
    // Before GTK/WebKit load any GL stack: PRIME variables are read at library load.
    gpu::configure();
    #[cfg(target_os = "linux")]
    player::configure_linux_graphics();
    // GPU compositing for the webview on NVIDIA (see webview.rs).
    #[cfg(target_os = "linux")]
    webview::prepare_env();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
            if let Some(path) = crate::paths::video_arg(&argv, std::path::Path::new(&cwd)) {
                use tauri::Emitter;
                let _ = app.emit("open-file", path);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle();
            let data = handle.path().app_data_dir()?;
            let paths = Paths {
                config: handle.path().app_config_dir()?,
                cache: handle.path().app_cache_dir()?,
                logs: handle.path().app_log_dir().unwrap_or_else(|_| data.join("logs")),
                data,
            };
            for d in [&paths.config, &paths.data, &paths.cache] {
                std::fs::create_dir_all(d)?;
            }
            if let Some(p) = logging::init(&paths.logs) {
                log_info!("app", "Kinly {} starting; log at {}", env!("CARGO_PKG_VERSION"), p.display());
            }
            log_info!("gpu", "{}", gpu::summary(gpu::state()));
            caps::warm();
            // WebKit settings for scrolling and GPU compositing (see webview.rs).
            #[cfg(target_os = "linux")]
            if let Some(w) = handle.get_webview_window("main") {
                let _ = w.with_webview(|pw| {
                    use gtk::prelude::Cast;
                    let widget: gtk::Widget = pw.inner().upcast();
                    webview::tune(&widget);
                });
            }
            let fonts = resolve_fonts_dir(handle);
            match &fonts {
                Some(dir) => log_info!("app", "subtitle fonts: {}", dir.display()),
                None => log_warn!("app", "bundled subtitle fonts not found; falling back to system fonts"),
            }
            app.manage(store::Store::new(paths.config.clone()));
            app.manage(subs::SubCache::new(paths.cache.join("subtitles")));
            app.manage(player::PlayerState::new(fonts));
            app.manage(paths);
            app.manage(local::Downloads::new());
            local::start_watcher(handle.clone());
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            app.manage(LaunchFile(std::sync::Mutex::new(crate::paths::video_arg(&args, &cwd))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            ui_log,
            take_launch_file,
            store_load,
            store_save,
            net::http_request,
            player::player_load,
            player::player_command,
            player::player_set,
            player::player_set_many,
            player::player_get,
            player::player_sub_add,
            player::player_stop,
            player::player_fonts_dir,
            player::player_thumbnail,
            player::trailer::trailer_resolve,
            subs::subs_fetch,
            subs::subs_load_local,
            subs::subs_find_sidecars,
            sync::sync_subtitle,
            local::local_scan,
            local::downloads_list,
            caps::system_caps,
            introdb::introdb_segments,
            authcb::auth_callback_listen,
            extplayer::external_players,
            extplayer::external_open,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Kinly")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(p) = app.try_state::<player::PlayerState>() {
                    player::shutdown(&p);
                }
            }
        });
}
