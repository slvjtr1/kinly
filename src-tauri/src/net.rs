//! HTTP for the UI. Requests go through Rust so addon and metadata servers do
//! not need to send CORS headers, and so timeouts and size limits are enforced.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

const MAX_BODY: usize = 16 * 1024 * 1024;
pub const USER_AGENT: &str = concat!("Kinly/", env!("CARGO_PKG_VERSION"));

pub fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::custom(|a| {
                if a.previous().len() >= 8 {
                    a.error("too many redirects")
                } else if let Err(e) = check_url(a.url().as_str()) {
                    a.error(e)
                } else {
                    a.follow()
                }
            }))
            .build()
            .expect("http client")
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// Accepts http(s) URLs. Local addon servers on loopback or the LAN stay reachable, but link-local
/// addresses (cloud metadata endpoints) and Kinly's own sign-in landing page are refused, so a
/// web page or addon can't use the app to reach them. Redirects are checked the same way.
pub fn check_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("unsupported scheme '{other}'")),
    }
    let host = parsed.host_str().unwrap_or("").trim_matches(['[', ']']);
    let landing = parsed.port() == Some(3000);
    let blocked = match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_link_local() || ip.is_unspecified() || (ip.is_loopback() && landing),
        Ok(std::net::IpAddr::V6(ip)) => {
            ip.is_unspecified() || (ip.segments()[0] & 0xffc0) == 0xfe80 || (ip.is_loopback() && landing)
        }
        Err(_) => host.is_empty() || (host.eq_ignore_ascii_case("localhost") && landing),
    };
    if blocked {
        return Err("this address is not allowed".into());
    }
    Ok(parsed)
}

pub async fn fetch_bytes(url: &str, timeout: Duration) -> Result<Vec<u8>, String> {
    let parsed = check_url(url)?;
    let resp = client()
        .get(parsed)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| format!("request failed: {}", crate::logging::redact(&e.to_string())))?;
    if !resp.status().is_success() {
        return Err(format!("http {}", resp.status().as_u16()));
    }
    read_capped(resp).await
}

async fn read_capped(mut resp: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("read failed: {e}"))? {
        if out.len() + chunk.len() > MAX_BODY {
            return Err("response too large".into());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// Methods the UI may use. PATCH: Supabase PostgREST row updates.
pub fn parse_method(m: Option<&str>) -> Result<reqwest::Method, String> {
    Ok(match m.unwrap_or("GET").to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        other => return Err(format!("unsupported method {other}")),
    })
}

#[tauri::command]
pub async fn http_request(req: HttpRequest) -> Result<HttpResponse, String> {
    let parsed = check_url(&req.url)?;
    let method = parse_method(req.method.as_deref())?;
    let mut rb = client()
        .request(method, parsed)
        .timeout(Duration::from_millis(req.timeout_ms.unwrap_or(15_000).clamp(1_000, 60_000)));
    for (k, v) in &req.headers {
        rb = rb.header(k, v);
    }
    if let Some(body) = req.body {
        rb = rb.body(body);
    }
    let resp = rb
        .send()
        .await
        .map_err(|e| format!("request failed: {}", crate::logging::redact(&e.to_string())))?;
    let status = resp.status().as_u16();
    let bytes = read_capped(resp).await?;
    Ok(HttpResponse { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_non_http() {
        assert!(super::check_url("file:///etc/passwd").is_err());
        assert!(super::check_url("https://example.com/x").is_ok());
        assert!(super::check_url("http://127.0.0.1:11470/manifest.json").is_ok());
        assert!(super::check_url("http://169.254.169.254/latest/meta-data").is_err());
        assert!(super::check_url("http://[fe80::1]/").is_err());
        assert!(super::check_url("http://127.0.0.1:3000/done?ok=1").is_err());
        assert!(super::check_url("http://localhost:3000/done").is_err());
    }

    #[test]
    fn method_whitelist() {
        assert_eq!(super::parse_method(Some("patch")).unwrap(), reqwest::Method::PATCH);
        assert_eq!(super::parse_method(None).unwrap(), reqwest::Method::GET);
        assert!(super::parse_method(Some("TRACE")).is_err());
    }
}
