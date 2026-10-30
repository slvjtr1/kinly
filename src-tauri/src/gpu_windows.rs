//! Windows GPU discovery and hardware-decode probing.
//!
//! - Adapters come from DXGI (`IDXGIFactory1::EnumAdapters1`). DXGI lists the
//!   adapter that drives the primary display first, so that one plays the role
//!   of Linux's `boot_vga`. WARP / the Microsoft Basic Render Driver is skipped.
//! - The render adapter on hybrid laptops is the one DXGI ranks first for
//!   `DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE` (which follows the per-app choice in
//!   Windows Settings > Display > Graphics), unless `KINLY_GPU=integrated`.
//!   mpv is pointed at it with `d3d11-adapter`; WebView2 gets
//!   `--force_high_performance_gpu` (best effort: the WebView2 GPU process is a
//!   separate `msedgewebview2.exe`).
//! - Decode support comes from the adapter's D3D11 video decoder profiles
//!   (`ID3D11VideoDevice::GetVideoDecoderProfile`), the same list d3d11va uses.
//!
//! The policy functions are pure and compiled on every OS so they are unit
//! tested on Linux too; only the probing is `cfg(windows)`.

#![cfg_attr(not(windows), allow(dead_code))]

use crate::caps::{Codecs, Derived};
use crate::gpu::{is_discrete, Decision, Gpu, Mode, Vendor};

/// PCI vendor id of WARP / the Microsoft Basic Render Driver.
const MICROSOFT_VENDOR: u32 = 0x1414;

/// D3D11 decoder profile GUIDs (`D3D11_DECODER_PROFILE_*`), as u128 so the
/// mapping can be tested without the Windows headers.
pub const PROFILE_H264_VLD_NOFGT: u128 = 0x1b81be68_a0c7_11d3_b984_00c04f2e73c5;
pub const PROFILE_HEVC_VLD_MAIN: u128 = 0x5b11d51b_2f4c_4452_bcc3_09f2a1160cc0;
pub const PROFILE_HEVC_VLD_MAIN10: u128 = 0x107af0e0_ef1a_4d19_aba8_67a163073d13;
pub const PROFILE_VP9_VLD_PROFILE0: u128 = 0x463707f8_a1d0_4585_876d_83aa6d60b89e;
pub const PROFILE_AV1_VLD_PROFILE0: u128 = 0xb8be4ccb_cf53_46ba_8d59_d6b8a6da5d2a;

/// One DXGI adapter as reported by `GetDesc1`.
#[derive(Clone, Debug)]
pub struct Adapter {
    /// `EnumAdapters1` index.
    pub index: u32,
    pub name: String,
    pub vendor_id: u32,
    pub device_id: u32,
    pub dedicated_vram: u64,
    pub software: bool,
}

/// Hardware adapters as [`Gpu`]s, in DXGI order (primary display adapter first).
pub fn to_gpus(adapters: &[Adapter]) -> Vec<Gpu> {
    adapters
        .iter()
        .filter(|a| !a.software && a.vendor_id != MICROSOFT_VENDOR)
        .enumerate()
        .map(|(i, a)| Gpu {
            card: format!("dxgi{}", a.index),
            vendor: Vendor::from_id(a.vendor_id as u16),
            device_id: a.device_id as u16,
            driver: "d3d11".into(),
            boot_vga: i == 0,
            pci_slot: String::new(),
            render_node: None,
            vram_bytes: Some(a.dedicated_vram),
            name: Some(a.name.trim().to_string()).filter(|n| !n.is_empty()),
        })
        .collect()
}

