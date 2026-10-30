//! Auto Sync: align an external subtitle to the dialogue in the media's audio.
//!
//! Windows of audio are decoded with ffmpeg in parallel (local files or HTTP
//! streams; never the whole media), speech is detected locally, and
//! `correlate::solve` fits `audio = ratio * cue + offset`. Nothing is uploaded.
//!
//! The analysis runs in stages, each only when the previous one was not enough:
//! 1. the planned windows (one per ~15 minutes, plus the start of the dialogue);
//! 2. when the result is borderline (no fit, one window only, weak peaks): more
//!    windows in the parts not analysed yet;
//! 3. when windows lock onto different offsets in time order (a cut that
//!    differs, e.g. an extra recap or ad break): the audio between them, to
//!    verify the split and place the boundary. The fix is then written into a
//!    retimed copy of the subtitle, since mpv's sub-delay is one value.
//!
//! The whole analysis is bounded by a deadline and uses what finished in time.

pub mod correlate;
pub mod extract;
pub mod vad;

use correlate::{Outcome, Segment, Window};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{Emitter, State};

static BUSY: AtomicBool = AtomicBool::new(false);

struct BusyGuard;
impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncArgs {
    /// Local path or http(s) URL of the media being played.
    pub media: String,
    /// Path of a subtitle prepared by `subs_fetch` / `subs_load_local`.
    pub subtitle_path: String,
    pub duration_sec: f32,
    #[serde(default)]
    pub audio_ff_index: Option<i64>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Stream size / duration, used to keep remote downloads within budget.
    #[serde(default)]
    pub bytes_per_sec: Option<f32>,
    /// True when the user pressed "Sync to dialogue".
    #[serde(default)]
    pub manual: bool,
    /// "Sync again (deeper)": more and longer windows, a wider offset search.
    #[serde(default)]
    pub deep: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// "fit" | "piecewise" | "inconsistent" | "uncertain" | "busy"
    pub status: &'static str,
    pub offset_sec: f32,
    pub ratio: f32,
    /// Mean correlation-peak z-score of the agreeing windows.
    pub strength: f32,
    pub agreeing_windows: usize,
    pub analysed_windows: usize,
    pub window_offsets: Vec<Option<f32>>,
    /// Piecewise result: offset per part of the video (subtitle time).
    pub segments: Vec<Segment>,
    /// Piecewise result: corrected copy of the subtitle to load instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retimed_path: Option<String>,
    /// Seconds of audio analysed.
    pub audio_sec: f32,
    pub deep: bool,
    pub elapsed_ms: u64,
    /// Human-readable explanation of the status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Progress of a running analysis, emitted as the `sync:progress` event.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// "decode" | "deeper" | "segments" | "solve"
    pub stage: &'static str,
    pub done: usize,
    pub total: usize,
    pub message: String,
}

/// Bytes a remote analysis may download: automatic runs stay small; an explicit
/// "Sync to dialogue" may use more.
const AUTO_BUDGET: f32 = 300.0 * 1024.0 * 1024.0;
const MANUAL_BUDGET: f32 = 1024.0 * 1024.0 * 1024.0;
/// Shortest windows that gave reliable peaks on real audio (examples/synccal.rs).
const MIN_SINGLE_SEC: f32 = 240.0;
const MIN_MULTI_SEC: f32 = 120.0;
/// Assumed when a stream's size is unknown (about 8 Mbit/s).
const DEFAULT_BYTES_PER_SEC: f32 = 1024.0 * 1024.0;
/// Local media get one window per ~15 minutes, at most this many.
const MAX_LOCAL_WINDOWS: usize = 6;
/// Wall-clock budget for decoding + detection. On a 4-thread laptop CPU one
/// 300 s window takes ~1-2 s to decode and detect.
const LOCAL_DEADLINE: Duration = Duration::from_secs(20);
const REMOTE_DEADLINE: Duration = Duration::from_secs(75);
const DEEP_LOCAL_DEADLINE: Duration = Duration::from_secs(45);
const DEEP_REMOTE_DEADLINE: Duration = Duration::from_secs(150);
/// Offsets searched (seconds, either direction).
pub const MAX_LAG_SEC: f32 = 90.0;
pub const DEEP_MAX_LAG_SEC: f32 = 240.0;
/// Longest media accepted (the window planner scans the whole duration).
const MAX_DURATION_SEC: f32 = 48.0 * 3600.0;
/// Most audio decoded between two stretches to verify a split.
const MAX_GAP_AUDIO_SEC: f32 = 1800.0;

