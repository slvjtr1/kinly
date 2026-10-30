//! GPU discovery and render-GPU selection.
//!
//! `configure()` runs at process start, before GTK/WebKit create any GL
//! context, because the PRIME variables are read when the GL/EGL vendor
//! libraries load. It reads `/sys/class/drm/card*` (vendor, device, boot_vga,
//! driver) and `/proc/driver/nvidia`, then on hybrid machines asks the driver
//! stack to render Kinly on the discrete GPU:
//!
//! - NVIDIA proprietary (PRIME on-demand): `__NV_PRIME_RENDER_OFFLOAD=1`,
//!   `__GLX_VENDOR_LIBRARY_NAME=nvidia`, `__VK_LAYER_NV_optimus=NVIDIA_only`.
//!   X11 only by default: GTK3 on Wayland renders through EGL, where these
//!   variables would move the WebKit web process to NVIDIA EGL too, the stack
//!   that already needs the explicit-sync workaround. `KINLY_GPU=discrete`
//!   applies them on Wayland as well.
//! - Mesa (amdgpu, radeon, nouveau): `DRI_PRIME=1`.
//!
//! Nothing is set when the user already set any of these variables, when the
//! discrete GPU is already the primary renderer (`prime-select nvidia`, desktop
//! with one card), or with `KINLY_GPU=integrated`.
//!
//! On Windows the GPU list comes from DXGI instead (see `gpu_windows.rs`) and no
//! environment variables are involved: mpv is pointed at the chosen adapter
//! with `d3d11-adapter`, and WebView2 gets a high-performance GPU hint.

// The DRM scan and the PRIME policy are pure and unit tested on every OS, but
// only Linux calls them.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::path::Path;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vendor {
    Nvidia,
    Amd,
    Intel,
    Other,
}

impl Vendor {
    pub fn from_id(id: u16) -> Vendor {
        match id {
            0x10de => Vendor::Nvidia,
            0x1002 | 0x1022 => Vendor::Amd,
            0x8086 => Vendor::Intel,
            _ => Vendor::Other,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Vendor::Nvidia => "nvidia",
            Vendor::Amd => "amd",
            Vendor::Intel => "intel",
            Vendor::Other => "other",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Gpu {
    /// `card1`
    pub card: String,
    pub vendor: Vendor,
    pub device_id: u16,
    /// Kernel driver: `nvidia`, `i915`, `xe`, `amdgpu`, `nouveau`, ...
    pub driver: String,
    pub boot_vga: bool,
    /// `0000:01:00.0`
    pub pci_slot: String,
    /// `/dev/dri/renderD128`
    pub render_node: Option<String>,
    /// Discrete VRAM in bytes when the driver reports it (amdgpu; DXGI on Windows).
    pub vram_bytes: Option<u64>,
    /// Marketing name when the platform reports one (DXGI adapter description on Windows).
    pub name: Option<String>,
}

impl Gpu {
    pub fn nvidia_proprietary(&self) -> bool {
        self.vendor == Vendor::Nvidia && self.driver == "nvidia"
    }
}

/// Discrete vs integrated, decided per GPU with the whole set in view.
pub fn is_discrete(g: &Gpu, all: &[Gpu]) -> bool {
    match g.vendor {
        Vendor::Nvidia => true,
        // Intel Arc (DG2/Battlemage) are discrete; everything else Intel ships is integrated.
        Vendor::Intel => matches!(g.device_id >> 8, 0x56 | 0xe2),
        // amdgpu reports the VRAM carve-out of APUs too (usually <= 512 MiB);
        // in a hybrid laptop the dGPU is the one that did not boot the display.
        Vendor::Amd => {
            g.vram_bytes.map(|v| v > 1536 * 1024 * 1024).unwrap_or(false) || (all.len() > 1 && !g.boot_vga)
        }
        Vendor::Other => false,
    }
}

fn read_trim(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string())
}

fn hex_u16(s: &str) -> Option<u16> {
    u16::from_str_radix(s.trim().trim_start_matches("0x"), 16).ok()
}

/// Every DRM card with a PCI device, sorted by card number.
pub fn scan_drm(root: &Path) -> Vec<Gpu> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else { return out };
    for e in rd.flatten() {
        let card = e.file_name().to_string_lossy().into_owned();
        let Some(num) = card.strip_prefix("card") else { continue };
        if num.is_empty() || !num.chars().all(|c| c.is_ascii_digit()) {
            continue; // connectors such as card1-HDMI-A-1
        }
        let dev = e.path().join("device");
        let (Some(vendor), Some(device_id)) =
            (read_trim(&dev.join("vendor")).and_then(|s| hex_u16(&s)), read_trim(&dev.join("device")).and_then(|s| hex_u16(&s)))
        else {
            continue;
        };
        let driver = std::fs::read_link(dev.join("driver"))
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_default();
        let pci_slot = std::fs::canonicalize(&dev)
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_default();
        let render_node = std::fs::read_dir(dev.join("drm")).ok().and_then(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .find(|n| n.starts_with("renderD"))
                .map(|n| format!("/dev/dri/{n}"))
        });
        out.push(Gpu {
            card,
            vendor: Vendor::from_id(vendor),
            device_id,
            driver,
            boot_vga: read_trim(&dev.join("boot_vga")).as_deref() == Some("1"),
            pci_slot,
            render_node,
            vram_bytes: read_trim(&dev.join("mem_info_vram_total")).and_then(|s| s.parse().ok()),
            name: None,
        });
    }
    out.sort_by_key(|g| g.card.trim_start_matches("card").parse::<u32>().unwrap_or(u32::MAX));
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Auto,
    Integrated,
    Discrete,
}