/// Pick the render GPU. `preferred` is the index (into `gpus`) DXGI ranks first
/// for high performance, when it could be determined.
pub fn decide(gpus: &[Gpu], mode: Mode, preferred: Option<usize>) -> Decision {
    let dec = |render: Option<usize>, reason: &str| Decision { render, set: vec![], reason: reason.into() };
    if gpus.is_empty() {
        return dec(None, "no DXGI hardware adapter found");
    }
    if gpus.len() == 1 {
        return dec(Some(0), "single GPU; nothing to select");
    }
    let primary = gpus.iter().position(|g| g.boot_vga).unwrap_or(0);
    if mode == Mode::Integrated {
        return dec(Some(primary), "KINLY_GPU=integrated: rendering on the adapter that drives the display");
    }
    if let Some(p) = preferred.filter(|&p| p < gpus.len()) {
        if mode == Mode::Auto || is_discrete(&gpus[p], gpus) {
            return dec(Some(p), "high-performance adapter (DXGI GPU preference)");
        }
    }
    match gpus.iter().position(|g| is_discrete(g, gpus)) {
        Some(d) => dec(Some(d), "first discrete adapter"),
        None => dec(Some(primary), "no discrete GPU; using the adapter that drives the display"),
    }
}

/// Value for mpv's `d3d11-adapter` (matched against the adapter description).
/// Only needed when there is more than one adapter to choose from.
pub fn d3d11_adapter(gpus: &[Gpu], decision: &Decision) -> Option<String> {
    if gpus.len() < 2 {
        return None;
    }
    decision.render.and_then(|i| gpus.get(i)).and_then(|g| g.name.clone())
}

/// Codecs from the decoder profile GUIDs an adapter reports.
pub fn codecs_from_profiles(guids: &[u128]) -> Codecs {
    let has = |g: u128| guids.contains(&g);
    Codecs {
        h264: has(PROFILE_H264_VLD_NOFGT),
        hevc: has(PROFILE_HEVC_VLD_MAIN),
        hevc10: has(PROFILE_HEVC_VLD_MAIN10),
        vp9: has(PROFILE_VP9_VLD_PROFILE0),
        av1: has(PROFILE_AV1_VLD_PROFILE0),
    }
}

/// mpv's hwdec list for Windows: zero-copy D3D11VA (what the d3d11 VO, and
/// RTX Video Super Resolution through d3d11vpp, need), then copy-back, then
/// mpv's own safe choice.
pub const MPV_HWDEC: &str = "d3d11va,d3d11va-copy,auto-safe";

/// Same policy as Linux's `caps::derive`, for a renderer that decodes with
/// zero-copy D3D11VA. `codecs` is `None` when the probe failed.
pub fn derive(codecs: Option<Codecs>, render_discrete: bool, cpu_threads: u32, ram_mb: u64) -> Derived {
    let c = codecs.unwrap_or_default();
    let any = c.h264 || c.hevc || c.hevc10 || c.vp9 || c.av1;
    // Every D3D11 HEVC decoder in the wild (Intel Gen9+, AMD GCN3+, NVIDIA
    // GM206+) handles 2160p; an integrated GPU must also decode HEVC 10-bit
    // (a proxy for "new enough") to be offered 4K.
    let hevc4k = c.hevc || c.hevc10;
    let mut rec = if hevc4k && (render_discrete || c.hevc10) {
        2160
    } else if c.h264 || c.hevc || cpu_threads >= 4 {
        1080
    } else if cpu_threads >= 2 {
        720
    } else {
        480
    };
    if ram_mb > 0 && ram_mb < 3072 {
        rec = rec.min(1080);
    }
    Derived {
        hwdec: c,
        max_hw_height: None,
        recommended_max_height: rec,
        hwdec_api: if any { "d3d11va" } else { "none" },
        mpv_hwdec: MPV_HWDEC.to_string(),
        weak_gpu: !render_discrete,
    }
}

/// wry's own WebView2 arguments (wry 0.57 `webview2/mod.rs`); repeated so the
/// environment variable never drops them, whichever of the two WebView2 uses.
const WRY_DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// The `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` value to set, if any: only on
/// hybrid machines rendering on a discrete GPU, and never over a user value.
pub fn webview2_args(gpus: &[Gpu], decision: &Decision, existing: Option<&str>) -> Option<String> {
    if existing.is_some_and(|v| !v.trim().is_empty()) || gpus.len() < 2 {
        return None;
    }
    let g = decision.render.and_then(|i| gpus.get(i))?;
    (is_discrete(g, gpus) && !g.boot_vga).then(|| format!("{WRY_DEFAULT_ARGS} --force_high_performance_gpu"))
}