/// Number of analysis windows for a duration.
pub fn window_count(duration: f32, remote: bool) -> usize {
    if duration < 900.0 {
        1
    } else if remote {
        3
    } else {
        ((duration / 900.0).round() as usize).clamp(3, MAX_LOCAL_WINDOWS)
    }
}

/// Short media (< 15 min) get one long window (local files: all of it); longer media get one per equal
/// part (3 for streams, 3-6 for local files), so the result can be
/// cross-checked across the whole file. Each window is placed where the
/// subtitle has the most dialogue (avoiding credits and silent stretches).
/// Remote windows are sized so the estimated download stays within budget.
pub fn plan_windows(
    duration: f32,
    cues: &[(f32, f32)],
    remote: bool,
    bytes_per_sec: Option<f32>,
    manual: bool,
) -> Result<Vec<Window>, String> {
    if !duration.is_finite() || duration < 120.0 {
        return Err("media is too short to analyse".into());
    }
    let n = window_count(duration, remote);
    let single = n == 1;
    let count = n as f32;
    // Short local files are analysed whole: about twice the evidence of a 300 s
    // window, and frame-rate drift (which grows along the file) is told apart
    // from neighbouring ratios. Streams keep the shorter window (download budget).
    let want = match (single, remote) {
        (true, false) => duration,
        (true, true) => (duration * 0.8).min(300.0),
        (false, _) => 300.0,
    };
    let len = if remote {
        let budget = if manual { MANUAL_BUDGET } else { AUTO_BUDGET };
        want.min(budget / (count * bps_or_default(bytes_per_sec)))
    } else {
        want
    };
    let min = if single { MIN_SINGLE_SEC.min(duration * 0.8) } else { MIN_MULTI_SEC };
    if len < min {
        return Err(if manual {
            "this stream's bitrate is too high to analyse".into()
        } else {
            "high-bitrate stream: press “Sync to dialogue” to analyse it".into()
        });
    }
    let ranges: Vec<(f32, f32)> = if single {
        vec![(0.0, duration)]
    } else {
        (0..n).map(|i| (duration * i as f32 / count, duration * (i + 1) as f32 / count)).collect()
    };
    Ok(ranges.into_iter().map(|(lo, hi)| densest(cues, lo, (hi - len).max(lo), len, duration)).collect())
}

fn bps_or_default(b: Option<f32>) -> f32 {
    b.filter(|b| b.is_finite() && *b > 0.0).unwrap_or(DEFAULT_BYTES_PER_SEC)
}

/// Deep analysis of a local file: twice the windows (up to 10), and short media
/// analysed whole.
pub fn plan_deep_windows(duration: f32, cues: &[(f32, f32)]) -> Result<Vec<Window>, String> {
    if !duration.is_finite() || duration < 120.0 {
        return Err("media is too short to analyse".into());
    }
    if duration < 900.0 {
        return Ok(vec![Window { start: 0.0, len: duration }]);
    }
    let n = ((duration / 450.0).round() as usize).clamp(4, 10);
    let len = (duration / n as f32 * 0.8).min(300.0);
    Ok((0..n)
        .map(|i| {
            let (lo, hi) = (duration * i as f32 / n as f32, duration * (i + 1) as f32 / n as f32);
            densest(cues, lo, (hi - len).max(lo), len, duration)
        })
        .collect())
}

/// Window of `len` starting in `[lo, hi]` covering the most cue time (ties: earliest).
fn densest(cues: &[(f32, f32)], lo: f32, hi: f32, len: f32, duration: f32) -> Window {
    let covered = |s: f32| -> f32 { cues.iter().map(|&(a, b)| (b.min(s + len) - a.max(s)).max(0.0)).sum() };
    let mut best = (lo, -1.0f32);
    let mut s = lo;
    while s <= hi + 1e-3 {
        let c = covered(s);
        if c > best.1 + 1e-3 {
            best = (s, c);
        }
        s += 15.0;
    }
    Window { start: best.0.clamp(0.0, (duration - len).max(0.0)), len }
}

