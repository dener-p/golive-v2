//! Minimal STUN client used to pick a reachable public STUN server (M6).
//!
//! GStreamer's `webrtcbin` exposes a *single* `stun-server` property, so
//! "use multiple public STUN servers" is implemented as a reachability probe:
//! fire a UDP Binding Request at every configured server, then pin the fastest
//! responder on each viewer's webrtcbin before ICE gathering starts. This keeps
//! srflx candidate discovery working even when one public endpoint (e.g. a
//! geographic Google STUN) is blocked or filtered on the host network.
//!
//! The probe is cheap (one UDP round-trip per server, parallel, ≤~800ms cap)
//! and the result is cached per server list for the process lifetime.

use std::net::{ToSocketAddrs, UdpSocket};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// RFC 5389 magic cookie.
const STUN_MAGIC_COOKIE: u32 = 0x2112_A442;
/// Binding request (0x0001). Response: success (0x0101) or error (0x0111).
const STUN_BINDING_REQUEST: u16 = 0x0001;
const STUN_BINDING_RESPONSE: u16 = 0x0101;
const STUN_BINDING_ERROR: u16 = 0x0111;
/// Default STUN port when a URL omits it.
const DEFAULT_STUN_PORT: u16 = 19302;
/// Per-server probe timeout.
const PROBE_TIMEOUT: Duration = Duration::from_millis(800);
/// How long one probe socket waits for a datagram batch.
const RECV_TIMEOUT: Duration = Duration::from_millis(200);

/// Parse `stun://host:port`, `stun:host:port`, or bare `host:port` into
/// (host, port). IPv6 literals may be bracketed (`stun://[::1]:3478`).
fn parse_stun(url: &str) -> Option<(String, u16)> {
    let rest = url
        .strip_prefix("stun://")
        .or_else(|| url.strip_prefix("stun:"))
        .unwrap_or(url);
    if rest.is_empty() {
        return None;
    }
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => {
            let port: u16 = p.parse().ok()?;
            (h, port)
        }
        None => (rest, DEFAULT_STUN_PORT),
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() || host.contains('/') {
        return None;
    }
    Some((host.to_string(), port))
}

fn build_binding_request(txid: &[u8; 12]) -> [u8; 20] {
    let mut req = [0u8; 20];
    req[0..2].copy_from_slice(&STUN_BINDING_REQUEST.to_be_bytes());
    req[4..8].copy_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
    req[8..20].copy_from_slice(txid);
    req
}

