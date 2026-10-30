//! Real-media validation for Auto Sync.
//!
//!   cargo run --release --example synccheck -- <media path or URL> <correct.srt>
//!   cargo run --release --example synccheck -- matrix <testmedia dir> <work dir> [filter]
//!
//! The subtitle is assumed to be correctly timed. It is distorted with known
//! offsets / frame-rate ratios, the full pipeline (ffmpeg windows, VAD, solver)
//! runs on the real audio, and the recovered correction is compared with the truth.
//!
//! `matrix` derives audio variants from Tears of Steel with ffmpeg (5.1, mono,
//! low-bitrate AAC, added music, silence-padded start; cached in the work dir) and
//! runs a broad case list: offsets, frame-rate ratios, a piecewise offset (a cut
//! that differs), SDH cues, sparse subtitles, plus unrelated-subtitle controls.
//! A case passes when the result is a fit that puts >= 95 % of the dialogue cues
//! within 0.2 s of their true time.

use kinly_lib::subs::parse::{self, Cue};
use kinly_lib::sync::{analyse, correlate::Outcome, Options};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn duration_of(media: &str) -> f32 {
    let out = std::process::Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", media])
        .output()
        .expect("ffprobe");
    String::from_utf8_lossy(&out.stdout).trim().parse().expect("duration")
}

/// `TIME_SCALE=n` stretches the analysis deadlines (accuracy runs on a busy machine).
fn time_scale() -> f32 {
    std::env::var("TIME_SCALE").ok().and_then(|v| v.parse().ok()).unwrap_or(1.0)
}

fn deep() -> bool {
    std::env::var("DEEP").is_ok_and(|v| v == "1")
}