/// Parts of `[0, duration]` not covered by `windows` (sorted), at least `min` long.
fn uncovered(windows: &[Window], duration: f32, min: f32) -> Vec<(f32, f32)> {
    let mut ws = windows.to_vec();
    ws.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut out = Vec::new();
    let mut t = 0.0f32;
    for w in &ws {
        if w.start - t >= min {
            out.push((t, w.start));
        }
        t = t.max(w.start + w.len);
    }
    if duration - t >= min {
        out.push((t, duration));
    }
    out
}

/// A window at the start of the dialogue when the plan skipped it: a cut that
/// differs (another intro, a cold open) shows there first.
fn head_window(windows: &[Window], cues: &[(f32, f32)], duration: f32) -> Option<Window> {
    let first_cue = cues.first()?.0;
    let first = windows.iter().map(|w| w.start).fold(f32::MAX, f32::min);
    let start = (first_cue - 30.0).max(0.0);
    let len = (first - start).min(300.0).min(duration - start);
    (first > first_cue + 120.0 && len >= MIN_MULTI_SEC).then_some(Window { start, len })
}

/// Up to `count` more windows (each up to 300 s) in the parts not analysed yet,
/// where the subtitle has the most dialogue.
fn fill_windows(windows: &[Window], cues: &[(f32, f32)], duration: f32, count: usize) -> Vec<Window> {
    let mut cands: Vec<(f32, Window)> = uncovered(windows, duration, MIN_MULTI_SEC)
        .into_iter()
        .flat_map(|(lo, hi)| {
            let k = ((hi - lo) / 600.0).ceil().max(1.0) as usize;
            (0..k).map(move |i| (lo + (hi - lo) * i as f32 / k as f32, lo + (hi - lo) * (i + 1) as f32 / k as f32))
        })
        .map(|(lo, hi)| {
            let len = (hi - lo).min(300.0);
            let w = densest(cues, lo, hi - len, len, duration);
            let c: f32 = cues.iter().map(|&(a, b)| (b.min(w.start + w.len) - a.max(w.start)).max(0.0)).sum();
            (c, w)
        })
        .filter(|(c, _)| *c > 10.0)
        .collect();
    cands.sort_by(|a, b| b.0.total_cmp(&a.0));
    cands.into_iter().take(count).map(|(_, w)| w).collect()
}

/// Audio between the stretches of a proposed split, in chunks of at most 300 s.
fn gap_windows(split: &correlate::Split, windows: &[Window], max_total: f32) -> Vec<Window> {
    let mut out = Vec::new();
    let mut total = 0.0;
    for pair in split.runs.windows(2) {
        let a = windows[*pair[0].windows.last().unwrap()];
        let b = windows[pair[1].windows[0]];
        let covered: Vec<Window> = windows.to_vec();
        for (lo, hi) in uncovered(&covered, b.start, 45.0).into_iter().filter(|&(lo, _)| lo >= a.start + a.len - 1.0) {
            let k = ((hi - lo) / 300.0).ceil().max(1.0) as usize;
            let len = (hi - lo) / k as f32;
            for i in 0..k {
                if total + len > max_total {
                    return out;
                }
                total += len;
                out.push(Window { start: lo + len * i as f32, len });
            }
        }
    }
    out
}

pub struct Options {
    pub remote: bool,
    /// The user asked (larger download budget for streams).
    pub manual: bool,
    pub deep: bool,
    pub bytes_per_sec: Option<f32>,
    /// Multiplies the deadlines (1.0 in the app; the validation harness raises
    /// it to measure accuracy on a loaded machine).
    pub time_scale: f32,
}

pub struct Analysis {
    pub outcome: Outcome,
    pub analysed: usize,
    pub audio_sec: f32,
}