#[cfg(windows)]
pub use probe::*;

#[cfg(windows)]
mod probe {
    use super::*;
    use windows::core::Interface;
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11VideoDevice, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION,
    };
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIFactory6, DXGI_ADAPTER_FLAG_SOFTWARE,
        DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
    };

    fn describe(index: u32, a: &IDXGIAdapter1) -> Option<Adapter> {
        let d = unsafe { a.GetDesc1() }.ok()?;
        let end = d.Description.iter().position(|&c| c == 0).unwrap_or(d.Description.len());
        Some(Adapter {
            index,
            name: String::from_utf16_lossy(&d.Description[..end]),
            vendor_id: d.VendorId,
            device_id: d.DeviceId,
            dedicated_vram: d.DedicatedVideoMemory as u64,
            software: d.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0,
        })
    }

    pub fn adapters() -> Vec<Adapter> {
        let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else { return vec![] };
        let mut out = Vec::new();
        for i in 0..16u32 {
            let Ok(a) = (unsafe { factory.EnumAdapters1(i) }) else { break };
            if let Some(d) = describe(i, &a) {
                out.push(d);
            }
        }
        out
    }

    /// Hardware GPUs, primary display adapter first.
    pub fn scan() -> Vec<Gpu> {
        to_gpus(&adapters())
    }

    /// Index into `gpus` of the adapter DXGI ranks first for high performance.
    pub fn high_performance_index(gpus: &[Gpu]) -> Option<usize> {
        let factory = unsafe { CreateDXGIFactory1::<IDXGIFactory6>() }.ok()?;
        for i in 0..16u32 {
            let a: IDXGIAdapter1 = unsafe { factory.EnumAdapterByGpuPreference(i, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE) }.ok()?;
            let Some(d) = describe(i, &a) else { continue };
            if d.software || d.vendor_id == MICROSOFT_VENDOR {
                continue;
            }
            let name = d.name.trim();
            return gpus
                .iter()
                .position(|g| g.device_id == d.device_id as u16 && g.name.as_deref() == Some(name));
        }
        None
    }

    /// Ask WebView2 for the high-performance GPU on hybrid machines. Must run
    /// before the webview is created.
    pub fn hint_webview2(gpus: &[Gpu], decision: &Decision) {
        const VAR: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
        let existing = std::env::var(VAR).ok();
        if let Some(v) = webview2_args(gpus, decision, existing.as_deref()) {
            crate::logging::write("INFO", "gpu", &format!("{VAR}={v}"));
            std::env::set_var(VAR, v);
        }
    }

    /// Decoder profiles of the adapter with this `EnumAdapters1` index.
    pub fn probe_decoders(index: u32) -> Option<Codecs> {
        let factory = unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }.ok()?;
        let adapter = unsafe { factory.EnumAdapters1(index) }.ok()?;
        let mut device: Option<ID3D11Device> = None;
        unsafe {
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
        }
        .ok()?;
        let video: ID3D11VideoDevice = device?.cast().ok()?;
        let n = unsafe { video.GetVideoDecoderProfileCount() };
        let guids: Vec<u128> = (0..n).filter_map(|i| unsafe { video.GetVideoDecoderProfile(i) }.ok()).map(|g| g.to_u128()).collect();
        Some(codecs_from_profiles(&guids))
    }

    pub fn ram_mb() -> u64 {
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut m = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        match unsafe { GlobalMemoryStatusEx(&mut m) } {
            Ok(()) => m.ullTotalPhys / (1024 * 1024),
            Err(_) => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter(index: u32, name: &str, vendor_id: u32, device_id: u32, vram_mb: u64) -> Adapter {
        Adapter { index, name: name.into(), vendor_id, device_id, dedicated_vram: vram_mb << 20, software: false }
    }

    /// A hybrid laptop as DXGI reports it: Intel (display) first, NVIDIA second, then WARP.
    fn hybrid() -> Vec<Gpu> {
        let mut warp = adapter(2, "Microsoft Basic Render Driver", 0x1414, 0x8c, 0);
        warp.software = true;
        to_gpus(&[
            adapter(0, "Intel(R) UHD Graphics 770", 0x8086, 0x4680, 128),
            adapter(1, "NVIDIA GeForce RTX 4060 Laptop GPU", 0x10de, 0x28a0, 8192),
            warp,
        ])
    }

    #[test]
    fn adapters_become_gpus_without_warp() {
        let g = hybrid();
        assert_eq!(g.len(), 2);
        assert!(g[0].boot_vga && !g[1].boot_vga);
        assert_eq!(g[1].vendor, Vendor::Nvidia);
        assert_eq!(g[1].name.as_deref(), Some("NVIDIA GeForce RTX 4060 Laptop GPU"));
        assert!(!is_discrete(&g[0], &g) && is_discrete(&g[1], &g));
    }

    #[test]
    fn hybrid_renders_on_the_high_performance_adapter() {
        let g = hybrid();
        let d = decide(&g, Mode::Auto, Some(1));
        assert_eq!(d.render, Some(1));
        assert!(d.set.is_empty());
        assert_eq!(d3d11_adapter(&g, &d).as_deref(), Some("NVIDIA GeForce RTX 4060 Laptop GPU"));
        // Without the DXGI preference the first discrete adapter wins.
        assert_eq!(decide(&g, Mode::Auto, None).render, Some(1));
        // The user's opt-out keeps the display adapter.
        let d = decide(&g, Mode::Integrated, Some(1));
        assert_eq!(d.render, Some(0));
        assert_eq!(d3d11_adapter(&g, &d).as_deref(), Some("Intel(R) UHD Graphics 770"));
    }

    #[test]
    fn single_gpu_needs_no_adapter_option() {
        let g = to_gpus(&[adapter(0, "AMD Radeon RX 7800 XT", 0x1002, 0x747e, 16384)]);
        let d = decide(&g, Mode::Auto, Some(0));
        assert_eq!(d.render, Some(0));
        assert_eq!(d3d11_adapter(&g, &d), None);
        assert!(decide(&[], Mode::Auto, None).render.is_none());
    }

    #[test]
    fn decoder_profiles_map_to_codecs() {
        let c = codecs_from_profiles(&[PROFILE_H264_VLD_NOFGT, PROFILE_HEVC_VLD_MAIN, PROFILE_HEVC_VLD_MAIN10, 0x1234]);
        assert_eq!(c, Codecs { h264: true, hevc: true, hevc10: true, vp9: false, av1: false });
        assert_eq!(codecs_from_profiles(&[]), Codecs::default());
    }

    #[test]
    fn windows_policy() {
        let full = codecs_from_profiles(&[PROFILE_H264_VLD_NOFGT, PROFILE_HEVC_VLD_MAIN, PROFILE_HEVC_VLD_MAIN10, PROFILE_VP9_VLD_PROFILE0]);
        let d = derive(Some(full), true, 8, 16000);
        assert_eq!((d.recommended_max_height, d.hwdec_api, d.weak_gpu), (2160, "d3d11va", false));
        assert_eq!(d.mpv_hwdec, "d3d11va,d3d11va-copy,auto-safe");
        // Old integrated GPU: H.264 + 8-bit HEVC only.
        let old = codecs_from_profiles(&[PROFILE_H264_VLD_NOFGT, PROFILE_HEVC_VLD_MAIN]);
        assert_eq!(derive(Some(old), false, 4, 8000).recommended_max_height, 1080);
        // Probe failed, two threads, little RAM.
        let d = derive(None, false, 2, 2048);
        assert_eq!((d.recommended_max_height, d.hwdec_api), (720, "none"));
    }

    #[test]
    fn webview2_hint_only_for_hybrid_discrete() {
        let g = hybrid();
        let d = decide(&g, Mode::Auto, Some(1));
        let v = webview2_args(&g, &d, None).unwrap();
        assert!(v.contains("--force_high_performance_gpu") && v.starts_with(WRY_DEFAULT_ARGS));
        assert_eq!(webview2_args(&g, &d, Some("--foo")), None);
        assert_eq!(webview2_args(&g, &decide(&g, Mode::Integrated, None), None), None);
    }
}
