//! NVIDIA RTX Video Super Resolution through mpv's `d3d11vpp` filter.
//!
//! `vf=d3d11vpp=scale=<f>:scaling-mode=nvidia` (mpv 0.39+) asks the D3D11 video
//! processor to upscale; with an RTX GPU and "RTX Video enhancement" enabled
//! in the NVIDIA driver, that scaler is VSR. The filter takes D3D11 hardware
//! frames, so it is only added when mpv decodes with zero-copy `d3d11va` into
//! the d3d11 VO (the Windows render path, see `render_windows.rs`), and only
//! when the source is smaller than the display: VSR never downscales.
//!
//! The policy is pure and tested on every OS; applying it is Windows-only.
//! Linux shows the setting disabled (NVIDIA's Linux driver has no VSR).

#![cfg_attr(not(windows), allow(dead_code))]

use serde_json::Value;

/// mpv filter label, so Kinly removes only its own filter.
pub const LABEL: &str = "@kinly-vsr";
/// VSR's useful range; larger factors only cost GPU time.
const MAX_SCALE: f64 = 4.0;
/// Below this the source effectively fills the display already.
const MIN_SCALE: f64 = 1.05;

/// Upscale factor that fits the source into the display, or `None` when the
/// source is not below the display resolution.
pub fn scale_for(src: (i64, i64), display: (i64, i64)) -> Option<f64> {
    let (sw, sh) = src;
    let (dw, dh) = display;
    if sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0 {
        return None;
    }
    let f = (dw as f64 / sw as f64).min(dh as f64 / sh as f64);
    if f < MIN_SCALE {
        return None;
    }
    Some((f.min(MAX_SCALE) * 100.0).floor() / 100.0)
}

/// The `vf add` argument for this source, or `None` when VSR should be off.
pub fn filter(enabled: bool, rtx: bool, hwdec_current: &str, src: (i64, i64), display: (i64, i64)) -> Option<String> {
    if !enabled || !rtx || hwdec_current != "d3d11va" {
        return None;
    }
    let s = scale_for(src, display)?;
    Some(format!("{LABEL}:d3d11vpp=scale={s:.2}:scaling-mode=nvidia"))
}

/// `playback.rtxSuperResolution` from the stored settings document.
pub fn enabled_in(settings: Option<&Value>) -> bool {
    settings
        .and_then(|s| s.pointer("/playback/rtxSuperResolution"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Keeps track of the filter Kinly added to the running mpv.
#[cfg(windows)]
#[derive(Default)]
pub struct Vsr {
    applied: Option<String>,
}

#[cfg(windows)]
impl Vsr {
    /// A new file starts: drop the previous file's filter (its frames may not be D3D11).
    pub fn reset(&mut self, mpv: &libmpv2::Mpv) {
        if self.applied.take().is_some() {
            let _ = super::command_argv(mpv, &["vf", "remove", LABEL]);
        }
    }

    /// Re-evaluate after playback (re)starts, once `hwdec-current` is known.
    pub fn update(&mut self, app: &tauri::AppHandle, mpv: &libmpv2::Mpv) {
        use tauri::Manager;
        let settings = app.try_state::<crate::store::Store>().and_then(|s| s.load("settings").ok()).and_then(|r| r.value);
        let enabled = enabled_in(settings.as_ref());
        let rtx = crate::caps::get().rtx;
        let int = |name: &str| mpv.get_property::<i64>(name).unwrap_or(0);
        let hw = mpv.get_property::<String>("hwdec-current").unwrap_or_default();
        let src = (int("video-dec-params/w"), int("video-dec-params/h"));
        let mut display = (int("display-width"), int("display-height"));
        if display.0 <= 0 || display.1 <= 0 {
            display = (int("osd-width"), int("osd-height"));
        }
        let want = filter(enabled, rtx, &hw, src, display);
        if want == self.applied {
            return;
        }
        if self.applied.take().is_some() {
            let _ = super::command_argv(mpv, &["vf", "remove", LABEL]);
        }
        if let Some(f) = want {
            match super::command_argv(mpv, &["vf", "add", &f]) {
                Ok(()) => {
                    crate::log_info!("player", "RTX Video Super Resolution on: {f} ({}x{} -> {}x{})", src.0, src.1, display.0, display.1);
                    self.applied = Some(f);
                }
                Err(e) => crate::log_warn!("player", "RTX Video Super Resolution filter rejected: {e}"),
            }
        } else if enabled && rtx {
            crate::log_info!("player", "RTX Video Super Resolution idle (hwdec={hw}, {}x{} on {}x{})", src.0, src.1, display.0, display.1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scales_only_below_display_resolution() {
        assert_eq!(scale_for((1920, 1080), (3840, 2160)), Some(2.0));
        assert_eq!(scale_for((1280, 720), (2560, 1440)), Some(2.0));
        // Letterboxed scope source: the narrower axis decides.
        assert_eq!(scale_for((1920, 800), (2560, 1440)), Some(1.33));
        assert_eq!(scale_for((640, 360), (7680, 4320)), Some(4.0));
        assert_eq!(scale_for((1920, 1080), (1920, 1080)), None);
        assert_eq!(scale_for((3840, 2160), (1920, 1080)), None);
        assert_eq!(scale_for((1920, 1080), (1920, 1200)), None);
        assert_eq!(scale_for((0, 0), (1920, 1080)), None);
    }

    #[test]
    fn builds_the_d3d11vpp_filter() {
        assert_eq!(
            filter(true, true, "d3d11va", (1920, 1080), (3840, 2160)).as_deref(),
            Some("@kinly-vsr:d3d11vpp=scale=2.00:scaling-mode=nvidia")
        );
        assert_eq!(
            filter(true, true, "d3d11va", (1280, 720), (1920, 1080)).as_deref(),
            Some("@kinly-vsr:d3d11vpp=scale=1.50:scaling-mode=nvidia")
        );
        // Needs the setting, an RTX GPU, and zero-copy D3D11 frames.
        assert_eq!(filter(false, true, "d3d11va", (1280, 720), (1920, 1080)), None);
        assert_eq!(filter(true, false, "d3d11va", (1280, 720), (1920, 1080)), None);
        assert_eq!(filter(true, true, "d3d11va-copy", (1280, 720), (1920, 1080)), None);
        assert_eq!(filter(true, true, "no", (1280, 720), (1920, 1080)), None);
        assert_eq!(filter(true, true, "d3d11va", (3840, 2160), (3840, 2160)), None);
    }

    #[test]
    fn reads_the_setting() {
        assert!(enabled_in(Some(&json!({"playback": {"rtxSuperResolution": true}}))));
        assert!(!enabled_in(Some(&json!({"playback": {"rtxSuperResolution": "yes"}}))));
        assert!(!enabled_in(Some(&json!({"playback": {}}))));
        assert!(!enabled_in(None));
    }
}