#[tauri::command]
pub async fn sync_subtitle(
    app: tauri::AppHandle,
    cache: State<'_, crate::subs::SubCache>,
    args: SyncArgs,
) -> Result<SyncReport, String> {
    let started = Instant::now();
    let remote = args.media.contains("://");
    if remote {
        crate::net::check_url(&args.media)?;
    } else if !std::path::Path::new(&args.media).is_absolute() || !std::path::Path::new(&args.media).is_file() {
        // Also keeps ffmpeg protocol syntax ("concat:", "subfile,") out of the input.
        return Err("media file not found".into());
    }
    if !args.duration_sec.is_finite() || args.duration_sec <= 0.0 || args.duration_sec > MAX_DURATION_SEC {
        return Err("media duration is unknown".into());
    }
    let cues = cache
        .intervals(&args.subtitle_path)
        .ok_or("subtitle is not prepared; reload it")?;
    if cues.len() < 8 {
        return Err("subtitle has too few lines to analyse".into());
    }
    if BUSY.swap(true, Ordering::SeqCst) {
        return Ok(SyncReport::busy());
    }
    let _guard = BusyGuard;
    let opts = Options { remote, manual: args.manual || args.deep, deep: args.deep, bytes_per_sec: args.bytes_per_sec, time_scale: 1.0 };
    let emit = move |p: Progress| {
        let _ = app.emit("sync:progress", p);
    };
    let a = analyse(&args.media, &args.headers, args.audio_ff_index, args.duration_sec, cues, &opts, &emit).await?;
    let mut retimed = None;
    if let (Outcome::Piecewise { .. }, Some(map)) = (&a.outcome, a.outcome.mapping()) {
        let tag = format!("{:x}", started.elapsed().as_nanos() as u64 ^ std::process::id() as u64);
        retimed = Some(cache.write_retimed(&args.subtitle_path, &tag, map)?);
    }
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let mut report = SyncReport::from_outcome(a.outcome, a.analysed, elapsed_ms);
    report.retimed_path = retimed;
    report.audio_sec = a.audio_sec;
    report.deep = args.deep;
    crate::log_info!(
        "sync",
        "{} offset={:.2}s ratio={:.5} strength={:.2} windows={}/{} audio={:.0}s deep={} in {}ms: {}",
        report.status, report.offset_sec, report.ratio, report.strength,
        report.agreeing_windows, report.analysed_windows, report.audio_sec, report.deep, report.elapsed_ms,
        report.reason.as_deref().unwrap_or("")
    );
    Ok(report)
}

type Analysed = (Window, vad::Speech);

/// Decode windows in parallel (at most one ffmpeg per CPU thread) and detect
/// speech. What has finished when `deadline` passes is used; the rest is cancelled.
async fn decode_windows(
    media: &str,
    headers: &HashMap<String, String>,
    audio_ff_index: Option<i64>,
    windows: &[Window],
    deadline: tokio::time::Instant,
    per_window: Duration,
    on_done: &(dyn Fn(usize) + Send + Sync),
) -> (Vec<Analysed>, Option<String>, usize) {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).clamp(2, 8);
    let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(threads));
    let mut set = tokio::task::JoinSet::new();
    for (i, w) in windows.iter().copied().enumerate() {
        let media = media.to_string();
        let headers = headers.clone();
        let permits = permits.clone();
        set.spawn(async move {
            let _permit = permits.acquire_owned().await.map_err(|e| e.to_string())?;
            let pcm = extract::decode_dialogue_pair(&media, &headers, audio_ff_index, w.start, w.len, per_window).await?;
            let speech = tokio::task::spawn_blocking(move || vad::detect(&pcm, w.start, &vad::VadConfig::default()))
                .await
                .map_err(|e| e.to_string())?;
            Ok::<_, String>((i, w, speech))
        });
    }
    let mut out: Vec<(usize, Window, vad::Speech)> = Vec::new();
    let mut last_err = None;
    let mut timed_out = 0usize;
    loop {
        match tokio::time::timeout_at(deadline, set.join_next()).await {
            Ok(None) => break,
            Ok(Some(r)) => match r.map_err(|e| e.to_string()).and_then(|x| x) {
                Ok(x) => {
                    out.push(x);
                    on_done(out.len());
                }
                Err(e) => last_err = Some(e),
            },
            Err(_) => {
                timed_out = set.len();
                set.abort_all();
                break;
            }
        }
    }
    out.sort_by_key(|x| x.0);
    (out.into_iter().map(|(_, w, s)| (w, s)).collect(), last_err, timed_out)
}

fn speech_windows(all: &[Analysed]) -> Vec<(Window, Vec<(f32, f32)>)> {
    let mut v: Vec<(Window, Vec<(f32, f32)>)> =
        all.iter().filter(|x| !x.1.intervals.is_empty()).map(|(w, s)| (*w, s.intervals.clone())).collect();
    v.sort_by(|a, b| a.0.start.total_cmp(&b.0.start));
    v
}

