//! Device capabilities: GPUs, hardware video decode, and the highest resolution
//! the device should be offered for smooth playback.
//!
//! Probes run once, in parallel worker threads with timeouts, and are cached:
//! - `vainfo -a --display drm --device <render node>` per GPU (VA-API profiles
//!   and their max picture size; plain `vainfo` output is understood too);
//! - `vdpauinfo` with `VDPAU_DRIVER=nvidia` (NVDEC's decoder table; VDPAU and
//!   NVDEC share the same hardware engine);
//! - `nvidia-smi` for the marketing name.
//!
//! When `vdpauinfo` cannot answer (not installed, PRIME offload mode) NVDEC
//! support comes from the NVIDIA Video Codec SDK matrix by GPU generation
//! ([`nvdec_table`]). When `vainfo` is not installed, an Intel/AMD GPU on a
//! VA-API kernel driver is assumed to decode H.264 and 8-bit HEVC (true for
//! every Intel Gen9 / AMD GCN3 or newer part), with unknown size limits.
//!
//! Some laptop parts the table lists as capable have no usable decoder (seen on
//! a Maxwell GM108 with driver 580): `vdpauinfo` reports "doesn't have a
//! supported video decoder" and ffmpeg's CUDA hwaccel fails with "Hardware is
//! lacking required capabilities" for H.264, HEVC and VP9, so the probe result,
//! not the table, decides.
//!
//! ## recommendedMaxHeight
//! 1. 2160 when a *zero-copy* hardware decoder for HEVC at >= 2160 lines runs on
//!    the GPU that renders (NVDEC on an NVIDIA renderer; VA-API on the rendering
//!    Intel/AMD GPU under Wayland, where GTK uses EGL) and that GPU is decent
//!    (discrete, or an integrated GPU new enough to decode HEVC 10-bit).
//! 2. 2160 with a copy-back decoder (`*-copy`: frames go GPU -> RAM -> GPU)
//!    only with >= 8 CPU threads. With 4 threads, 4K HEVC 10-bit through
//!    `vaapi-copy` onto an NVIDIA renderer drops frames.
//!    GTK3 on X11 uses GLX, and VA-API has no GLX interop, so every X11
//!    Intel/AMD machine is on this path.
//! 3. Otherwise 1080 with any hardware H.264/HEVC decoder, or with >= 4 threads
//!    in software; 720 with 2-3 threads; 480 below.
//! 4. Less than 3 GB of RAM caps the result at 1080 (4K demux buffers).
//!
//! ## Windows
//! None of the Linux tools exist there; `gpu_windows` enumerates DXGI adapters
//! and reads the render adapter's D3D11 decoder profiles instead (zero-copy
//! D3D11VA into mpv's d3d11 VO), with the same height policy.

// The Linux probes (vainfo, vdpauinfo, /proc) are unit tested everywhere but
// only called on Linux.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use crate::gpu::{self, Gpu, Vendor};
use serde::Serialize;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Codecs {
    pub h264: bool,
    pub hevc: bool,
    pub hevc10: bool,
    pub vp9: bool,
    pub av1: bool,
}

impl Codecs {
    fn any(&self) -> bool {
        self.h264 || self.hevc || self.hevc10 || self.vp9 || self.av1
    }
    fn union(self, o: Codecs) -> Codecs {
        Codecs {
            h264: self.h264 || o.h264,
            hevc: self.hevc || o.hevc,
            hevc10: self.hevc10 || o.hevc10,
            vp9: self.vp9 || o.vp9,
            av1: self.av1 || o.av1,
        }
    }
}

/// Decode support of one API on one GPU.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DecodeCaps {
    pub codecs: Codecs,
    /// Largest max picture height over the supported codecs, when reported.
    pub max_height: Option<u32>,
    /// Largest max picture height for HEVC (8 or 10 bit), when reported.
    pub hevc_max_height: Option<u32>,
}

impl DecodeCaps {
    fn note(&mut self, codec: &str, height: Option<u32>) {
        match codec {
            "h264" => self.codecs.h264 = true,
            "hevc" => self.codecs.hevc = true,
            "hevc10" => self.codecs.hevc10 = true,
            "vp9" => self.codecs.vp9 = true,
            "av1" => self.codecs.av1 = true,
            _ => return,
        }
        if let Some(h) = height {
            self.max_height = Some(self.max_height.unwrap_or(0).max(h));
            if codec.starts_with("hevc") {
                self.hevc_max_height = Some(self.hevc_max_height.unwrap_or(0).max(h));
            }
        }
    }
}