pub fn parse_mode(v: Option<&str>) -> Mode {
    match v.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("integrated") | Some("igpu") => Mode::Integrated,
        Some("discrete") | Some("dgpu") => Mode::Discrete,
        _ => Mode::Auto,
    }
}

/// Whether the X screen already runs on the NVIDIA GPU ("prime-select nvidia").
/// Ubuntu's prime-select writes its mode to /etc/prime-discrete; elsewhere the
/// Xorg log names the NVIDIA screen `NVIDIA(0)` when it is primary and
/// `NVIDIA(G0)` when it is only an offload sink.
pub fn nvidia_primary_hint(prime_discrete: Option<&str>, xorg_log: Option<&str>) -> Option<bool> {
    match prime_discrete.map(str::trim) {
        Some("on") => return Some(true),
        Some("on-demand") | Some("off") => return Some(false),
        _ => {}
    }
    let log = xorg_log?;
    if log.contains("NVIDIA(0):") {
        Some(true)
    } else if log.contains("NVIDIA(G0)") {
        Some(false)
    } else {
        None
    }
}

const NV_VARS: [(&str, &str); 3] = [
    ("__NV_PRIME_RENDER_OFFLOAD", "1"),
    ("__GLX_VENDOR_LIBRARY_NAME", "nvidia"),
    ("__VK_LAYER_NV_optimus", "NVIDIA_only"),
];

pub struct Inputs<'a> {
    pub gpus: &'a [Gpu],
    pub mode: Mode,
    pub wayland: bool,
    pub nvidia_primary: Option<bool>,
    /// Looks up a variable in the environment the process started with.
    pub env: &'a dyn Fn(&str) -> Option<String>,
}

#[derive(Debug, Clone)]
pub struct Decision {
    /// Index into the GPU list of the GPU that renders Kinly.
    pub render: Option<usize>,
    /// Variables to set (never overwrites existing ones).
    pub set: Vec<(&'static str, &'static str)>,
    pub reason: String,
}