fn load_cues(srt: &Path) -> Vec<Cue> {
    let (text, _) = parse::decode(&std::fs::read(srt).expect("read srt"));
    parse::parse(&text, parse::detect_format(&text).expect("format"))
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("matrix") {
        return matrix(Path::new(&args[2]), Path::new(&args[3]), args.get(4).cloned().unwrap_or_default()).await;
    }
    let (media, srt) = (&args[1], &args[2]);
    let remote = media.contains("://");
    let cues = parse::dialogue_intervals(&load_cues(Path::new(srt)));
    let duration = duration_of(media);
    let size = if remote { None } else { std::fs::metadata(media).ok().map(|m| m.len() as f32) };
    let bps = std::env::var("BYTES_PER_SEC").ok().and_then(|v| v.parse().ok()).or(size.map(|s| s / duration));
    let opts = Options { remote, manual: deep(), deep: deep(), bytes_per_sec: bps, time_scale: time_scale() };
    println!("media={} duration={duration:.0}s cues={} deep={}", if remote { "remote" } else { "local" }, cues.len(), deep());
    // (true ratio, true offset): the distorted file needs sub-speed=r, sub-delay=b.
    let cases: &[(f32, f32)] = &[(1.0, 0.0), (1.0, 4.5), (1.0, -7.25), (1.0, 23.0), (1.0, -61.0), (25.0 / 23.976, 1.5), (23.976 / 25.0, -2.0)];
    println!("{:>9} {:>8} | {:>12} {:>9} {:>9} {:>6} {:>7}", "true r", "true b", "status", "r", "b", "z", "ms");
    for &(r, b) in cases {
        let distorted: Vec<(f32, f32)> = cues.iter().map(|&(s, e)| ((s - b) / r, (e - b) / r)).collect();
        let t = Instant::now();
        let res = analyse(media, &HashMap::new(), None, duration, distorted, &opts, &|_| {}).await;
        let ms = t.elapsed().as_millis();
        match res.map(|a| a.outcome) {
            Ok(Outcome::Fit { offset, ratio, strength, .. }) => {
                let ok = (ratio - r).abs() < 1e-3 && (offset - b).abs() <= 0.15;
                println!("{r:>9.5} {b:>8.2} | {:>12} {ratio:>9.5} {offset:>9.2} {strength:>6.2} {ms:>7}", if ok { "fit OK" } else { "fit WRONG" });
            }
            Ok(other) => println!("{r:>9.5} {b:>8.2} | {:>12} {:>9} {:>9} {:>6} {ms:>7}", format!("{other:?}").split_whitespace().next().unwrap_or("?"), "-", "-", "-"),
            Err(e) => println!("{r:>9.5} {b:>8.2} | error: {e}"),
        }
    }

    // Negative control: cue gaps shuffled, i.e. a subtitle for different content.
    let mut shuffled = Vec::new();
    let mut t = cues.first().map(|c| c.0).unwrap_or(0.0);
    for (i, &(s, e)) in cues.iter().enumerate().rev() {
        let gap = if i > 0 { (s - cues[i - 1].1).max(0.2) } else { 1.0 };
        shuffled.push((t, t + (e - s)));
        t += (e - s) + gap * 1.7;
    }
    let res = analyse(media, &HashMap::new(), None, duration, shuffled, &opts, &|_| {}).await;
    println!("negative control (unrelated timing): {:?}", res.map(|a| match a.outcome { Outcome::Fit { offset, ratio, .. } => format!("FIT r={ratio} b={offset} (false positive)"), other => format!("{other:?}") }));
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

/// Audio variant: (name, ffmpeg recipe from the long dialogue file / short film, true pad).
struct Media {
    name: &'static str,
    path: PathBuf,
    /// Correct subtitle for this media (pad already applied).
    cues: Vec<Cue>,
}

fn ff(args: &[&str]) {
    let st = std::process::Command::new("ffmpeg").args(["-hide_banner", "-loglevel", "error", "-y"]).args(args).status().expect("ffmpeg");
    assert!(st.success(), "ffmpeg {args:?}");
}

/// Synthetic music bed: a chord progression with harmonics (wide stereo) and a
/// centred, vibrato "sung" melody line, as loud as the film's own mix.
const MUSIC_L: &str = "st(0,mod(floor(t/2.1),4));st(1,110*pow(2,if(eq(ld(0),0),0,if(eq(ld(0),1),5,if(eq(ld(0),2),7,3)))/12));st(2,220*pow(2,mod(floor(t*2.3),7)*2/12)*(1+0.012*sin(2*PI*5.5*t)));0.05*(sin(2*PI*ld(1)*2*t)+0.6*sin(2*PI*ld(1)*2.52*t)+0.5*sin(2*PI*ld(1)*3*t)+0.4*sin(2*PI*ld(1)*4*t))*(0.7+0.3*sin(2*PI*2*t))+0.06*(sin(2*PI*ld(2)*t)+0.7*sin(4*PI*ld(2)*t)+0.5*sin(6*PI*ld(2)*t)+0.35*sin(8*PI*ld(2)*t)+0.2*sin(10*PI*ld(2)*t))*(0.5+0.5*sin(2*PI*1.15*t))";

fn shift_cues(cues: &[Cue], d: f32) -> Vec<Cue> {
    cues.iter().map(|c| Cue { start: c.start + d, end: c.end + d, text: c.text.clone() }).collect()
}

fn prepare_media(src: &Path, work: &Path) -> Vec<Media> {
    std::fs::create_dir_all(work).unwrap();
    let long = src.join("tos_long.mka");
    let short = src.join("tears_of_steel_720p.mov");
    let long_cues = load_cues(&src.join("tos_long.srt"));
    let short_cues = load_cues(&src.join("TOS-en.srt"));
    let l = long.to_str().unwrap();
    let mk = |name: &str, build: &dyn Fn(&str)| -> PathBuf {
        let p = work.join(name);
        if !p.exists() {
            let tmp = work.join(format!("tmp.{name}"));
            build(tmp.to_str().unwrap());
            std::fs::rename(&tmp, &p).unwrap();
        }
        p
    };
    let surround = mk("long_51.mka", &|o| ff(&["-i", l, "-af", "pan=5.1|FL=0.6*c0|FR=0.6*c1|FC=0.5*c0+0.5*c1|LFE=0.1*c0+0.1*c1|BL=0.4*c0|BR=0.4*c1", "-c:a", "ac3", "-b:a", "448k", "-f", "matroska", o]));
    let mono = mk("long_mono.mka", &|o| ff(&["-i", l, "-ac", "1", "-c:a", "aac", "-b:a", "96k", "-f", "matroska", o]));
    let aac = mk("long_aac32.mka", &|o| ff(&["-i", l, "-c:a", "aac", "-b:a", "32k", "-ar", "22050", "-f", "matroska", o]));
    let music = mk("long_music.mka", &|o| {
        let expr = format!("aevalsrc=exprs='{MUSIC_L}|{}':s=44100:d=2280", MUSIC_L.replace("sin(2*PI*ld(1)*2*t)", "sin(2*PI*ld(1)*2*t+1.3)"));
        ff(&["-i", l, "-f", "lavfi", "-i", &expr, "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.04:d=2280",
            "-filter_complex", "[2]aformat=channel_layouts=stereo[n];[0][1][n]amix=inputs=3:normalize=0:duration=first", "-c:a", "aac", "-b:a", "160k", "-f", "matroska", o])
    });
    let pad = mk("long_pad25.mka", &|o| ff(&["-i", l, "-af", "adelay=25s:all=1", "-c:a", "aac", "-b:a", "128k", "-f", "matroska", o]));
    let spad = mk("short_pad20.mka", &|o| ff(&["-i", short.to_str().unwrap(), "-vn", "-af", "adelay=20s:all=1", "-c:a", "aac", "-b:a", "128k", "-f", "matroska", o]));
    vec![
        Media { name: "long", path: long.clone(), cues: long_cues.clone() },
        Media { name: "short", path: short, cues: short_cues.clone() },
        Media { name: "5.1", path: surround, cues: long_cues.clone() },
        Media { name: "mono", path: mono, cues: long_cues.clone() },
        Media { name: "aac32", path: aac, cues: long_cues.clone() },
        Media { name: "music", path: music, cues: long_cues.clone() },
        Media { name: "pad25", path: pad, cues: shift_cues(&long_cues, 25.0) },
        Media { name: "spad20", path: spad, cues: shift_cues(&short_cues, 20.0) },
    ]
}

#[derive(Clone)]
enum Distort {
    /// audio = r * sub + b
    Linear(f32, f32),
    /// Audio time < t: offset b1; >= t: offset b2 (audio has an extra/missing part at t).
    Piecewise { at: f32, b1: f32, b2: f32 },
    Sdh(f32),
    /// Keep one cue in `n`.
    Sparse(usize, f32),
    /// Unrelated subtitle (negative control), by seed.
    Shuffled(u32),
    Mirrored,
}

struct Case {
    media: &'static str,
    group: &'static str,
    d: Distort,
}

/// A distorted subtitle and, for every cue that has a true time, (index, true start).
fn distort(cues: &[Cue], d: &Distort, duration: f32) -> (Vec<Cue>, Vec<(usize, f32)>) {
    let mut items: Vec<(Cue, Option<f32>)> = Vec::new();
    let mut rng = Rng(0x9e37_79b9);
    let mv = |c: &Cue, f: &dyn Fn(f32) -> f32, text: String| Cue { start: f(c.start), end: f(c.end), text };
    match d {
        Distort::Linear(r, b) => {
            for c in cues {
                items.push((mv(c, &|t| (t - b) / r, c.text.clone()), Some(c.start)));
            }
        }
        Distort::Sparse(n, b) => {
            for c in cues.iter().step_by(*n) {
                items.push((mv(c, &|t| t - b, c.text.clone()), Some(c.start)));
            }
        }
        Distort::Piecewise { at, b1, b2 } => {
            for c in cues {
                let b = if c.start < *at { *b1 } else { *b2 };
                // Audio has extra (unsubtitled) content just before `at`: drop overlapping lines.
                if b2 > b1 && c.start < *at && c.start >= at - (b2 - b1) {
                    continue;
                }
                items.push((mv(c, &|t| t - b, c.text.clone()), Some(c.start)));
            }
        }
        Distort::Sdh(b) => {
            const TAGS: &[&str] = &["[music playing]", "♪ ♪", "(door slams)", "[EXPLOSION]", "♪ Ominous music ♪", "(grunts)", "[alarm blaring]", "(footsteps)", "[gunfire]", "♪♪"];
            for (i, c) in cues.iter().enumerate() {
                let text = match i % 5 { 1 => format!("[sighs] {}", c.text), 3 => format!("THOM: {}", c.text), _ => c.text.clone() };
                items.push((mv(c, &|t| t - b, text), Some(c.start)));
                let gap_end = cues.get(i + 1).map(|n| n.start).unwrap_or(c.end + 6.0);
                let mut t = c.end + 0.3;
                while gap_end - t > 2.0 {
                    let len = 1.0 + rng.f() * 2.5;
                    if rng.f() < 0.75 {
                        let e = (t + len).min(gap_end - 0.2);
                        let tag = TAGS[(rng.f() * TAGS.len() as f32) as usize % TAGS.len()];
                        items.push((Cue { start: t - b, end: e - b, text: tag.into() }, None));
                    }
                    t += len + 0.5 + rng.f() * 3.0;
                }
            }
        }
        Distort::Shuffled(seed) => {
            let mut rng = Rng(seed.wrapping_mul(2654435761).wrapping_add(17));
            let mut durs: Vec<f32> = cues.iter().map(|c| c.end - c.start).collect();
            let mut gaps: Vec<f32> = cues.windows(2).map(|w| (w[1].start - w[0].end).max(0.1)).collect();
            for i in (1..durs.len()).rev() { let j = (rng.f() * (i + 1) as f32) as usize; durs.swap(i, j.min(i)); }
            for i in (1..gaps.len()).rev() { let j = (rng.f() * (i + 1) as f32) as usize; gaps.swap(i, j.min(i)); }
            let mut t = cues[0].start;
            for (i, len) in durs.iter().enumerate() {
                items.push((Cue { start: t, end: t + len, text: cues[i].text.clone() }, None));
                t += len + gaps.get(i).copied().unwrap_or(1.0);
            }
        }
        Distort::Mirrored => {
            for c in cues {
                items.push((Cue { start: duration - c.end, end: duration - c.start, text: c.text.clone() }, None));
            }
        }
    }
    items.sort_by(|a, b| a.0.start.partial_cmp(&b.0.start).unwrap());
    let truth = items.iter().enumerate().filter_map(|(i, (_, t))| t.map(|t| (i, t))).collect();
    (items.into_iter().map(|(c, _)| c).collect(), truth)
}

struct Rng(u32);
impl Rng {
    fn f(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(1103515245).wrapping_add(12345);
        (self.0 >> 8) as f32 / (1u32 << 24) as f32
    }
}

fn cases() -> Vec<Case> {
    let mut v = Vec::new();
    let mut add = |media, group, d| v.push(Case { media, group, d });
    for b in [-30.0, -17.3, -6.5, -1.2, 0.0, 0.8, 3.4, 11.0, 24.6, 30.0] {
        add("long", "offset", Distort::Linear(1.0, b));
        add("short", "offset", Distort::Linear(1.0, b));
    }
    let ratios = [(25.0 / 23.976, 2.0), (23.976 / 25.0, -5.0), (25.0 / 24.0, 1.1), (24.0 / 25.0, -8.0), (24.0 / 23.976, 4.0), (23.976 / 24.0, -0.6)];
    for &(r, b) in &ratios {
        add("long", "ratio", Distort::Linear(r, b));
        add("short", "ratio", Distort::Linear(r, b));
    }
    for (at, b1, b2) in [(240.0, 1.0, 13.0), (600.0, 0.0, 8.0), (1150.0, 2.0, -10.0), (1700.0, -4.0, 21.0), (900.0, 0.0, 60.0), (1400.0, 3.0, -5.5)] {
        add("long", "piecewise", Distort::Piecewise { at, b1, b2 });
    }
    for b in [4.2, -9.0] {
        add("long", "sdh", Distort::Sdh(b));
        add("short", "sdh", Distort::Sdh(b));
    }
    for m in ["music", "5.1", "mono", "aac32"] {
        for b in [5.5, -12.3, 0.0] {
            add(m, m, Distort::Linear(1.0, b));
        }
        add(m, m, Distort::Linear(25.0 / 23.976, -2.0));
    }
    for b in [0.0, -5.0] {
        add("pad25", "pad", Distort::Linear(1.0, b));
        add("spad20", "pad", Distort::Linear(1.0, b));
    }
    for (n, b) in [(3, 6.0), (5, -2.5)] {
        add("long", "sparse", Distort::Sparse(n, b));
        add("short", "sparse", Distort::Sparse(n, b));
    }
    for m in ["long", "short", "music", "mono", "5.1", "aac32", "pad25", "spad20"] {
        for seed in 0..3 {
            add(m, "control", Distort::Shuffled(seed));
        }
        add(m, "control", Distort::Mirrored);
    }
    v
}

/// What a sync result does to a subtitle time.
fn result_mapping(o: &Outcome) -> Option<Box<dyn Fn(f32) -> f32 + Send + Sync>> {
    let m = o.mapping()?;
    Some(Box::new(move |s| {
        let (r, b) = m(s);
        r * s + b
    }))
}

async fn matrix(src: &Path, work: &Path, filter: String) {
    let media = prepare_media(src, work);
    let mut by_group: Vec<(&'static str, usize, usize, usize, usize)> = Vec::new(); // group, pass, wrong, declined, total
    let mut times = Vec::new();
    println!("{:<7} {:<9} {:<34} | {:<12} {:>6} {:>6} | detail", "media", "group", "case", "result", "inTol", "ms");
    for case in cases() {
        if !filter.is_empty() && !format!("{} {}", case.media, case.group).contains(&filter) {
            continue;
        }
        let m = media.iter().find(|m| m.name == case.media).unwrap();
        let path = m.path.to_str().unwrap();
        let duration = duration_of(path);
        let (sub, truth) = distort(&m.cues, &case.d, duration);
        let cues = parse::dialogue_intervals(&sub);
        let t = Instant::now();
        let opts = Options { remote: false, manual: deep(), deep: deep(), bytes_per_sec: None, time_scale: time_scale() };
        let res = analyse(path, &HashMap::new(), None, duration, cues, &opts, &|_| {}).await.map(|a| (a.outcome, a.analysed));
        let ms = t.elapsed().as_millis();
        times.push(ms);
        let control = matches!(case.d, Distort::Shuffled(_) | Distort::Mirrored);
        let (label, frac, detail) = match &res {
            Ok((o, _)) => {
                let detail = match o {
                    Outcome::Fit { offset, ratio, reason, .. } => format!("r={ratio:.5} b={offset:+.2} {reason}"),
                    Outcome::Piecewise { reason, .. } => reason.clone(),
                    Outcome::Inconsistent { reason, .. } | Outcome::Uncertain { reason } => reason.clone(),
                };
                match result_mapping(o) {
                    Some(f) if !control => {
                        let ok = truth.iter().filter(|&&(i, t)| (f(sub[i].start) - t).abs() <= 0.2).count();
                        let frac = ok as f32 / truth.len().max(1) as f32;
                        (if frac >= 0.95 { "PASS" } else { "WRONG" }, frac, detail)
                    }
                    Some(_) => ("FALSE-POS", 0.0, detail),
                    None => (if control { "rejected" } else { "declined" }, 0.0, detail),
                }
            }
            Err(e) => (if control { "rejected" } else { "error" }, 0.0, e.clone()),
        };
        let desc = match &case.d {
            Distort::Linear(r, b) => format!("r={r:.5} b={b:+.2}"),
            Distort::Piecewise { at, b1, b2 } => format!("at {at:.0}s: {b1:+.1} -> {b2:+.1}"),
            Distort::Sdh(b) => format!("SDH b={b:+.2}"),
            Distort::Sparse(n, b) => format!("1/{n} cues b={b:+.2}"),
            Distort::Shuffled(s) => format!("shuffled #{s}"),
            Distort::Mirrored => "mirrored".into(),
        };
        println!("{:<7} {:<9} {:<34} | {:<12} {:>5.0}% {:>6} | {}", case.media, case.group, desc, label, frac * 100.0, ms, detail.chars().take(150).collect::<String>());
        let g = if control { "control" } else { case.group };
        let e = match by_group.iter_mut().find(|x| x.0 == g) {
            Some(e) => e,
            None => {
                by_group.push((g, 0, 0, 0, 0));
                by_group.last_mut().unwrap()
            }
        };
        e.4 += 1;
        match label {
            "PASS" | "rejected" => e.1 += 1,
            "WRONG" | "FALSE-POS" => e.2 += 1,
            _ => e.3 += 1,
        }
    }
    println!("\n{:<10} {:>5} {:>6} {:>9} {:>6}", "group", "pass", "wrong", "declined", "total");
    let (mut p, mut w, mut d, mut n) = (0, 0, 0, 0);
    for (g, pass, wrong, declined, total) in &by_group {
        println!("{g:<10} {pass:>5} {wrong:>6} {declined:>9} {total:>6}");
        if *g != "control" {
            p += pass; w += wrong; d += declined; n += total;
        }
    }
    times.sort();
    println!("positives: {p}/{n} pass, {w} wrong fits, {d} declined; time median {} ms, max {} ms",
        times.get(times.len() / 2).copied().unwrap_or(0), times.last().copied().unwrap_or(0));
}