fn va_codec(profile: &str) -> Option<&'static str> {
    Some(match profile {
        "VAProfileH264Main" | "VAProfileH264High" | "VAProfileH264ConstrainedBaseline" => "h264",
        "VAProfileHEVCMain" => "hevc",
        "VAProfileHEVCMain10" => "hevc10",
        "VAProfileVP9Profile0" => "vp9",
        "VAProfileAV1Profile0" => "av1",
        _ => return None,
    })
}

/// Parse `vainfo` or `vainfo -a`. Returns `None` when the driver did not initialise.
pub fn parse_vainfo(text: &str) -> Option<DecodeCaps> {
    if !text.contains("VAProfile") {
        return None;
    }
    let mut caps = DecodeCaps::default();
    // (codec, is decode entrypoint) of the `-a` block being read.
    let mut block: Option<&'static str> = None;
    let mut pending: Option<&'static str> = None;
    let flush = |caps: &mut DecodeCaps, p: &mut Option<&'static str>| {
        if let Some(c) = p.take() {
            caps.note(c, None);
        }
    };
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("VAConfigAttribMaxPictureHeight") {
            if let (Some(c), Some(h)) = (block, rest.trim_start_matches([' ', '\t', ':']).trim().parse::<u32>().ok()) {
                caps.note(c, Some(h));
                pending = None;
            }
            continue;
        }
        if !t.starts_with("VAProfile") {
            continue;
        }
        flush(&mut caps, &mut pending);
        // "VAProfileX/VAEntrypointVLD" (-a) or "VAProfileX : VAEntrypointVLD".
        let (profile, entry) = match t.split_once('/') {
            Some((p, e)) if !t.contains(':') => (p.trim(), e.trim()),
            _ => match t.split_once(':') {
                Some((p, e)) => (p.trim(), e.trim()),
                None => (t, ""),
            },
        };
        block = (entry == "VAEntrypointVLD").then(|| va_codec(profile)).flatten();
        pending = block;
    }
    flush(&mut caps, &mut pending);
    Some(caps)
}

fn vdpau_codec(name: &str) -> Option<&'static str> {
    Some(match name {
        "H264_MAIN" | "H264_HIGH" | "H264_BASELINE" | "H264_CONSTRAINED_BASELINE" => "h264",
        "HEVC_MAIN" => "hevc",
        "HEVC_MAIN_10" => "hevc10",
        "VP9_PROFILE_0" => "vp9",
        "AV1_MAIN" => "av1",
        _ => return None,
    })
}

#[derive(Debug, PartialEq)]
pub enum Vdpau {
    /// The decoder table was printed.
    Table(DecodeCaps),
    /// The driver answered that this GPU has no video decoder at all.
    NoDecoder,
}

/// Parse `vdpauinfo`. `None` when it could not talk to a VDPAU driver.
pub fn parse_vdpauinfo(text: &str) -> Option<Vdpau> {
    if text.contains("doesn't have a supported video decoder") {
        return Some(Vdpau::NoDecoder);
    }
    let start = text.find("Decoder capabilities")?;
    let mut caps = DecodeCaps::default();
    for line in text[start..].lines().skip(1) {
        let t = line.trim();
        if t.is_empty() || t.starts_with("name") || t.starts_with('-') {
            continue;
        }
        if t.contains("capabilities") {
            break; // next section (Output surface, Video mixer, ...)
        }
        let cols: Vec<&str> = t.split_whitespace().collect();
        if cols.len() < 5 || t.contains("not supported") {
            continue;
        }
        if let Some(c) = vdpau_codec(cols[0]) {
            caps.note(c, cols[4].parse().ok());
        }
    }
    Some(Vdpau::Table(caps))
}

/// `nvidia-smi --query-gpu=name,pci.bus_id --format=csv,noheader`: (name, bus id).
pub fn parse_nvidia_smi(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.split(',').map(str::trim);
            let name = it.next().filter(|s| !s.is_empty())?;
            let bus = it.next().filter(|s| s.contains(':'))?;
            Some((name.to_string(), bus.to_ascii_lowercase()))
        })
        .collect()
}

