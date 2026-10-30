//! WebKitGTK settings for the main webview (scrolling and compositing).
//!
//! The symbols are resolved at run time, like the background-colour setter in
//! `player/render_linux.rs`, so Kinly does not need a direct `webkit2gtk`
//! dependency. Missing symbols are skipped.
//!
//! - Hardware acceleration: `ALWAYS`. Every page is composited on the GPU from
//!   the first frame. The player's transparent webview over the mpv GLArea
//!   already requires accelerated compositing (see `configure_linux_graphics`),
//!   so `ALWAYS` only removes the switch between modes that `ON_DEMAND` makes
//!   on older WebKitGTK releases. `NEVER` is not allowed: it breaks the player.
//! - Smooth scrolling: kept on (WebKit animates each wheel notch on the
//!   scrolling thread). `KINLY_SMOOTH_SCROLL=0` turns it off for users who
//!   prefer instant wheel steps.
//!
//! NVIDIA proprietary driver: Debian and Ubuntu build WebKitGTK with
//! `disable-dmabuf-nvidia.patch`, which empties the DMA-BUF renderer's
//! transport set whenever the NVIDIA driver is loaded. WebKit then reports the
//! hardware-acceleration policy as `NEVER` and refuses `ALWAYS`, so accelerated
//! compositing and threaded scrolling are off and every frame (spinner
//! rotations, hover lifts, scrolling) is painted on the CPU on the web
//! process main thread. Any JavaScript work then freezes animations. The same
//! patch honours `WEBKIT_FORCE_DMABUF_RENDERER`, so `prepare_env` sets it on
//! NVIDIA + X11, together with `WEBKIT_DMABUF_RENDERER_FORCE_SHM`: on PRIME
//! laptops (driver 580, WebKitGTK 2.52.6) the forced DMA-BUF path alone can
//! fail with "Failed to create GBM buffer ... Invalid argument", leaving the
//! window blank. With shared-memory buffers the policy becomes `always` and the
//! page renders; Home then showed its first row in ~2 s instead of ~22 s with
//! CPU painting.
//! `KINLY_WEBKIT_DMABUF=1` skips the shared-memory fallback (zero-copy
//! DMA-BUF, for drivers where GBM works). `KINLY_WEBKIT_GPU=0` keeps the
//! distribution's choice. A transport variable set by the user is always left
//! alone.
//!
//! WebKitGTK still runs CSS animations from the web process main thread (there
//! is no threaded animation resolution in 2.52), so a long JavaScript task
//! stalls a spinner even with GPU compositing; the frontend keeps its work in
//! short chunks for that reason.

#![cfg(target_os = "linux")]

use std::ffi::c_void;
use std::os::raw::{c_char, c_int};

use gtk::glib::translate::{Stash, ToGlibPtr};

const RTLD_DEFAULT: *mut c_void = std::ptr::null_mut();
extern "C" {
    fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
}

fn sym<T>(name: &[u8]) -> Option<T> {
    debug_assert!(name.ends_with(b"\0"));
    let p = unsafe { dlsym(RTLD_DEFAULT, name.as_ptr() as *const c_char) };
    if p.is_null() {
        None
    } else {
        Some(unsafe { std::mem::transmute_copy(&p) })
    }
}

/// `WebKitHardwareAccelerationPolicy` (GTK3 API).
const POLICY_ALWAYS: c_int = 1;
const POLICY_NEVER: c_int = 2;

/// WebKitGTK variables that already choose the buffer transport (any value).
const TRANSPORT_VARIABLES: [&str; 4] = [
    "WEBKIT_DISABLE_DMABUF_RENDERER",
    "WEBKIT_DMABUF_RENDERER_FORCE_SHM",
    "WEBKIT_FORCE_DMABUF_RENDERER",
    "WEBKIT_DISABLE_COMPOSITING_MODE",
];

static ENV_NOTE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Whether to force WebKit's DMA-BUF renderer: only for the NVIDIA proprietary
/// driver on X11, when nothing in the environment has chosen a transport.
fn want_force_dmabuf(nvidia: bool, wayland: bool, opt_out: bool, preset: Option<&str>) -> Result<(), String> {
    if opt_out {
        return Err("KINLY_WEBKIT_GPU=0: leaving WebKit's renderer choice alone".into());
    }
    if let Some(name) = preset {
        return Err(format!("{name} is set; leaving WebKit's renderer choice alone"));
    }
    if !nvidia {
        return Err("no NVIDIA proprietary driver; nothing to override".into());
    }
    if wayland {
        return Err("NVIDIA on Wayland: not forcing the DMA-BUF renderer (untested)".into());
    }
    Ok(())
}