/// A fit that more audio could still confirm or overturn.
fn borderline(o: &Outcome) -> bool {
    match o {
        Outcome::Fit { agreeing, strength, .. } => *agreeing < 2 || *strength < 3.6,
        Outcome::Piecewise { .. } => false,
        _ => true,
    }
}

/// Windows that passed the gate but disagree with a constant fit.
fn has_dissent(o: &Outcome) -> bool {
    match o {
        Outcome::Fit { offset, window_offsets, .. } => window_offsets.iter().flatten().any(|w| (w - offset).abs() > 0.3),
        Outcome::Inconsistent { .. } => true,
        _ => false,
    }
}

struct StageCtx<'a> {
    media: &'a str,
    headers: &'a HashMap<String, String>,
    audio_ff_index: Option<i64>,
    deadline: tokio::time::Instant,
    per_window: Duration,
    progress: &'a (dyn Fn(Progress) + Send + Sync),
}

impl StageCtx<'_> {
    /// Decode one stage's windows into `all`; returns (last error, windows cut by the deadline).
    async fn run(&self, stage: &'static str, windows: &[Window], all: &mut Vec<Analysed>) -> (Option<String>, usize) {
        let total = windows.len();
        let label = match stage {
            "decode" => "Listening to the dialogue",
            "deeper" => "Checking more of the video",
            _ => "Checking where the timing changes",
        };
        let progress = self.progress;
        progress(Progress { stage, done: 0, total, message: format!("{label} (0/{total})") });
        let cb = |done: usize| progress(Progress { stage, done, total, message: format!("{label} ({done}/{total})") });
        let (got, err, cut) =
            decode_windows(self.media, self.headers, self.audio_ff_index, windows, self.deadline, self.per_window, &cb).await;
        all.extend(got);
        (err, cut)
    }
}

async fn solve_all(all: &[Analysed], cues: &[(f32, f32)], max_lag: f32) -> Result<(Outcome, Vec<(Window, Vec<(f32, f32)>)>), String> {
    let ws = speech_windows(all);
    let (ws2, cues) = (ws.clone(), cues.to_vec());
    let o = tokio::task::spawn_blocking(move || correlate::solve(&ws2, &cues, max_lag)).await.map_err(|e| e.to_string())?;
    Ok((o, ws))
}