/// NVDEC support by GPU generation (NVIDIA Video Codec SDK support matrix),
/// keyed by PCI device id. Used only when `vdpauinfo` cannot answer.
pub fn nvdec_table(device_id: u16) -> DecodeCaps {
    let mut c = DecodeCaps::default();
    let mut add = |codecs: &[&str], h: u32| {
        for k in codecs {
            c.note(k, Some(h));
        }
    };
    match device_id {
        // Kepler, Maxwell 1st gen (GM107/GM108, e.g. 940MX) and GM20x big chips: H.264 only.
        0x0fc0..=0x12ff | 0x1340..=0x13ff | 0x1780..=0x17ff => add(&["h264"], 4096),
        // GM206 (GTX 950/960): HEVC 8/10-bit and VP9 in hardware.
        0x1400..=0x143f => {
            add(&["h264"], 4096);
            add(&["hevc", "hevc10", "vp9"], 4096);
        }
        // Pascal, Volta, Turing.
        0x15f0..=0x21ff => {
            add(&["h264"], 4096);
            add(&["hevc", "hevc10", "vp9"], 8192);
        }
        // Ampere, Ada, Blackwell: + AV1.
        0x2200..=0x2fff => {
            add(&["h264"], 4096);
            add(&["hevc", "hevc10", "vp9", "av1"], 8192);
        }
        _ => {}
    }
    c
}

/// Look up a device name in pci.ids.
pub fn pci_name(ids: &str, vendor: u16, device: u16) -> Option<String> {
    let vhead = format!("{vendor:04x}  ");
    let dhead = format!("\t{device:04x}  ");
    let mut in_vendor = false;
    for line in ids.lines() {
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        if !line.starts_with('\t') {
            if in_vendor {
                return None;
            }
            in_vendor = line.starts_with(&vhead);
        } else if in_vendor {
            if let Some(name) = line.strip_prefix(&dhead) {
                // "GM107 [GeForce 940MX]" -> "GeForce 940MX"
                let n = name.trim();
                return Some(match (n.find('['), n.rfind(']')) {
                    (Some(a), Some(b)) if b > a => n[a + 1..b].to_string(),
                    _ => n.to_string(),
                });
            }
        }
    }
    None
}

