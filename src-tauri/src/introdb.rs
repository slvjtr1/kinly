//! IntroDB (theintrodb.org): intro / recap / credits / preview timestamps.
//!
//! `GET https://api.theintrodb.org/v4/media?tmdb_id=&imdb_id=&season=&episode=&duration_ms=`
//! answers e.g. `{"type":"tv","season":1,"episode":2,"intro":[{"start_ms":314568,"end_ms":330969}],
//! "credits":[{"start_ms":2843000,"end_ms":null}]}`; 404 means unknown media.
//! A null start means the beginning, a null end means the end of the media.
//! Anonymous use is limited to 30 requests / 10 s, so answers (including
//! "not found") are cached in memory for the session.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const API: &str = "https://api.theintrodb.org/v4/media";
const KINDS: [&str; 4] = ["intro", "recap", "credits", "preview"];
const CACHE_TTL: Duration = Duration::from_secs(6 * 3600);
const CACHE_MAX: usize = 512;

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IntroDbArgs {
    #[serde(default)]
    pub tmdb_id: Option<u64>,
    #[serde(default)]
    pub imdb_id: Option<String>,
    #[serde(default)]
    pub season: Option<u32>,
    #[serde(default)]
    pub episode: Option<u32>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    /// "intro" | "recap" | "credits" | "preview"
    pub kind: &'static str,
    pub start_sec: f64,
    /// `None`: until the end of the media.
    pub end_sec: Option<f64>,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
pub struct Segments {
    pub segments: Vec<Segment>,
}

fn ms(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite() && *x >= 0.0).map(|x| x / 1000.0)
}

/// Map an IntroDB response body to segments, sorted by start.
pub fn map_response(body: &Value) -> Segments {
    let mut segments = Vec::new();
    for kind in KINDS {
        let Some(list) = body.get(kind).and_then(|v| v.as_array()) else { continue };
        for item in list {
            let start_sec = item.get("start_ms").and_then(ms).unwrap_or(0.0);
            let end_sec = item.get("end_ms").and_then(ms);
            if end_sec.is_some_and(|e| e <= start_sec) {
                continue;
            }
            segments.push(Segment { kind, start_sec, end_sec });
        }
    }
    segments.sort_by(|a, b| a.start_sec.partial_cmp(&b.start_sec).unwrap_or(std::cmp::Ordering::Equal));
    Segments { segments }
}

fn valid_imdb(id: &str) -> bool {
    id.len() >= 3 && id.len() <= 16 && id.starts_with("tt") && id[2..].chars().all(|c| c.is_ascii_digit())
}

pub fn query(a: &IntroDbArgs) -> Result<Vec<(&'static str, String)>, String> {
    let mut q = Vec::new();
    if let Some(id) = a.tmdb_id {
        q.push(("tmdb_id", id.to_string()));
    }
    if let Some(id) = a.imdb_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if !valid_imdb(id) {
            return Err("invalid IMDb id".into());
        }
        q.push(("imdb_id", id.to_string()));
    }
    if q.is_empty() {
        return Err("IntroDB needs a TMDB or IMDb id".into());
    }
    if let Some(s) = a.season {
        q.push(("season", s.to_string()));
    }
    if let Some(e) = a.episode {
        q.push(("episode", e.to_string()));
    }
    if let Some(d) = a.duration_ms.filter(|d| *d > 0) {
        q.push(("duration_ms", d.to_string()));
    }
    Ok(q)
}