/// Decode, detect speech and solve, in the stages described in the module docs.
/// Shared by the command and the `synccheck` example used for real-media
/// validation. Returns `Err` only when no window could be decoded at all.
pub async fn analyse(
    media: &str,
    headers: &HashMap<String, String>,
    audio_ff_index: Option<i64>,
    duration: f32,
    cues: Vec<(f32, f32)>,
    opts: &Options,
    progress: &(dyn Fn(Progress) + Send + Sync),
) -> Result<Analysis, String> {
    let started = tokio::time::Instant::now();
    let scale = opts.time_scale.clamp(1.0, 100.0);
    let deadline = started
        + match (opts.remote, opts.deep) {
            (false, false) => LOCAL_DEADLINE,
            (false, true) => DEEP_LOCAL_DEADLINE,
            (true, false) => REMOTE_DEADLINE,
            (true, true) => DEEP_REMOTE_DEADLINE,
        }
        .mul_f32(scale);
    let per_window = Duration::from_secs(if opts.remote { 75 } else { 40 }).mul_f32(scale);
    let max_lag = if opts.deep { DEEP_MAX_LAG_SEC } else { MAX_LAG_SEC };
    let mut planned = if opts.deep && !opts.remote {
        plan_deep_windows(duration, &cues)?
    } else {
        plan_windows(duration, &cues, opts.remote, opts.bytes_per_sec, opts.manual)?
    };
    if !opts.remote && planned.len() > 1 {
        planned.extend(head_window(&planned, &cues, duration));
    }
    // Remote streams: the stages after the first only on request, within budget.
    let bps = bps_or_default(opts.bytes_per_sec);
    let mut budget_sec = if opts.remote {
        if opts.deep { MANUAL_BUDGET / bps - planned.iter().map(|w| w.len).sum::<f32>() } else { 0.0 }
    } else {
        f32::INFINITY
    };

    let mut all: Vec<Analysed> = Vec::new();
    let mut last_err = None;
    let mut cut = 0usize;
    let ctx = StageCtx { media, headers, audio_ff_index, deadline, per_window, progress };
    let (e, c) = ctx.run("decode", &planned, &mut all).await;
    last_err = last_err.or(e);
    cut += c;
    if all.is_empty() {
        return Err(last_err.unwrap_or_else(|| "audio analysis timed out".into()));
    }
    let (mut outcome, mut ws) = solve_all(&all, &cues, max_lag).await?;

    // Stage 2: borderline → more windows where nothing was analysed yet.
    let time_left = |min: Duration| deadline.saturating_duration_since(tokio::time::Instant::now()) > min;
    if borderline(&outcome) && time_left(Duration::from_secs(4)) {
        let have: Vec<Window> = all.iter().map(|x| x.0).collect();
        let count = if opts.deep { 6 } else { have.len().clamp(2, 4) };
        let mut extra = fill_windows(&have, &cues, duration, count);
        while extra.iter().map(|w| w.len).sum::<f32>() > budget_sec && !extra.is_empty() {
            extra.pop();
        }
        if !extra.is_empty() {
            budget_sec -= extra.iter().map(|w| w.len).sum::<f32>();
            let (e, c) = ctx.run("deeper", &extra, &mut all).await;
            last_err = last_err.or(e);
            cut += c;
            (outcome, ws) = solve_all(&all, &cues, max_lag).await?;
        }
    }

    // Stage 3: a split in time order → decode between the stretches and verify.
    if has_dissent(&outcome) {
        let cues2 = cues.clone();
        let ws2 = ws.clone();
        let split = tokio::task::spawn_blocking(move || correlate::propose_split(&ws2, &cues2, max_lag))
            .await
            .map_err(|e| e.to_string())?;
        if std::env::var_os("KINLY_SYNC_DEBUG").is_some() {
            eprintln!("split proposal: {split:?}");
        }
        if let Some(split) = split {
            let have: Vec<Window> = ws.iter().map(|x| x.0).collect();
            let gaps = gap_windows(&split, &have, MAX_GAP_AUDIO_SEC.min(budget_sec));
            if !gaps.is_empty() && time_left(Duration::from_secs(2)) {
                let (e, c) = ctx.run("segments", &gaps, &mut all).await;
                last_err = last_err.or(e);
                cut += c;
                ws = speech_windows(&all);
            }
            let (cues2, ws2, ratio) = (cues.clone(), ws.clone(), split.ratio);
            let pw = tokio::task::spawn_blocking(move || correlate::solve_piecewise(&ws2, &cues2, ratio, max_lag))
                .await
                .map_err(|e| e.to_string())?;
            if std::env::var_os("KINLY_SYNC_DEBUG").is_some() {
                eprintln!("piecewise verification: {pw:?}");
            }
            match pw {
                Some(p) => outcome = p,
                None => {
                    // Not confirmed: keep a constant fit, re-solved on all audio.
                    let (cues2, ws2) = (cues.clone(), ws.clone());
                    outcome = tokio::task::spawn_blocking(move || correlate::solve(&ws2, &cues2, max_lag))
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }

    let plain = all.iter().filter(|x| x.1.source == vad::SpeechSource::Plain).count();
    let audio_sec: f32 = all.iter().map(|x| x.0.len).sum();
    crate::log_info!(
        "sync",
        "analysed {} windows ({audio_sec:.0}s audio) in {}ms ({cut} cut by the deadline{}); speech per window: {}",
        all.len(),
        started.elapsed().as_millis(),
        last_err.as_deref().map(|e| format!("; last error: {e}")).unwrap_or_default(),
        all.iter()
            .map(|(w, s)| format!(
                "{:.0}s:{}{:.0}%",
                w.start,
                if s.source == vad::SpeechSource::Plain { "plain " } else { "" },
                s.intervals.iter().map(|(a, b)| b - a).sum::<f32>() / w.len * 100.0
            ))
            .collect::<Vec<_>>()
            .join(" ")
    );
    if plain > 0 && plain * 2 >= all.len() {
        outcome.reason_mut().push_str(" (little centred dialogue: plain voice detection used)");
    }
    progress(Progress { stage: "solve", done: 1, total: 1, message: "Done".into() });
    Ok(Analysis { outcome, analysed: all.len(), audio_sec })
}

impl SyncReport {
    fn empty() -> Self {
        SyncReport {
            status: "uncertain",
            offset_sec: 0.0,
            ratio: 1.0,
            strength: 0.0,
            agreeing_windows: 0,
            analysed_windows: 0,
            window_offsets: Vec::new(),
            segments: Vec::new(),
            retimed_path: None,
            audio_sec: 0.0,
            deep: false,
            elapsed_ms: 0,
            reason: None,
        }
    }
    fn busy() -> Self {
        SyncReport { status: "busy", reason: Some("another sync is running".into()), ..Self::empty() }
    }
    pub fn from_outcome(outcome: Outcome, analysed_windows: usize, elapsed_ms: u64) -> Self {
        match outcome {
            Outcome::Fit { offset, ratio, strength, agreeing, window_offsets, reason } => SyncReport {
                status: "fit",
                offset_sec: offset,
                ratio,
                strength,
                agreeing_windows: agreeing,
                analysed_windows,
                window_offsets,
                elapsed_ms,
                reason: Some(reason),
                ..SyncReport::empty()
            },
            Outcome::Piecewise { ratio, segments, strength, agreeing, window_offsets, reason } => SyncReport {
                status: "piecewise",
                offset_sec: segments.first().map(|g| g.offset).unwrap_or(0.0),
                ratio,
                strength,
                agreeing_windows: agreeing,
                analysed_windows,
                window_offsets,
                segments,
                elapsed_ms,
                reason: Some(reason),
                ..SyncReport::empty()
            },
            Outcome::Inconsistent { window_offsets, reason } => SyncReport {
                status: "inconsistent",
                window_offsets,
                analysed_windows,
                elapsed_ms,
                reason: Some(reason),
                ..SyncReport::empty()
            },
            Outcome::Uncertain { reason } => {
                SyncReport { status: "uncertain", analysed_windows, elapsed_ms, reason: Some(reason), ..SyncReport::empty() }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn even_cues(duration: f32) -> Vec<(f32, f32)> {
        (0..(duration / 10.0) as usize).map(|i| (i as f32 * 10.0, i as f32 * 10.0 + 4.0)).collect()
    }

    #[test]
    fn plans_local_windows() {
        let w = plan_windows(6000.0, &even_cues(6000.0), false, None, false).unwrap();
        assert_eq!(w.len(), 6, "100 min local file: one window per ~15 min, capped at 6");
        assert!(w.iter().all(|w| w.len == 300.0 && w.start + w.len <= 6000.0));
        assert!(w.windows(2).all(|p| p[0].start + p[0].len <= p[1].start), "{w:?}");
        assert!(plan_windows(60.0, &[], false, None, false).is_err());
        let short = plan_windows(734.0, &even_cues(734.0), false, None, false).unwrap();
        assert_eq!(short.len(), 1);
        assert!(short[0].start == 0.0 && (short[0].len - 734.0).abs() < 1e-3, "short local files are analysed whole: {short:?}");
        let stream = plan_windows(734.0, &even_cues(734.0), true, Some(0.1 * 1024.0 * 1024.0), false).unwrap();
        assert!((stream[0].len - 300.0).abs() < 1e-3, "{stream:?}");
    }

    #[test]
    fn windows_avoid_dialogue_free_stretches() {
        // Dialogue only in 1000..2000 s of a 6000 s film (second third is silent).
        let cues: Vec<(f32, f32)> = (0..100).map(|i| (1000.0 + i as f32 * 10.0, 1004.0 + i as f32 * 10.0)).collect();
        // Three windows (stream): the first third's window slides onto the dialogue.
        let w = plan_windows(6000.0, &cues, true, Some(0.1 * 1024.0 * 1024.0), false).unwrap();
        assert!(w[0].start + w[0].len > 1000.0, "first window should reach the dialogue: {:?}", w[0]);
        // Six windows (local): the window of the 1000-2000 s part sits on the dialogue.
        let w = plan_windows(6000.0, &cues, false, None, false).unwrap();
        assert!(w.iter().any(|w| w.start >= 1000.0 && w.start + w.len <= 2000.0), "{w:?}");
    }

    #[test]
    fn remote_windows_respect_the_download_budget() {
        let mb = 1024.0 * 1024.0;
        // 5 Mbit/s web stream: three windows fit the automatic budget.
        let c = even_cues(6000.0);
        let w = plan_windows(6000.0, &c, true, Some(0.625 * mb), false).unwrap();
        let total: f32 = w.iter().map(|w| w.len).sum::<f32>() * 0.625 * mb;
        assert!(total <= 300.0 * mb + 1.0, "download {total}");
        assert!(w.iter().all(|w| w.len >= 120.0));
        // 40 Mbit/s remux: too large automatically, and even for a manual run.
        assert!(plan_windows(6000.0, &c, true, Some(5.0 * mb), false).is_err());
        assert!(plan_windows(6000.0, &c, true, Some(5.0 * mb), true).is_err());
        // 12 Mbit/s: only with the larger manual budget.
        assert!(plan_windows(6000.0, &c, true, Some(1.5 * mb), false).is_err());
        assert!(plan_windows(6000.0, &c, true, Some(1.5 * mb), true).is_ok());
    }

    #[test]
    fn window_count_grows_with_length() {
        assert_eq!(window_count(700.0, false), 1);
        assert_eq!(window_count(2280.0, false), 3);
        assert_eq!(window_count(3600.0, false), 4);
        assert_eq!(window_count(9000.0, false), 6);
        assert_eq!(window_count(9000.0, true), 3);
    }

    use correlate::tests::cue_pattern;
    use vad::tests::voice;

    /// Synthetic soundtrack for one window: voice wherever the (distorted)
    /// subtitle has a line, `audio = r * cue + b`, every 7th line unspoken,
    /// plus low broadband noise.
    fn soundtrack(cues: &[(f32, f32)], r: f32, b: f32, w: Window) -> Vec<f32> {
        let on: Vec<(f32, f32)> = cues
            .iter()
            .enumerate()
            .filter(|(i, _)| i % 7 != 3)
            .map(|(_, &(s, e))| (r * s + b - w.start, r * e + b - w.start))
            .filter(|&(s, e)| e > 0.0 && s < w.len)
            .collect();
        let mono = voice(w.len, &on);
        let mut seed: u32 = 7;
        mono.iter()
            .flat_map(|&x| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                let n = ((seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5) * 0.004;
                [x + n, x - n]
            })
            .collect()
    }

    fn solve_audio(cues: &[(f32, f32)], r: f32, b: f32, w: Window) -> Outcome {
        let pcm = soundtrack(cues, r, b, w);
        let speech = vad::detect(&pcm, w.start, &vad::VadConfig::default());
        correlate::solve(&[(w, speech.intervals)], cues, MAX_LAG_SEC)
    }

    #[test]
    fn synthetic_audio_offset_is_found() {
        let cues = cue_pattern(700.0);
        let w = Window { start: 120.0, len: 300.0 };
        match solve_audio(&cues, 1.0, -6.4, w) {
            Outcome::Fit { offset, ratio, .. } => {
                assert!((offset + 6.4).abs() < 0.15, "offset {offset}");
                assert_eq!(ratio, 1.0);
            }
            other => panic!("expected fit, got {other:?}"),
        }
    }

    #[test]
    fn synthetic_audio_framerate_ratio_is_found() {
        let cues = cue_pattern(700.0);
        let w = Window { start: 120.0, len: 300.0 };
        let r_true = 25.0 / 23.976;
        match solve_audio(&cues, r_true, 1.5, w) {
            Outcome::Fit { offset, ratio, reason, .. } => {
                assert!((ratio - r_true).abs() < 1e-5, "ratio {ratio}");
                assert!((offset - 1.5).abs() < 0.2, "offset {offset}");
                assert!(reason.contains("25/23.976"), "{reason}");
            }
            other => panic!("expected fit, got {other:?}"),
        }
    }

    #[test]
    fn synthetic_audio_without_speech_is_uncertain() {
        let cues = cue_pattern(700.0);
        let w = Window { start: 120.0, len: 300.0 };
        let mut seed: u32 = 99;
        let noise: Vec<f32> = (0..(w.len * vad::SR as f32) as usize * 2)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                ((seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5) * 0.002
            })
            .collect();
        let speech = vad::detect(&noise, w.start, &vad::VadConfig::default());
        let windows: Vec<_> = Some((w, speech.intervals)).into_iter().filter(|x| !x.1.is_empty()).collect();
        let report = SyncReport::from_outcome(correlate::solve(&windows, &cues, MAX_LAG_SEC), 1, 0);
        assert_eq!(report.status, "uncertain");
        assert!(report.reason.is_some_and(|r| r.contains("speech")));
    }
}