#[derive(Serialize, Clone, Debug)]
pub struct GpuInfo {
    pub vendor: &'static str,
    pub name: String,
    pub driver: String,
    pub discrete: bool,
    pub active: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SystemCaps {
    pub gpus: Vec<GpuInfo>,
    pub cpu_threads: u32,
    pub ram_mb: u64,
    pub hwdec: Codecs,
    pub max_hw_height: Option<u32>,
    pub recommended_max_height: u32,
    pub hwdec_api: &'static str,
    /// An NVIDIA RTX GPU is present (RTX Video Super Resolution capable on Windows).
    pub rtx: bool,
    /// mpv `hwdec` list derived from the probes.
    #[serde(skip)]
    pub mpv_hwdec: String,
    /// Render node for `vaapi-copy` (mpv's default node may be the NVIDIA one).
    #[serde(skip)]
    pub vaapi_device: Option<String>,
    /// The rendering GPU is weak enough for mpv's `fast` profile.
    #[serde(skip)]
    pub weak_gpu: bool,
}

/// Inputs to [`derive`], separated from the probing so the policy is testable.
pub struct Probed {
    pub render_vendor: Option<Vendor>,
    pub render_discrete: bool,
    pub wayland: bool,
    pub cpu_threads: u32,
    pub ram_mb: u64,
    /// NVDEC on the NVIDIA GPU, if there is one.
    pub nvdec: Option<DecodeCaps>,
    /// VA-API on the chosen device, and whether that device is the renderer.
    pub vaapi: Option<(DecodeCaps, bool)>,
}

pub struct Derived {
    pub hwdec: Codecs,
    pub max_hw_height: Option<u32>,
    pub recommended_max_height: u32,
    pub hwdec_api: &'static str,
    pub mpv_hwdec: String,
    pub weak_gpu: bool,
}

pub fn derive(p: &Probed) -> Derived {
    let nv = p.nvdec.clone().filter(|c| c.codecs.any());
    let va = p.vaapi.clone().filter(|(c, _)| c.codecs.any());
    let render_nv = p.render_vendor == Some(Vendor::Nvidia);
    let hwdec = nv.as_ref().map(|c| c.codecs).unwrap_or_default().union(va.as_ref().map(|c| c.0.codecs).unwrap_or_default());
    let max_hw_height = [nv.as_ref().and_then(|c| c.max_height), va.as_ref().and_then(|c| c.0.max_height)]
        .into_iter()
        .flatten()
        .max();
    let hwdec_api = match (&nv, &va) {
        (Some(_), _) if render_nv => "nvdec",
        (_, Some(_)) => "vaapi",
        (Some(_), None) => "nvdec",
        (None, None) => "none",
    };
    // mpv tries each entry per file and moves on when one cannot decode that
    // codec or has no interop with the render context; `auto-safe` is last.
    let mut list: Vec<&str> = Vec::new();
    let nv_first = render_nv || va.is_none();
    let push_nv = |l: &mut Vec<&str>| {
        if nv.is_some() {
            l.extend(["nvdec", "nvdec-copy"]);
        }
    };
    let push_va = |l: &mut Vec<&str>| {
        if va.is_some() {
            l.extend(["vaapi", "vaapi-copy"]);
        }
    };
    if nv_first {
        push_nv(&mut list);
        push_va(&mut list);
    } else {
        push_va(&mut list);
        push_nv(&mut list);
    }
    if list.is_empty() {
        // Nothing probed: the vendor default, then mpv's own safe choice.
        match p.render_vendor {
            Some(Vendor::Nvidia) => list.push("nvdec"),
            Some(Vendor::Intel) | Some(Vendor::Amd) => list.extend(["vaapi", "vaapi-copy"]),
            _ => {}
        }
    }
    list.push("auto-safe");

    let hevc4k = |c: &DecodeCaps| (c.codecs.hevc || c.codecs.hevc10) && c.hevc_max_height.unwrap_or(0) >= 2160;
    let native4k = (render_nv && nv.as_ref().is_some_and(hevc4k))
        || (p.wayland && va.as_ref().is_some_and(|(c, on_render)| *on_render && hevc4k(c)));
    let copy4k = nv.as_ref().is_some_and(hevc4k) || va.as_ref().is_some_and(|(c, _)| hevc4k(c));
    let decent_gpu = p.render_discrete || hwdec.hevc10;
    let mut rec = if native4k && decent_gpu {
        2160
    } else if copy4k && p.cpu_threads >= 8 {
        2160
    } else if hwdec.h264 || hwdec.hevc || p.cpu_threads >= 4 {
        1080
    } else if p.cpu_threads >= 2 {
        720
    } else {
        480
    };
    if p.ram_mb > 0 && p.ram_mb < 3072 {
        rec = rec.min(1080);
    }
    Derived {
        hwdec,
        max_hw_height,
        recommended_max_height: rec,
        hwdec_api,
        mpv_hwdec: list.join(","),
        weak_gpu: !p.render_discrete,
    }
}

/// Run a probe with a timeout; stdout and stderr together.
fn run(cmd: &str, args: &[&str], env: &[(&str, &str)], timeout: Duration) -> Option<String> {
    let mut c = Command::new(cmd);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in env {
        c.env(k, v);
    }
    let mut child = c.spawn().ok()?;
    let mut out = child.stdout.take()?;
    let mut err = child.stderr.take()?;
    let t_out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let t_err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(15)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                crate::log_warn!("caps", "{cmd} timed out");
                return None;
            }
        }
    }
    let mut s = t_out.join().unwrap_or_default();
    s.push_str(&t_err.join().unwrap_or_default());
    Some(s)
}

const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

fn probe_vaapi(node: &str) -> Option<DecodeCaps> {
    let out = run("vainfo", &["-a", "--display", "drm", "--device", node], &[], PROBE_TIMEOUT)?;
    parse_vainfo(&out).or_else(|| {
        // Older libva-utils have no -a.
        let plain = run("vainfo", &["--display", "drm", "--device", node], &[], PROBE_TIMEOUT)?;
        parse_vainfo(&plain)
    })
}

fn has_tool(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(name).is_file()))
        .unwrap_or(false)
}