/// Cache key: duration rounded to 10 s so tiny probe differences share an entry.
fn cache_key(q: &[(&str, String)]) -> String {
    q.iter()
        .map(|(k, v)| {
            if *k == "duration_ms" {
                format!("{k}={}", v.parse::<u64>().unwrap_or(0) / 10_000)
            } else {
                format!("{k}={v}")
            }
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn cache() -> &'static Mutex<HashMap<String, (Instant, Segments)>> {
    static C: OnceLock<Mutex<HashMap<String, (Instant, Segments)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn introdb_segments(args: IntroDbArgs) -> Result<Segments, String> {
    let q = query(&args)?;
    let key = cache_key(&q);
    if let Some((at, hit)) = cache().lock().map_err(|e| e.to_string())?.get(&key) {
        if at.elapsed() < CACHE_TTL {
            return Ok(hit.clone());
        }
    }
    let resp = crate::net::client()
        .get(API)
        .query(&q)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("IntroDB request failed: {}", crate::logging::redact(&e.to_string())))?;
    let status = resp.status().as_u16();
    let result = match status {
        404 => Segments::default(),
        200..=299 => {
            let body: Value = resp.json().await.map_err(|_| "IntroDB sent invalid JSON".to_string())?;
            map_response(&body)
        }
        429 => return Err("IntroDB rate limit reached; try again shortly".into()),
        s => return Err(format!("IntroDB http {s}")),
    };
    let mut c = cache().lock().map_err(|e| e.to_string())?;
    if c.len() >= CACHE_MAX {
        c.retain(|_, (at, _)| at.elapsed() < CACHE_TTL);
        if c.len() >= CACHE_MAX {
            c.clear();
        }
    }
    c.insert(key, (Instant::now(), result.clone()));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_tv_episode() {
        let body = json!({"tvdb_id":81189,"type":"tv","season":1,"episode":2,
            "intro":[{"start_ms":314568,"end_ms":330969}],
            "credits":[{"start_ms":2843000,"end_ms":null}]});
        let s = map_response(&body).segments;
        assert_eq!(s.len(), 2);
        assert_eq!(s[0], Segment { kind: "intro", start_sec: 314.568, end_sec: Some(330.969) });
        assert_eq!(s[1], Segment { kind: "credits", start_sec: 2843.0, end_sec: None });
    }

    #[test]
    fn null_start_is_zero_and_sorted() {
        let body = json!({"type":"movie",
            "preview":[{"start_ms":5000000,"end_ms":5050000}],
            "recap":[{"start_ms":10000,"end_ms":40000}],
            "intro":[{"start_ms":null,"end_ms":38000}]});
        let s = map_response(&body).segments;
        assert_eq!(s.iter().map(|x| x.kind).collect::<Vec<_>>(), ["intro", "recap", "preview"]);
        assert_eq!(s[0].start_sec, 0.0);
        assert_eq!(s[0].end_sec, Some(38.0));
    }

    #[test]
    fn ignores_unknown_keys_and_bad_ranges() {
        let body = json!({"type":"movie","outro":[{"start_ms":1,"end_ms":2}],
            "intro":[{"start_ms":5000,"end_ms":4000}, {"end_ms":3000}]});
        let s = map_response(&body).segments;
        assert_eq!(s, vec![Segment { kind: "intro", start_sec: 0.0, end_sec: Some(3.0) }]);
        assert!(map_response(&json!({})).segments.is_empty());
    }

    #[test]
    fn builds_query() {
        let q = query(&IntroDbArgs { tmdb_id: Some(1399), season: Some(1), episode: Some(2), duration_ms: Some(3_300_000), ..Default::default() }).unwrap();
        assert_eq!(q, vec![("tmdb_id", "1399".into()), ("season", "1".into()), ("episode", "2".into()), ("duration_ms", "3300000".into())]);
        assert!(query(&IntroDbArgs::default()).is_err());
        assert!(query(&IntroDbArgs { imdb_id: Some("tt0944947&x=1".into()), ..Default::default() }).is_err());
        assert_eq!(query(&IntroDbArgs { imdb_id: Some("tt0944947".into()), ..Default::default() }).unwrap().len(), 1);
    }

    #[test]
    fn cache_key_rounds_duration() {
        let a = query(&IntroDbArgs { tmdb_id: Some(1), duration_ms: Some(3_300_400), ..Default::default() }).unwrap();
        let b = query(&IntroDbArgs { tmdb_id: Some(1), duration_ms: Some(3_302_000), ..Default::default() }).unwrap();
        assert_eq!(cache_key(&a), cache_key(&b));
    }
}