pub fn decide(i: &Inputs) -> Decision {
    let gpus = i.gpus;
    let dec = |render: Option<usize>, set: Vec<(&'static str, &'static str)>, reason: String| Decision { render, set, reason };
    if gpus.is_empty() {
        return dec(None, vec![], "no DRM GPU found".into());
    }
    let nv = gpus.iter().position(|g| g.nvidia_proprietary());
    let primary = match (nv, i.nvidia_primary) {
        (Some(n), Some(true)) => n,
        (Some(n), None) if gpus.len() == 1 => n,
        _ => gpus.iter().position(|g| g.boot_vga).unwrap_or(0),
    };
    if gpus.len() == 1 {
        return dec(Some(0), vec![], "single GPU; nothing to select".into());
    }
    // Prefer the proprietary NVIDIA driver, then any other discrete GPU.
    let discrete = nv.or_else(|| gpus.iter().position(|g| is_discrete(g, gpus)));
    let Some(d) = discrete else {
        return dec(Some(primary), vec![], "no discrete GPU; using the primary GPU".into());
    };
    if d == primary {
        let why = if i.mode == Mode::Integrated {
            "KINLY_GPU=integrated, but the discrete GPU drives the display (e.g. prime-select nvidia); cannot switch from inside the app"
        } else {
            "discrete GPU is already the primary renderer"
        };
        return dec(Some(d), vec![], why.into());
    }
    if i.mode == Mode::Integrated {
        return dec(Some(primary), vec![], "KINLY_GPU=integrated: staying on the primary (integrated) GPU".into());
    }
    if gpus[d].nvidia_proprietary() {
        if let Some((k, _)) = NV_VARS.iter().find(|(k, _)| (i.env)(k).is_some()) {
            let offload = (i.env)("__NV_PRIME_RENDER_OFFLOAD").as_deref() == Some("1");
            return dec(
                Some(if offload { d } else { primary }),
                vec![],
                format!("{k} is already set by the user; leaving PRIME offload as it is"),
            );
        }
        // With the offload variables set while NVIDIA already
        // drives the X screen (prime-select nvidia), mpv's render context fails
        // to initialise (MPV_ERROR_UNSUPPORTED) and no video shows. So offload
        // only on positive evidence of on-demand mode.
        if i.nvidia_primary != Some(false) && i.mode == Mode::Auto {
            return dec(
                Some(primary),
                vec![],
                "NVIDIA PRIME mode unknown (no /etc/prime-discrete or Xorg log hint); not forcing offload (KINLY_GPU=discrete forces it)".into(),
            );
        }
        if i.wayland && i.mode == Mode::Auto {
            return dec(
                Some(primary),
                vec![],
                "Wayland session: NVIDIA offload is not applied automatically (set KINLY_GPU=discrete to force)".into(),
            );
        }
        return dec(Some(d), NV_VARS.to_vec(), "rendering on the NVIDIA GPU via PRIME render offload".into());
    }
    if (i.env)("DRI_PRIME").is_some() {
        return dec(Some(primary), vec![], "DRI_PRIME is already set by the user; leaving it".into());
    }
    dec(Some(d), vec![("DRI_PRIME", "1")], "rendering on the discrete GPU via DRI_PRIME".into())
}

pub struct GpuState {
    pub gpus: Vec<Gpu>,
    pub decision: Decision,
}

static STATE: OnceLock<GpuState> = OnceLock::new();