fn ram_mb() -> u64 {
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("MemTotal:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|kb| kb.parse::<u64>().ok())
        })
        .map(|kb| kb / 1024)
        .unwrap_or(0)
}

/// NVIDIA RTX GPU by marketing name ("NVIDIA GeForce RTX 4070", "NVIDIA RTX A2000",
/// "Quadro RTX 4000"). RTX Video Super Resolution needs one (RTX 20 series or newer).
pub fn is_rtx(vendor: &str, name: &str) -> bool {
    vendor == "nvidia"
        && name
            .split(|c: char| !c.is_ascii_alphanumeric())
            .any(|w| w.eq_ignore_ascii_case("rtx"))
}

fn gpu_name(g: &Gpu, smi: &[(String, String)], ids: Option<&str>) -> String {
    if let Some(n) = g.name.as_deref() {
        return n.to_string();
    }
    let tail = |s: &str| s.rsplit(':').take(2).collect::<Vec<_>>().join(":");
    if let Some((n, _)) = smi.iter().find(|(_, bus)| !g.pci_slot.is_empty() && tail(bus) == tail(&g.pci_slot)) {
        return n.clone();
    }
    if g.vendor == Vendor::Nvidia {
        let info = std::path::Path::new("/proc/driver/nvidia/gpus").join(&g.pci_slot).join("information");
        if let Some(m) = std::fs::read_to_string(info).ok().and_then(|s| {
            s.lines().find_map(|l| l.strip_prefix("Model:").map(|m| m.trim().to_string()))
        }) {
            return m;
        }
    }
    let vid = match g.vendor {
        Vendor::Nvidia => 0x10de,
        Vendor::Amd => 0x1002,
        Vendor::Intel => 0x8086,
        Vendor::Other => 0,
    };
    ids.and_then(|ids| pci_name(ids, vid, g.device_id))
        .unwrap_or_else(|| format!("{} GPU {:04x}", g.vendor.label(), g.device_id))
}

#[cfg(windows)]
fn probe() -> SystemCaps {
    use crate::gpu_windows as gw;
    let started = Instant::now();
    let st = gpu::state();
    let gpus = &st.gpus;
    let render = gpu::render_gpu();
    let codecs = render
        .and_then(|g| g.card.strip_prefix("dxgi").and_then(|i| i.parse::<u32>().ok()))
        .and_then(gw::probe_decoders);
    let render_discrete = render.is_some_and(|g| gpu::is_discrete(g, gpus));
    let cpu_threads = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1);
    let ram = gw::ram_mb();
    let d = gw::derive(codecs, render_discrete, cpu_threads, ram);
    let infos: Vec<GpuInfo> = gpus
        .iter()
        .map(|g| GpuInfo {
            vendor: g.vendor.label(),
            name: gpu_name(g, &[], None),
            driver: g.driver.clone(),
            discrete: gpu::is_discrete(g, gpus),
            active: render.is_some_and(|r| r.card == g.card),
        })
        .collect();
    let caps = SystemCaps {
        rtx: infos.iter().any(|g| is_rtx(g.vendor, &g.name)),
        gpus: infos,
        cpu_threads,
        ram_mb: ram,
        hwdec: d.hwdec,
        max_hw_height: d.max_hw_height,
        recommended_max_height: d.recommended_max_height,
        hwdec_api: d.hwdec_api,
        mpv_hwdec: d.mpv_hwdec,
        vaapi_device: None,
        weak_gpu: d.weak_gpu,
    };
    crate::log_info!(
        "caps",
        "{} in {}ms (d3d11 decoder profiles: {}); mpv hwdec={}",
        serde_json::to_string(&caps).unwrap_or_default(),
        started.elapsed().as_millis(),
        if codecs.is_some() { "ok" } else { "unavailable" },
        caps.mpv_hwdec
    );
    caps
}