/// Environment for WebKit's renderer. Call before GTK or WebKit initialise
/// (they read these variables once). The decision is logged by `tune`, since
/// the log file is not open yet.
pub fn prepare_env() {
    let nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists();
    let wayland = std::env::var("XDG_SESSION_TYPE").map(|v| v.eq_ignore_ascii_case("wayland")).unwrap_or(false)
        || std::env::var("WAYLAND_DISPLAY").map(|v| !v.is_empty()).unwrap_or(false);
    let opt_out = std::env::var("KINLY_WEBKIT_GPU").as_deref() == Ok("0");
    let preset = TRANSPORT_VARIABLES.iter().copied().find(|n| std::env::var_os(n).is_some());
    let zero_copy = std::env::var("KINLY_WEBKIT_DMABUF").as_deref() == Ok("1");
    let note = match want_force_dmabuf(nvidia, wayland, opt_out, preset) {
        Ok(()) => {
            std::env::set_var("WEBKIT_FORCE_DMABUF_RENDERER", "1");
            if zero_copy {
                "NVIDIA + X11: set WEBKIT_FORCE_DMABUF_RENDERER=1 (KINLY_WEBKIT_DMABUF=1: zero-copy buffers)".to_string()
            } else {
                // GBM buffer allocation fails on some NVIDIA setups (blank window); shared memory always works.
                std::env::set_var("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1");
                "NVIDIA + X11: set WEBKIT_FORCE_DMABUF_RENDERER=1 and WEBKIT_DMABUF_RENDERER_FORCE_SHM=1 (the distribution's WebKitGTK disables GPU compositing on NVIDIA)".to_string()
            }
        }
        Err(why) => why,
    };
    let _ = ENV_NOTE.set(note);
}

fn policy_label(p: c_int) -> &'static str {
    match p {
        0 => "on-demand",
        1 => "always",
        2 => "never",
        _ => "unknown",
    }
}

/// Apply Kinly's settings to the main webview. Call on the GTK main thread.
pub fn tune(web_view: &gtk::Widget) {
    type GetSettings = unsafe extern "C" fn(*mut c_void) -> *mut c_void;
    type GetInt = unsafe extern "C" fn(*mut c_void) -> c_int;
    type SetInt = unsafe extern "C" fn(*mut c_void, c_int);

    let Some(get_settings) = sym::<GetSettings>(b"webkit_web_view_get_settings\0") else {
        log_warn!("webview", "webkit_web_view_get_settings not found; leaving defaults");
        return;
    };
    let stash: Stash<'_, *mut gtk::ffi::GtkWidget, gtk::Widget> = web_view.to_glib_none();
    let settings = unsafe { get_settings(stash.0 as *mut c_void) };
    if settings.is_null() {
        return;
    }

    let get_policy = sym::<GetInt>(b"webkit_settings_get_hardware_acceleration_policy\0");
    let set_policy = sym::<SetInt>(b"webkit_settings_set_hardware_acceleration_policy\0");
    let get_smooth = sym::<GetInt>(b"webkit_settings_get_enable_smooth_scrolling\0");
    let set_smooth = sym::<SetInt>(b"webkit_settings_set_enable_smooth_scrolling\0");

    let before_policy = get_policy.map(|f| unsafe { f(settings) });
    let before_smooth = get_smooth.map(|f| unsafe { f(settings) } != 0);

    if let Some(f) = set_policy {
        unsafe { f(settings, POLICY_ALWAYS) };
    }
    let smooth = std::env::var("KINLY_SMOOTH_SCROLL").map(|v| v != "0").unwrap_or(true);
    if let Some(f) = set_smooth {
        unsafe { f(settings, smooth as c_int) };
    }

    let after_policy = get_policy.map(|f| unsafe { f(settings) });
    if let Some(note) = ENV_NOTE.get() {
        log_info!("webview", "{}", note);
    }
    log_info!(
        "webview",
        "hardware acceleration {} -> {}; smooth scrolling {} -> {}",
        before_policy.map(policy_label).unwrap_or("?"),
        after_policy.map(policy_label).unwrap_or("?"),
        before_smooth.map(|b| b.to_string()).unwrap_or_else(|| "?".into()),
        smooth
    );
    if after_policy == Some(POLICY_NEVER) {
        log_warn!(
            "webview",
            "WebKit refused GPU compositing: the UI is painted on the CPU and animations stall while the page is busy"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::want_force_dmabuf;

    #[test]
    fn forces_dmabuf_only_for_nvidia_x11_without_overrides() {
        assert!(want_force_dmabuf(true, false, false, None).is_ok());
        assert!(want_force_dmabuf(false, false, false, None).is_err());
        assert!(want_force_dmabuf(true, true, false, None).is_err());
        assert!(want_force_dmabuf(true, false, true, None).is_err());
        assert!(want_force_dmabuf(true, false, false, Some("WEBKIT_DISABLE_DMABUF_RENDERER")).is_err());
    }
}
