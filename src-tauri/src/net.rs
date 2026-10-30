//! HTTP for the UI. Requests go through Rust so addon and metadata servers do
//! not need to send CORS headers, and so timeouts and size limits are enforced.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

const MAX_BODY: usize = 16 * 1024 * 1024;
pub const USER_AGENT: &str = concat!("Kinly/", env!("CARGO_PKG_VERSION"));

/// Addresses Kinly never connects to, whatever URL or host name leads there: link-local (cloud
/// metadata endpoints such as 169.254.169.254) and unspecified, also when written as an
/// IPv4-mapped IPv6 address.
fn always_blocked(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => v4.is_link_local() || v4.is_unspecified(),
        IpAddr::V6(v6) => v6.is_unspecified() || (v6.segments()[0] & 0xffc0) == 0xfe80,
    }
}

/// The resolved addresses Kinly may connect to; an error when none is left.
fn allowed_addrs(host: &str, addrs: impl IntoIterator<Item = SocketAddr>) -> Result<Vec<SocketAddr>, String> {
    let ok: Vec<SocketAddr> = addrs.into_iter().filter(|a| !always_blocked(a.ip())).collect();
    if ok.is_empty() {
        return Err(format!("{host} does not resolve to an address Kinly connects to"));
    }
    Ok(ok)
}

/// DNS for the shared client: `check_url` only sees the host name, so the addresses it resolves
/// to are checked here, for the first request and every redirect.
struct GuardedResolver;

impl reqwest::dns::Resolve for GuardedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let found = tokio::net::lookup_host((host.as_str(), 0)).await?;
            let ok = allowed_addrs(&host, found).map_err(|e| std::io::Error::new(std::io::ErrorKind::PermissionDenied, e))?;
            Ok(Box::new(ok.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

pub fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(10))
            .dns_resolver(Arc::new(GuardedResolver))
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
/// web page or addon can't use the app to reach them. Redirects are checked the same way, and the
/// shared client also checks the addresses a host name resolves to (`GuardedResolver`). The landing
/// page itself only answers requests addressed to `localhost:3000` (authcb.rs), which covers other
/// names that resolve to loopback.
pub fn check_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("unsupported scheme '{other}'")),
    }
    let host = parsed.host_str().unwrap_or("").trim_matches(['[', ']']);
    let landing = parsed.port() == Some(3000);
    let blocked = match host.parse::<IpAddr>() {
        Ok(ip) => always_blocked(ip) || (ip.to_canonical().is_loopback() && landing),
        Err(_) => {
            // `localhost.` and `*.localhost` are loopback names too.
            let name = host.trim_end_matches('.').to_ascii_lowercase();
            host.is_empty() || (landing && (name == "localhost" || name.ends_with(".localhost")))
        }
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
    fn rejects_other_spellings_of_blocked_addresses() {
        // IPv4-mapped IPv6 literals, and other names for the landing page.
        assert!(super::check_url("http://[::ffff:169.254.169.254]/latest/meta-data").is_err());
        assert!(super::check_url("http://[::ffff:127.0.0.1]:3000/done?ok=1").is_err());
        assert!(super::check_url("http://localhost.:3000/done?ok=1").is_err());
        assert!(super::check_url("http://kinly.localhost:3000/done?ok=1").is_err());
        assert!(super::check_url("http://0.0.0.0:11470/").is_err());
        // Local addon servers stay reachable.
        assert!(super::check_url("http://[::ffff:192.168.1.20]:11470/manifest.json").is_ok());
        assert!(super::check_url("http://localhost:11470/manifest.json").is_ok());
        assert!(super::check_url("http://192.168.1.20:7000/manifest.json").is_ok());
    }

    #[test]
    fn resolved_addresses_are_checked() {
        use std::net::SocketAddr;
        let a = |s: &str| s.parse::<SocketAddr>().unwrap();
        // A name that resolves only to a metadata or link-local address is refused.
        assert!(super::allowed_addrs("metadata.example", [a("169.254.169.254:0")]).is_err());
        assert!(super::allowed_addrs("v6.example", [a("[fe80::1]:0"), a("[::ffff:169.254.1.1]:0")]).is_err());
        assert!(super::allowed_addrs("none.example", []).is_err());
        // Blocked entries are dropped and the rest is used; loopback and LAN stay allowed.
        assert_eq!(super::allowed_addrs("mixed.example", [a("169.254.169.254:0"), a("93.184.215.14:0")]).unwrap(), vec![a("93.184.215.14:0")]);
        assert_eq!(super::allowed_addrs("addon.lan", [a("127.0.0.1:0"), a("192.168.1.20:0")]).unwrap().len(), 2);
    }

    #[tokio::test]
    async fn guarded_resolver_keeps_loopback_names_working() {
        use reqwest::dns::Resolve;
        let addrs: Vec<_> = super::GuardedResolver.resolve("localhost".parse().unwrap()).await.unwrap().collect();
        assert!(!addrs.is_empty() && addrs.iter().all(|a| a.ip().is_loopback()), "{addrs:?}");
    }

    /// A local server that answers every request with a redirect to `location`.
    fn redirecting_server(location: &str) -> String {
        let location = location.to_string();
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            for mut s in l.incoming().flatten().take(4) {
                let _ = s.read(&mut [0u8; 2048]);
                let _ = write!(s, "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            }
        });
        format!("http://{addr}/")
    }

    /// Live (needs DNS): nip.io answers `169.254.169.254.nip.io` with 169.254.169.254, a host name
    /// `check_url` alone accepts. `cargo test -- --ignored resolving_to_metadata`
    #[tokio::test]
    #[ignore]
    async fn host_names_resolving_to_metadata_are_refused() {
        let url = "http://169.254.169.254.nip.io/latest/meta-data";
        assert!(super::check_url(url).is_ok());
        let err = super::client().get(url).timeout(std::time::Duration::from_secs(5)).send().await.expect_err("refused");
        assert!(format!("{err:?}").contains("does not resolve to an address Kinly connects to"), "{err:?}");
    }

    #[tokio::test]
    async fn redirects_to_blocked_addresses_are_refused() {
        for target in ["http://169.254.169.254/latest/meta-data", "http://[::ffff:169.254.169.254]/", "http://localhost.:3000/done?ok=1"] {
            let url = redirecting_server(target);
            let err = super::client().get(&url).send().await.expect_err(target);
            assert!(err.is_redirect(), "{target}: {err:?}");
        }
    }

    #[test]
    fn method_whitelist() {
        assert_eq!(super::parse_method(Some("patch")).unwrap(), reqwest::Method::PATCH);
        assert_eq!(super::parse_method(None).unwrap(), reqwest::Method::GET);
        assert!(super::parse_method(Some("TRACE")).is_err());
    }
}