#[cfg(not(windows))]
fn probe() -> SystemCaps {
    let started = Instant::now();
    let st = gpu::state();
    let gpus = &st.gpus;
    let render = gpu::render_gpu();
    let nv_gpu = gpus.iter().find(|g| g.nvidia_proprietary()).cloned();

    // Probes in parallel; each has its own timeout.
    let smi = std::thread::spawn(|| {
        run("nvidia-smi", &["--query-gpu=name,pci.bus_id", "--format=csv,noheader"], &[], PROBE_TIMEOUT)
            .map(|s| parse_nvidia_smi(&s))
            .unwrap_or_default()
    });
    let nv_probe = nv_gpu.clone().map(|g| {
        std::thread::spawn(move || {
            let vd = if has_tool("vdpauinfo") {
                run("vdpauinfo", &[], &[("VDPAU_DRIVER", "nvidia")], PROBE_TIMEOUT).and_then(|s| parse_vdpauinfo(&s))
            } else {
                None
            };
            match vd {
                Some(Vdpau::Table(c)) => (c, "vdpauinfo"),
                Some(Vdpau::NoDecoder) => (DecodeCaps::default(), "vdpauinfo: no decoder"),
                None => (nvdec_table(g.device_id), "generation table"),
            }
        })
    });
    let have_vainfo = has_tool("vainfo");
    let va_probes: Vec<_> = gpus
        .iter()
        .filter(|g| !g.nvidia_proprietary())
        .filter_map(|g| g.render_node.clone().map(|n| (g.clone(), n)))
        .map(|(g, node)| {
            std::thread::spawn(move || {
                let caps = if have_vainfo {
                    probe_vaapi(&node)
                } else if matches!(g.driver.as_str(), "i915" | "xe" | "amdgpu") {
                    let mut c = DecodeCaps::default();
                    c.note("h264", None);
                    c.note("hevc", None);
                    Some(c)
                } else {
                    None
                };
                (g, node, caps)
            })
        })
        .collect();

    let ids = ["/usr/share/hwdata/pci.ids", "/usr/share/misc/pci.ids"].iter().find_map(|p| std::fs::read_to_string(p).ok());
    let smi = smi.join().unwrap_or_default();
    let (nvdec, nv_src) = match nv_probe.map(|t| t.join()) {
        Some(Ok((c, src))) => (Some(c), src),
        _ => (None, "none"),
    };
    let va: Vec<(Gpu, String, DecodeCaps)> = va_probes
        .into_iter()
        .filter_map(|t| t.join().ok())
        .filter_map(|(g, n, c)| c.map(|c| (g, n, c)))
        .collect();
    // The rendering GPU's node first, then the one decoding the most codecs.
    let score = |c: &DecodeCaps| [c.codecs.h264, c.codecs.hevc, c.codecs.hevc10, c.codecs.vp9, c.codecs.av1].iter().filter(|b| **b).count();
    let chosen = va
        .iter()
        .max_by_key(|(g, _, c)| (render.is_some_and(|r| r.card == g.card) && c.codecs.any(), score(c)))
        .cloned();

    let wayland = std::env::var("XDG_SESSION_TYPE").map(|v| v.eq_ignore_ascii_case("wayland")).unwrap_or(false)
        || std::env::var("WAYLAND_DISPLAY").map(|v| !v.is_empty()).unwrap_or(false);
    let probed = Probed {
        render_vendor: render.map(|g| g.vendor),
        render_discrete: render.is_some_and(|g| gpu::is_discrete(g, gpus)),
        wayland,
        cpu_threads: std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1),
        ram_mb: ram_mb(),
        nvdec,
        vaapi: chosen.as_ref().map(|(g, _, c)| (c.clone(), render.is_some_and(|r| r.card == g.card))),
    };
    let d = derive(&probed);
    let infos: Vec<GpuInfo> = gpus
        .iter()
        .map(|g| GpuInfo {
            vendor: g.vendor.label(),
            name: gpu_name(g, &smi, ids.as_deref()),
            driver: g.driver.clone(),
            discrete: gpu::is_discrete(g, gpus),
            active: render.is_some_and(|r| r.card == g.card),
        })
        .collect();
    let caps = SystemCaps {
        rtx: infos.iter().any(|g| is_rtx(g.vendor, &g.name)),
        gpus: infos,
        cpu_threads: probed.cpu_threads,
        ram_mb: probed.ram_mb,
        hwdec: d.hwdec,
        max_hw_height: d.max_hw_height,
        recommended_max_height: d.recommended_max_height,
        hwdec_api: d.hwdec_api,
        mpv_hwdec: d.mpv_hwdec,
        vaapi_device: chosen.map(|(_, n, _)| n),
        weak_gpu: d.weak_gpu,
    };
    crate::log_info!(
        "caps",
        "{} in {}ms (nvdec from {nv_src}); mpv hwdec={} vaapi-device={:?}",
        serde_json::to_string(&caps).unwrap_or_default(),
        started.elapsed().as_millis(),
        caps.mpv_hwdec,
        caps.vaapi_device
    );
    caps
}