/// Fire a binding request at one STUN URL. Returns the round-trip time of the
/// fastest valid response, or None if the server is unreachable / not STUN.
fn probe(url: &str) -> Option<Duration> {
    let (host, port) = parse_stun(url)?;
    let addrs: Vec<std::net::SocketAddr> = (host.as_str(), port).to_socket_addrs().ok()?.collect();
    if addrs.is_empty() {
        return None;
    }

    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.set_read_timeout(Some(RECV_TIMEOUT)).ok()?;

    // Transaction id: not security-critical; mix in time + a per-probe counter.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut txid = [0u8; 12];
    txid[..8].copy_from_slice(&now.to_le_bytes());
    txid[8] = (std::process::id() & 0xff) as u8;
    txid[9] = (std::process::id() >> 8) as u8;
    let req = build_binding_request(&txid);

    let started = Instant::now();
    for addr in &addrs {
        if sock.send_to(&req, addr).is_ok() {
            break;
        }
    }

    let mut buf = [0u8; 600];
    while started.elapsed() < PROBE_TIMEOUT {
        match sock.recv_from(&mut buf) {
            Ok((n, _from)) => {
                if n < 20 {
                    continue;
                }
                let kind = u16::from_be_bytes([buf[0], buf[1]]);
                let cookie = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
                if cookie == STUN_MAGIC_COOKIE
                    && buf[8..20] == txid
                    && matches!(kind, STUN_BINDING_RESPONSE | STUN_BINDING_ERROR)
                {
                    return Some(started.elapsed());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::WouldBlock => {
                continue;
            }
            Err(_) => return None,
        }
    }
    None
}

type Cache = OnceLock<Mutex<Vec<(String, String)>>>;

fn cache() -> &'static Mutex<Vec<(String, String)>> {
    static CACHE: Cache = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

/// Probe all configured STUN URLs in parallel and return the fastest responder,
/// preserving list order for ties. The result is cached per URL list so stream
/// start/stop cycles never re-probe (unless the list changes).
pub fn choose_server(urls: &[String]) -> Option<String> {
    if urls.is_empty() {
        return None;
    }
    let key = urls.join(",");
    {
        let store = cache().lock().unwrap();
        if let Some((_, chosen)) = store.iter().find(|(k, _)| *k == key) {
            return Some(chosen.clone());
        }
    }

    let handles: Vec<_> = urls
        .iter()
        .enumerate()
        .map(|(i, u)| {
            let u = u.clone();
            std::thread::spawn(move || (i, probe(&u)))
        })
        .collect();

    let mut best: Option<(usize, Duration)> = None;
    for h in handles {
        if let Ok((i, Some(rtt))) = h.join() {
            // Strictly-better comparison keeps the earlier list index on ties.
            if best.map(|(_, b)| rtt < b).unwrap_or(true) {
                best = Some((i, rtt));
            }
        }
    }

    let chosen = best.map(|(i, _)| urls[i].clone());
    if let Some(c) = &chosen {
        cache().lock().unwrap().push((key, c.clone()));
    }
    chosen
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::UdpSocket;

    fn binding_response(txid: &[u8; 12]) -> [u8; 20] {
        let mut resp = [0u8; 20];
        resp[0..2].copy_from_slice(&STUN_BINDING_RESPONSE.to_be_bytes());
        resp[4..8].copy_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
        resp[8..20].copy_from_slice(txid);
        resp
    }

    /// A fake STUN responder that echoes the transaction id back.
    fn spawn_responder() -> UdpSocket {
        let sock = UdpSocket::bind("127.0.0.1:0").unwrap();
        let sock2 = sock.try_clone().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 256];
            loop {
                match sock2.recv_from(&mut buf) {
                    Ok((n, from)) => {
                        if n < 20 {
                            continue;
                        }
                        let txid: [u8; 12] = buf[8..20].try_into().unwrap();
                        let _ = sock2.send_to(&binding_response(&txid), from);
                    }
                    Err(_) => break,
                }
            }
        });
        sock
    }

    #[test]
    fn parse_stun_urls() {
        assert_eq!(
            parse_stun("stun://stun.l.google.com:19302"),
            Some(("stun.l.google.com".into(), 19302))
        );
        assert_eq!(
            parse_stun("stun:stun1.l.google.com:19302"),
            Some(("stun1.l.google.com".into(), 19302))
        );
        assert_eq!(parse_stun("stun:host"), Some(("host".into(), 19302)));
        assert_eq!(parse_stun("stun://[::1]:3478"), Some(("::1".into(), 3478)));
        assert_eq!(parse_stun("turns://x:5349/path"), None);
        assert_eq!(parse_stun("stun://"), None);
    }

    #[test]
    fn probe_picks_a_responding_server() {
        let responder = spawn_responder();
        let port = responder.local_addr().unwrap().port();
        let url = format!("stun://127.0.0.1:{port}");
        let rtt = probe(&url);
        assert!(rtt.is_some(), "live responder should answer");
    }

    #[test]
    fn probe_dead_server_returns_none() {
        // Grab a port that's bound then dropped: connection refused / no reply.
        let dead = UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = dead.local_addr().unwrap().port();
        drop(dead);
        assert_eq!(probe(&format!("stun://127.0.0.1:{port}")), None);
    }

    #[test]
    fn choose_server_prefers_the_responder() {
        let responder = spawn_responder();
        let port = responder.local_addr().unwrap().port();
        let live = format!("stun://127.0.0.1:{port}");

        // A dead port first, live responder second: choose_server must skip
        // the dead one and land on the responder.
        let dead = UdpSocket::bind("127.0.0.1:0").unwrap();
        let dead_port = dead.local_addr().unwrap().port();
        drop(dead);

        let urls = vec![
            format!("stun://127.0.0.1:{dead_port}"),
            live.clone(),
        ];
        assert_eq!(choose_server(&urls), Some(live));
    }
}