#[cfg(target_os = "linux")]
fn wayland_session() -> bool {
    std::env::var("XDG_SESSION_TYPE").map(|v| v.eq_ignore_ascii_case("wayland")).unwrap_or(false)
        || std::env::var("WAYLAND_DISPLAY").map(|v| !v.is_empty()).unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn xorg_log() -> Option<String> {
    let n = std::env::var("DISPLAY")
        .ok()
        .and_then(|d| d.rsplit(':').next().and_then(|s| s.split('.').next()).map(str::to_string))
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or_else(|| "0".into());
    let mut paths = vec![std::path::PathBuf::from(format!("/var/log/Xorg.{n}.log"))];
    if let Some(d) = dirs::data_local_dir() {
        paths.insert(0, d.join(format!("xorg/Xorg.{n}.log")));
    }
    paths.into_iter().find_map(|p| std::fs::read_to_string(p).ok())
}

/// Detect GPUs and set the PRIME variables. Call once, first thing in `run()`.
#[cfg(target_os = "linux")]
pub fn configure() {
    let gpus = scan_drm(Path::new("/sys/class/drm"));
    let env = |k: &str| std::env::var(k).ok();
    let has_nv = gpus.iter().any(|g| g.nvidia_proprietary()) && Path::new("/proc/driver/nvidia/version").exists();
    let nvidia_primary = if has_nv {
        nvidia_primary_hint(read_trim(Path::new("/etc/prime-discrete")).as_deref(), xorg_log().as_deref())
    } else {
        None
    };
    let raw_mode = std::env::var("KINLY_GPU").ok();
    let mode = parse_mode(raw_mode.as_deref());
    let decision = decide(&Inputs { gpus: &gpus, mode, wayland: wayland_session(), nvidia_primary, env: &env });
    for (k, v) in &decision.set {
        std::env::set_var(k, v);
    }
    let state = GpuState { gpus, decision };
    crate::logging::write("INFO", "gpu", &summary(&state));
    let _ = STATE.set(state);
}

/// Detect GPUs through DXGI and pick the render adapter (no environment
/// variables except the WebView2 GPU hint). Call once, first thing in `run()`.
#[cfg(windows)]
pub fn configure() {
    let gpus = crate::gpu_windows::scan();
    let mode = parse_mode(std::env::var("KINLY_GPU").ok().as_deref());
    let preferred = crate::gpu_windows::high_performance_index(&gpus);
    let decision = crate::gpu_windows::decide(&gpus, mode, preferred);
    crate::gpu_windows::hint_webview2(&gpus, &decision);
    let state = GpuState { gpus, decision };
    crate::logging::write("INFO", "gpu", &summary(&state));
    let _ = STATE.set(state);
}

#[cfg(not(any(target_os = "linux", windows)))]
pub fn configure() {}

/// The platform's GPU list (DRM on Linux, DXGI on Windows).
fn scan_platform() -> Vec<Gpu> {
    #[cfg(target_os = "linux")]
    return scan_drm(Path::new("/sys/class/drm"));
    #[cfg(windows)]
    return crate::gpu_windows::scan();
    #[cfg(not(any(target_os = "linux", windows)))]
    return Vec::new();
}

pub fn summary(s: &GpuState) -> String {
    let list = s
        .gpus
        .iter()
        .map(|g| {
            format!(
                "{}={}:{:04x}/{}{}{}",
                g.card,
                g.vendor.label(),
                g.device_id,
                g.driver,
                if g.boot_vga { "/boot_vga" } else { "" },
                if is_discrete(g, &s.gpus) { "/discrete" } else { "" }
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let render = s.decision.render.and_then(|i| s.gpus.get(i)).map(|g| g.card.as_str()).unwrap_or("?");
    let set = if s.decision.set.is_empty() {
        "none".to_string()
    } else {
        s.decision.set.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(" ")
    };
    format!("GPUs [{list}]; render on {render}: {}; env set: {set}", s.decision.reason)
}

/// Detection result; falls back to a fresh scan when `configure` never ran (tests, examples).
pub fn state() -> &'static GpuState {
    STATE.get_or_init(|| {
        let gpus = scan_platform();
        let render = gpus.iter().position(|g| g.boot_vga).or(if gpus.is_empty() { None } else { Some(0) });
        GpuState { gpus, decision: Decision { render, set: vec![], reason: "not configured".into() } }
    })
}

pub fn render_gpu() -> Option<&'static Gpu> {
    let s = state();
    s.decision.render.and_then(|i| s.gpus.get(i))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu(card: &str, vendor: Vendor, device_id: u16, driver: &str, boot_vga: bool) -> Gpu {
        Gpu {
            card: card.into(),
            vendor,
            device_id,
            driver: driver.into(),
            boot_vga,
            pci_slot: String::new(),
            render_node: None,
            vram_bytes: None,
            name: None,
        }
    }

    /// A typical Optimus laptop: Intel HD 620 (boot VGA) + a Maxwell GeForce on the proprietary driver.
    fn optimus() -> Vec<Gpu> {
        vec![gpu("card1", Vendor::Nvidia, 0x179c, "nvidia", false), gpu("card2", Vendor::Intel, 0x5916, "i915", true)]
    }

    fn run(gpus: &[Gpu], mode: Mode, wayland: bool, nv_primary: Option<bool>, env: &[(&str, &str)]) -> Decision {
        let env: Vec<(String, String)> = env.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        let look = move |k: &str| env.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone());
        decide(&Inputs { gpus, mode, wayland, nvidia_primary: nv_primary, env: &look })
    }

    #[test]
    fn on_demand_nvidia_gets_offload() {
        let d = run(&optimus(), Mode::Auto, false, Some(false), &[]);
        assert_eq!(d.render, Some(0));
        assert_eq!(d.set.len(), 3);
        assert!(d.set.contains(&("__NV_PRIME_RENDER_OFFLOAD", "1")));
    }

    #[test]
    fn prime_select_nvidia_needs_nothing() {
        let d = run(&optimus(), Mode::Auto, false, Some(true), &[]);
        assert_eq!(d.render, Some(0));
        assert!(d.set.is_empty(), "{d:?}");
    }

    #[test]
    fn user_variables_and_opt_out_are_respected() {
        let d = run(&optimus(), Mode::Auto, false, Some(false), &[("__GLX_VENDOR_LIBRARY_NAME", "mesa")]);
        assert!(d.set.is_empty());
        assert_eq!(d.render, Some(1));
        let d = run(&optimus(), Mode::Integrated, false, Some(false), &[]);
        assert!(d.set.is_empty());
        assert_eq!(d.render, Some(1));
    }

    #[test]
    fn wayland_offload_only_when_forced() {
        assert!(run(&optimus(), Mode::Auto, true, Some(false), &[]).set.is_empty());
        assert_eq!(run(&optimus(), Mode::Discrete, true, Some(false), &[]).set.len(), 3);
    }

    #[test]
    fn mesa_dgpu_uses_dri_prime() {
        let g = vec![gpu("card0", Vendor::Intel, 0x9a49, "i915", true), gpu("card1", Vendor::Amd, 0x73ff, "amdgpu", false)];
        let d = run(&g, Mode::Auto, true, None, &[]);
        assert_eq!(d.set, vec![("DRI_PRIME", "1")]);
        assert_eq!(d.render, Some(1));
        assert!(run(&g, Mode::Auto, false, None, &[("DRI_PRIME", "0")]).set.is_empty());
    }

    #[test]
    fn single_and_integrated_only_machines_are_left_alone() {
        let one = vec![gpu("card0", Vendor::Intel, 0x5916, "i915", true)];
        assert!(run(&one, Mode::Discrete, false, None, &[]).set.is_empty());
        // AMD APU: small carve-out, boot VGA.
        let mut apu = gpu("card0", Vendor::Amd, 0x1638, "amdgpu", true);
        apu.vram_bytes = Some(512 * 1024 * 1024);
        assert!(!is_discrete(&apu, std::slice::from_ref(&apu)));
    }

    #[test]
    fn unknown_prime_mode_is_not_forced() {
        assert!(run(&optimus(), Mode::Auto, false, None, &[]).set.is_empty());
        assert_eq!(run(&optimus(), Mode::Discrete, false, None, &[]).set.len(), 3);
    }

    #[test]
    fn prime_hints() {
        assert_eq!(nvidia_primary_hint(Some("on\n"), None), Some(true));
        assert_eq!(nvidia_primary_hint(Some("on-demand"), Some("NVIDIA(0):")), Some(false));
        assert_eq!(nvidia_primary_hint(None, Some("[ 16.0] (II) NVIDIA(G0): ...")), Some(false));
        assert_eq!(nvidia_primary_hint(None, Some("[ 16.0] (II) NVIDIA(0): Depth 24")), Some(true));
        assert_eq!(nvidia_primary_hint(None, None), None);
    }

    #[test]
    fn parses_mode() {
        assert_eq!(parse_mode(Some("Integrated")), Mode::Integrated);
        assert_eq!(parse_mode(Some("discrete")), Mode::Discrete);
        assert_eq!(parse_mode(Some("bogus")), Mode::Auto);
        assert_eq!(parse_mode(None), Mode::Auto);
    }
}