static CAPS: OnceLock<SystemCaps> = OnceLock::new();

/// Cached capabilities; the first caller runs the probes (blocking, bounded by the timeouts).
pub fn get() -> &'static SystemCaps {
    CAPS.get_or_init(probe)
}

/// Start probing in the background so the first playback does not wait.
pub fn warm() {
    let _ = std::thread::Builder::new().name("caps-probe".into()).spawn(|| {
        get();
    });
}

#[tauri::command]
pub async fn system_caps() -> Result<SystemCaps, String> {
    tauri::async_runtime::spawn_blocking(|| get().clone()).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const VAINFO_A: &str = include_str!("samples/vainfo_a_hd620.txt");
    const VAINFO: &str = include_str!("samples/vainfo_hd620.txt");
    const VAINFO_FAIL: &str = include_str!("samples/vainfo_nvidia_fail.txt");
    const VDPAU_940MX: &str = include_str!("samples/vdpauinfo_940mx.txt");
    const SMI: &str = include_str!("samples/nvidia_smi_940mx.txt");

    /// Layout of `vdpauinfo` on a GPU that has a decoder (Pascal-class values).
    const VDPAU_TABLE: &str = "display: :0   screen: 0
API version: 1
Information string: NVIDIA VDPAU Driver Shared Library  580.178.04

Decoder capabilities:

name                        level macbs width height
----------------------------------------------------
MPEG1                           0 65536  4096  4096
H264_MAIN                      51 65536  4096  4096
H264_HIGH                      51 65536  4096  4096
HEVC_MAIN                      153 262144  8192  8192
HEVC_MAIN_10                   153 262144  8192  8192
VP9_PROFILE_0                   --- not supported ---
AV1_MAIN                        --- not supported ---

Output surface:
";

    #[test]
    fn parses_vainfo_attributes_from_hd620() {
        let c = parse_vainfo(VAINFO_A).unwrap();
        assert_eq!(c.codecs, Codecs { h264: true, hevc: true, hevc10: true, vp9: true, av1: false });
        assert_eq!(c.max_height, Some(8192));
        assert_eq!(c.hevc_max_height, Some(8192));
    }

    #[test]
    fn parses_plain_vainfo_from_hd620() {
        let c = parse_vainfo(VAINFO).unwrap();
        assert_eq!(c.codecs, Codecs { h264: true, hevc: true, hevc10: true, vp9: true, av1: false });
        assert_eq!(c.max_height, None);
    }

    #[test]
    fn vainfo_without_driver_is_none() {
        assert!(parse_vainfo(VAINFO_FAIL).is_none());
    }

    #[test]
    fn parses_vdpauinfo() {
        assert_eq!(parse_vdpauinfo(VDPAU_940MX), Some(Vdpau::NoDecoder));
        let Some(Vdpau::Table(c)) = parse_vdpauinfo(VDPAU_TABLE) else { panic!() };
        assert_eq!(c.codecs, Codecs { h264: true, hevc: true, hevc10: true, vp9: false, av1: false });
        assert_eq!(c.hevc_max_height, Some(8192));
        assert!(parse_vdpauinfo("Failed to open VDPAU backend").is_none());
    }

    #[test]
    fn parses_nvidia_smi() {
        assert_eq!(parse_nvidia_smi(SMI), vec![("NVIDIA GeForce 940MX".to_string(), "00000000:01:00.0".to_string())]);
    }

    #[test]
    fn nvdec_generations() {
        let maxwell1 = nvdec_table(0x179c);
        assert!(maxwell1.codecs.h264 && !maxwell1.codecs.hevc);
        assert!(nvdec_table(0x1401).codecs.hevc10);
        assert!(!nvdec_table(0x1c8c).codecs.av1 && nvdec_table(0x1c8c).codecs.vp9);
        assert!(nvdec_table(0x2520).codecs.av1);
    }

    #[test]
    fn pci_ids_lookup() {
        let ids = "# c\n10de  NVIDIA Corporation\n\t179c  GM107 [GeForce 940MX]\n\t\t1025 1094  Acer\n8086  Intel Corporation\n\t5916  HD Graphics 620\n";
        assert_eq!(pci_name(ids, 0x10de, 0x179c).as_deref(), Some("GeForce 940MX"));
        assert_eq!(pci_name(ids, 0x8086, 0x5916).as_deref(), Some("HD Graphics 620"));
        assert_eq!(pci_name(ids, 0x8086, 0x1234), None);
    }

    fn intel_va() -> DecodeCaps {
        parse_vainfo(VAINFO_A).unwrap()
    }

    #[test]
    fn this_machine_policy() {
        // NVIDIA renders (prime-select nvidia), NVDEC absent, Intel VA-API decodes via copy-back.
        let d = derive(&Probed {
            render_vendor: Some(Vendor::Nvidia),
            render_discrete: true,
            wayland: false,
            cpu_threads: 4,
            ram_mb: 7805,
            nvdec: Some(DecodeCaps::default()),
            vaapi: Some((intel_va(), false)),
        });
        assert_eq!(d.hwdec_api, "vaapi");
        assert_eq!(d.mpv_hwdec, "vaapi,vaapi-copy,auto-safe");
        assert_eq!(d.recommended_max_height, 1080);
        assert_eq!(d.max_hw_height, Some(8192));
    }

    #[test]
    fn nvdec_on_nvidia_renderer_allows_4k() {
        let d = derive(&Probed {
            render_vendor: Some(Vendor::Nvidia),
            render_discrete: true,
            wayland: false,
            cpu_threads: 4,
            ram_mb: 8000,
            nvdec: Some(nvdec_table(0x1c8c)),
            vaapi: Some((intel_va(), false)),
        });
        assert_eq!(d.hwdec_api, "nvdec");
        assert_eq!(d.mpv_hwdec, "nvdec,nvdec-copy,vaapi,vaapi-copy,auto-safe");
        assert_eq!(d.recommended_max_height, 2160);
    }

    #[test]
    fn intel_wayland_zero_copy_vs_x11_copy() {
        let p = |wayland| Probed {
            render_vendor: Some(Vendor::Intel),
            render_discrete: false,
            wayland,
            cpu_threads: 4,
            ram_mb: 8000,
            nvdec: None,
            vaapi: Some((intel_va(), true)),
        };
        assert_eq!(derive(&p(true)).recommended_max_height, 2160);
        assert_eq!(derive(&p(false)).recommended_max_height, 1080);
        assert!(derive(&p(false)).weak_gpu);
    }

    #[test]
    fn detects_rtx_by_name() {
        assert!(is_rtx("nvidia", "NVIDIA GeForce RTX 4070"));
        assert!(is_rtx("nvidia", "GeForce RTX 3060 Lite Hash Rate"));
        assert!(is_rtx("nvidia", "NVIDIA RTX A2000 8GB Laptop GPU"));
        assert!(is_rtx("nvidia", "Quadro RTX 4000"));
        assert!(is_rtx("nvidia", "NVIDIA RTX 2000 Ada Generation"));
        assert!(!is_rtx("nvidia", "NVIDIA GeForce GTX 1660 SUPER"));
        assert!(!is_rtx("nvidia", "NVIDIA GeForce 940MX"));
        assert!(!is_rtx("nvidia", "nvidia GPU 2504"));
        assert!(!is_rtx("amd", "AMD Radeon RX 7900 XTX"));
        assert!(!is_rtx("nvidia", "GeForce GTX RTXish"));
    }

    #[test]
    fn software_only_scales_with_threads() {
        let p = |t, ram| Probed {
            render_vendor: Some(Vendor::Other),
            render_discrete: false,
            wayland: false,
            cpu_threads: t,
            ram_mb: ram,
            nvdec: None,
            vaapi: None,
        };
        assert_eq!(derive(&p(4, 8000)).recommended_max_height, 1080);
        assert_eq!(derive(&p(2, 8000)).recommended_max_height, 720);
        assert_eq!(derive(&p(1, 8000)).recommended_max_height, 480);
        assert_eq!(derive(&p(2, 8000)).hwdec_api, "none");
        assert_eq!(derive(&p(2, 8000)).mpv_hwdec, "auto-safe");
    }
}
