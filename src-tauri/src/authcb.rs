//! Landing page for Supabase email links.
//!
//! Supabase sends people who click the confirmation link to the project's Site URL,
//! `http://localhost:3000`. While the app waits for a confirmation it listens there (loopback only),
//! shows a "return to Kinly" page and emits `auth:callback`, so the app can sign in right away.
//! Tokens in the URL fragment never reach this server: browsers don't send fragments.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const ADDR: &str = "127.0.0.1:3000";
const LIFETIME: Duration = Duration::from_secs(30 * 60);
static RUNNING: AtomicBool = AtomicBool::new(false);

const PAGE: &str = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Kinly</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05070d;color:#e8eefc;font:16px/1.5 system-ui,sans-serif}
main{max-width:440px;padding:32px;text-align:center}h1{font-size:44px;margin:0 0 12px}h1 em{color:#4aa3ff;font-style:normal}
p{color:#9fb0cc}</style></head><body><main><h1>Kinly</h1><h2 id="t">Email confirmed</h2>
<p id="m">You can close this tab and go back to Kinly. It signs you in automatically.</p></main>
<script>
var h=new URLSearchParams(location.hash.slice(1));
if(h.get("error_code")==="otp_expired"){document.getElementById("t").textContent="This link was already used";
document.getElementById("m").textContent="If you opened it before, your email is already confirmed. Go back to Kinly and sign in.";}
else if(h.get("error")){document.getElementById("t").textContent="Couldn't confirm";
document.getElementById("m").textContent="Go back to Kinly and try signing in. If that fails, sign up again to get a new email.";}
fetch("/done?ok="+(h.get("error")?"0":"1")).catch(function(){});
</script></body></html>"#;

/// Starts the landing page if it isn't running. Returns false when port 3000 is taken.
#[tauri::command]
pub fn auth_callback_listen(app: AppHandle) -> bool {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return true;
    }
    let listener = match TcpListener::bind(ADDR) {
        Ok(l) => l,
        Err(e) => {
            crate::log_warn!("auth", "can't listen on {ADDR}: {e}");
            RUNNING.store(false, Ordering::SeqCst);
            return false;
        }
    };
    let _ = listener.set_nonblocking(true);
    std::thread::spawn(move || {
        let started = Instant::now();
        while started.elapsed() < LIFETIME {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                    let mut buf = [0u8; 2048];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let line = String::from_utf8_lossy(&buf[..n]);
                    let path = line.split_whitespace().nth(1).unwrap_or("/");
                    let (ctype, body) = if !addressed_here(&line) {
                        // Another host name that resolves to loopback (DNS rebinding, or a request
                        // a web page made under some other name): not this page.
                        ("text/plain", "")
                    } else if path.starts_with("/done") {
                        let _ = app.emit("auth:callback", path.contains("ok=1"));
                        ("text/plain", "ok")
                    } else if path == "/" || path.starts_with("/?") || path.starts_with("/#") {
                        ("text/html; charset=utf-8", PAGE)
                    } else {
                        ("text/plain", "")
                    };
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(200)),
                Err(_) => std::thread::sleep(Duration::from_millis(200)),
            }
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
    true
}

/// True when the request's Host header names this page: `localhost:3000` (the Site URL Supabase
/// links to) or `127.0.0.1:3000`.
fn addressed_here(request: &str) -> bool {
    request
        .lines()
        .skip(1)
        .take_while(|l| !l.is_empty())
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("host"))
        .is_some_and(|(_, v)| matches!(v.trim().to_ascii_lowercase().as_str(), "localhost:3000" | "127.0.0.1:3000"))
}

#[cfg(test)]
mod tests {
    use super::addressed_here;

    #[test]
    fn answers_only_requests_addressed_to_the_landing_page() {
        assert!(addressed_here("GET /done?ok=1 HTTP/1.1\r\nHost: localhost:3000\r\nAccept: */*\r\n\r\n"));
        assert!(addressed_here("GET / HTTP/1.1\r\nhost: 127.0.0.1:3000\r\n\r\n"));
        // Other names that resolve to loopback, and requests without a Host header.
        assert!(!addressed_here("GET /done?ok=1 HTTP/1.1\r\nHost: localtest.me:3000\r\n\r\n"));
        assert!(!addressed_here("GET /done?ok=1 HTTP/1.1\r\nHost: attacker.example:3000\r\n\r\n"));
        assert!(!addressed_here("GET /done?ok=1 HTTP/1.1\r\n\r\n"));
        // A "Host:" line in the body does not count.
        assert!(!addressed_here("POST /done HTTP/1.1\r\nX: 1\r\n\r\nHost: localhost:3000"));
    }
}
