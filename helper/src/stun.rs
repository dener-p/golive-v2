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
/// MAPPED-ADDRESS attribute (0x0001) / XOR-MAPPED-ADDRESS (0x0020, RFC 5389 §15.2).
const STUN_MAPPED_ATTR: u16 = 0x0001;
const STUN_XOR_MAPPED_ATTR: u16 = 0x0020;
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

// ---------------------------------------------------------------------------
// NAT self-test (M7): what kind of network is the helper sitting behind?
//
// One UDP socket is queried against (up to) two *different* public STUN
// endpoints. If the same public ip:port comes back from both, the NAT is
// endpoint-independent (full/restricted-cone style) and plain srflx ICE
// reaches residential + most cellular peers. If the mapped port changes per
// destination it is endpoint-dependent (symmetric-style) and strict peers
// require TURN. A mapped address inside 100.64.0.0/10 means carrier CGNAT.
// A global IPv6 reflexive endpoint is reported separately (it can bypass NAT
// entirely). This mirrors the classic RFC 5780 classification as far as plain
// public STUN servers allow (they cannot answer CHANGE-REQUEST, so the
// cone-vs-restricted distinction is not attempted).
// ---------------------------------------------------------------------------

/// A server-reflexive address as reported by STUN.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NatMapping {
    pub ip: std::net::IpAddr,
    pub port: u16,
}

/// Hosting-network classification result for the host page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NatVerdict {
    /// Nothing to test against (no STUN servers configured).
    NoServers,
    /// No STUN server answered over UDP — egress likely blocked.
    Unreachable,
    /// Mapped public address is in 100.64.0.0/10 (carrier CGNAT).
    Cgnat,
    /// Mapped address is private — double NAT with no usable mapping.
    PrivateMapped,
    /// Same socket maps to different public ports per destination.
    Symmetric,
    /// Stable public ip:port across the sampled endpoints.
    Independent,
}

#[derive(Debug, Clone)]
/// The structured self-test result. Only `detail` crosses the ack today; the
/// typed fields are kept for a future status-channel export (and tests).
#[allow(dead_code)]
pub struct NatTestResult {
    pub verdict: NatVerdict,
    pub public_ip: Option<std::net::IpAddr>,
    pub public_port: Option<u16>,
    /// How many distinct endpoints returned a valid mapping (0/1/2).
    pub samples: usize,
    pub ipv6_global: Option<std::net::Ipv6Addr>,
    /// Human-readable summary shown verbatim on the host page.
    pub detail: String,
}

/// Fresh 12-byte transaction id, mangled with a probe sequence number so two
/// queries on the same socket never reuse a transaction.
fn new_txid(seq: u64) -> [u8; 12] {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut txid = [0u8; 12];
    txid[..8].copy_from_slice(&(now ^ seq.wrapping_mul(0x9E37_79B9_7F4A_7C15)).to_le_bytes());
    txid[8] = (std::process::id() & 0xff) as u8;
    txid[9] = seq as u8;
    txid
}

/// Decode the MAPPED-ADDRESS / XOR-MAPPED-ADDRESS attribute from a response.
fn parse_mapped(buf: &[u8], txid: &[u8; 12]) -> Option<NatMapping> {
    if buf.len() < 20 {
        return None;
    }
    let alen = u16::from_be_bytes([buf[2], buf[3]]) as usize;
    let attrs = &buf[20..buf.len().min(20 + alen)];
    let mut xor: Option<NatMapping> = None;
    let mut plain: Option<NatMapping> = None;
    let mut i = 0;
    while i + 4 <= attrs.len() {
        let t = u16::from_be_bytes([attrs[i], attrs[i + 1]]);
        let l = u16::from_be_bytes([attrs[i + 2], attrs[i + 3]]) as usize;
        let startv = i + 4;
        if startv + l > attrs.len() {
            break;
        }
        if let Some(m) = decode_mapped_attr(t, &attrs[startv..startv + l], txid) {
            if t == STUN_XOR_MAPPED_ATTR {
                xor = Some(m);
            } else if t == STUN_MAPPED_ATTR {
                plain = Some(m);
            }
        }
        i = startv + l + ((4 - (l % 4)) % 4);
    }
    xor.or(plain)
}

fn decode_mapped_attr(t: u16, v: &[u8], txid: &[u8; 12]) -> Option<NatMapping> {
    if v.len() < 8 {
        return None;
    }
    let family = v[1];
    let raw_port = u16::from_be_bytes([v[2], v[3]]);
    if t == STUN_XOR_MAPPED_ATTR {
        let port = raw_port ^ ((STUN_MAGIC_COOKIE >> 16) as u16);
        let cookie = STUN_MAGIC_COOKIE.to_be_bytes();
        match family {
            1 => Some(NatMapping {
                ip: std::net::Ipv4Addr::new(
                    v[4] ^ cookie[0],
                    v[5] ^ cookie[1],
                    v[6] ^ cookie[2],
                    v[7] ^ cookie[3],
                )
                .into(),
                port,
            }),
            2 if v.len() >= 20 => {
                let mut oct = [0u8; 16];
                oct.copy_from_slice(&v[4..20]);
                for (b, x) in oct[..4].iter_mut().zip(cookie) {
                    *b ^= x;
                }
                for (b, x) in oct[4..16].iter_mut().zip(txid) {
                    *b ^= x;
                }
                Some(NatMapping {
                    ip: std::net::Ipv6Addr::from(oct).into(),
                    port,
                })
            }
            _ => None,
        }
    } else if family == 1 {
        Some(NatMapping {
            ip: std::net::Ipv4Addr::new(v[4], v[5], v[6], v[7]).into(),
            port: raw_port,
        })
    } else if family == 2 && v.len() >= 20 {
        let mut oct = [0u8; 16];
        oct.copy_from_slice(&v[4..20]);
        Some(NatMapping {
            ip: std::net::Ipv6Addr::from(oct).into(),
            port: raw_port,
        })
    } else {
        None
    }
}

/// Send one binding request on `sock` and return the first valid
/// XOR-MAPPED-ADDRESS, or None after the probe timeout.
fn query_mapped(
    sock: &UdpSocket,
    addr: std::net::SocketAddr,
    txid: &[u8; 12],
) -> Option<NatMapping> {
    let req = build_binding_request(txid);
    sock.send_to(&req, addr).ok()?;
    let mut buf = [0u8; 600];
    let started = Instant::now();
    while started.elapsed() < PROBE_TIMEOUT {
        match sock.recv_from(&mut buf) {
            Ok((n, _)) => {
                if n < 20 {
                    continue;
                }
                let kind = u16::from_be_bytes([buf[0], buf[1]]);
                let cookie = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
                if cookie == STUN_MAGIC_COOKIE && buf[8..20] == *txid && kind == STUN_BINDING_RESPONSE
                {
                    if let Some(m) = parse_mapped(&buf[..n], txid) {
                        return Some(m);
                    }
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::WouldBlock =>
            {
                continue;
            }
            Err(_) => return None,
        }
    }
    None
}

/// Resolve up to two distinct IPv4 STUN endpoints from the configured URLs.
///
/// Two passes: DNS round-robin often returns a different record per query, so
/// resolving twice may surface a second address for a single hostname.
fn resolve_v4_endpoints(urls: &[String]) -> Vec<std::net::SocketAddr> {
    let mut out: Vec<std::net::SocketAddr> = Vec::new();
    for _ in 0..2 {
        for u in urls {
            let Some((host, port)) = parse_stun(u) else { continue };
            let Ok(addrs) = (host.as_str(), port).to_socket_addrs() else {
                continue;
            };
            for a in addrs {
                if a.is_ipv4() && !out.iter().any(|x| x.ip() == a.ip()) {
                    out.push(a);
                    if out.len() >= 2 {
                        return out;
                    }
                }
            }
        }
    }
    out
}

/// Best-effort reflexive IPv6 probe: if the resolved endpoint has AAAA records
/// and the host has working IPv6 egress, return the mapped (usually global)
/// address. Not fatal when unsupported.
fn probe_v6_endpoint(urls: &[String]) -> Option<std::net::Ipv6Addr> {
    for u in urls {
        let Some((host, port)) = parse_stun(u) else { continue };
        let Ok(addrs) = (host.as_str(), port).to_socket_addrs() else {
            continue;
        };
        for a in addrs {
            let std::net::IpAddr::V6(_) = a.ip() else { continue };
            let Ok(sock) = UdpSocket::bind("[::]:0") else { continue };
            let _ = sock.set_read_timeout(Some(RECV_TIMEOUT));
            let txid = new_txid(0x69);
            if let Some(m) = query_mapped(&sock, a, &txid) {
                if let std::net::IpAddr::V6(v6) = m.ip {
                    return Some(v6);
                }
            }
        }
    }
    None
}

/// True for the carrier-grade NAT shared-address space 100.64.0.0/10.
pub fn is_cgnat_ip(ip: &std::net::IpAddr) -> bool {
    if let std::net::IpAddr::V4(v4) = ip {
        let o = v4.octets();
        return o[0] == 100 && (64..=127).contains(&o[1]);
    }
    false
}

fn is_global_v4(ip: &std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    match o[0] {
        0 | 10 | 127 => false,
        100 if (64..=127).contains(&o[1]) => false,     // CGNAT
        169 if o[1] == 254 => false,                    // link-local
        172 if (16..=31).contains(&o[1]) => false,      // private
        192 if o[1] == 168 => false,                    // private
        192 if o[1] == 0 && o[2] == 0 => false,         // "this network"
        198 if (18..=19).contains(&o[1]) => false,      // documentation
        198 if o[1] == 51 && o[2] == 100 => false,      // benchmarking
        203 if o[1] == 0 && o[2] == 113 => false,       // documentation
        224..=255 => false,                              // multicast / reserved
        _ => true,
    }
}

fn ip_is_global(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => is_global_v4(v4),
        std::net::IpAddr::V6(v6) => {
            let s = v6.segments();
            let loop_or_v4mapped =
                s[0] == 0 && s[1] == 0 && s[2] == 0 && s[3] == 0 && s[4] == 0 && s[5] == 0 && s[6] == 0;
            !loop_or_v4mapped
                && (s[0] & 0xffc0) != 0xfe80     // link-local fe80::/10
                && (s[0] & 0xfe00) != 0xfc00     // unique-local fc00::/7
                && (s[0] & 0xff00) != 0xff00     // multicast ff00::/8
                && !(s[0] == 0x2001 && s[1] == 0x0db8) // documentation 2001:db8::/32
        }
    }
}

/// Classify the hosting network using the configured (public) STUN servers.
/// Blocking for up to ~1s of probing, mirroring `choose_server`.
pub fn run_self_test(urls: &[String]) -> NatTestResult {
    let eps = resolve_v4_endpoints(urls);
    let none = || NatTestResult {
        verdict: NatVerdict::NoServers,
        public_ip: None,
        public_port: None,
        samples: 0,
        ipv6_global: None,
        detail: "no STUN servers to test against".into(),
    };
    if eps.is_empty() {
        return none();
    }

    let sock = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(_) => return none(),
    };
    let _ = sock.set_read_timeout(Some(RECV_TIMEOUT));

    let mut mappings: Vec<NatMapping> = Vec::new();
    for (i, addr) in eps.iter().enumerate() {
        let txid = new_txid(i as u64 + 1);
        if let Some(m) = query_mapped(&sock, *addr, &txid) {
            mappings.push(m);
        }
    }

    let v6_global = probe_v6_endpoint(urls)
        .filter(|a| ip_is_global(&std::net::IpAddr::V6(*a)));
    let v6note = match &v6_global {
        Some(g) => format!(" · global IPv6 {g} available — v6 peers can bypass NAT"),
        None => String::new(),
    };

    let (verdict, detail) = if mappings.is_empty() {
        (
            NatVerdict::Unreachable,
            format!(
                "no STUN server responded — UDP egress appears blocked or filtered; streaming may not work{}",
                if v6_global.is_some() { " (IPv6 responded; only the IPv4 path failed)" } else { "" }
            ),
        )
    } else {
        let ip = mappings[0].ip;
        let port = mappings[0].port;
        if is_cgnat_ip(&ip) {
            (
                NatVerdict::Cgnat,
                format!("public {ip}:{port} is inside the carrier-CGNAT range (100.64/10) — direct P2P to remote viewers will likely need TURN{v6note}"),
            )
        } else if !ip_is_global(&ip) {
            (
                NatVerdict::PrivateMapped,
                format!("mapped {ip}:{port} is a private address — double NAT without a usable mapping; direct P2P likely fails, TURN required{v6note}"),
            )
        } else {
            let stable = mappings.len() > 1 && mappings[1].ip == ip && mappings[1].port == port;
            if stable || mappings.len() == 1 {
                (
                    NatVerdict::Independent,
                    format!(
                        "public {ip}:{port} stable across {} endpoint sample(s){} — endpoint-independent NAT; direct P2P works, TURN only needed for strict-CGNAT peers{v6note}",
                        mappings.len(),
                        if mappings.len() == 1 { " (single sample)" } else { "" }
                    ),
                )
            } else {
                (
                    NatVerdict::Symmetric,
                    format!("mapped port changes per destination (sample 2 differs from {ip}:{port}) — endpoint-dependent NAT; strict/symmetric peers will need TURN{v6note}"),
                )
            }
        }
    };

    NatTestResult {
        verdict,
        public_ip: mappings.first().map(|m| m.ip),
        public_port: mappings.first().map(|m| m.port),
        samples: mappings.len(),
        ipv6_global: v6_global,
        detail,
    }
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

    fn stun_response(txid: &[u8; 12], attr: &[u8]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&STUN_BINDING_RESPONSE.to_be_bytes());
        buf.extend_from_slice(&(attr.len() as u16).to_be_bytes());
        buf.extend_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
        buf.extend_from_slice(txid);
        buf.extend_from_slice(attr);
        buf
    }

    #[test]
    fn parse_xor_mapped_v4() {
        let txid = [1u8; 12];
        // Public 177.87.33.78:4444, XORed with magic cookie.
        let port = 4444u16 ^ ((STUN_MAGIC_COOKIE >> 16) as u16);
        let cookie = STUN_MAGIC_COOKIE.to_be_bytes();
        let ip = [177, 87, 33, 78];
        let mut attr = vec![0x00, 0x20, 0x00, 0x08, 0x00, 0x01]; // type, len, reserved, family v4
        attr.extend_from_slice(&port.to_be_bytes());
        for (b, x) in ip.iter().zip(cookie) {
            attr.push(b ^ x);
        }
        let buf = stun_response(&txid, &attr);
        let m = parse_mapped(&buf, &txid).expect("xor mapped v4");
        assert_eq!(m.ip, std::net::IpAddr::V4(std::net::Ipv4Addr::new(177, 87, 33, 78)));
        assert_eq!(m.port, 4444);
    }

    #[test]
    fn parse_mapped_plain_v4() {
        let txid = [2u8; 12];
        let mut attr = vec![0x00, 0x01, 0x00, 0x08, 0x00, 0x01, (4444 >> 8) as u8, (4444 & 0xff) as u8];
        attr.extend_from_slice(&[10, 0, 0, 5]);
        let buf = stun_response(&txid, &attr);
        let m = parse_mapped(&buf, &txid).expect("mapped v4");
        assert_eq!(m.port, 4444);
        assert_eq!(m.ip.to_string(), "10.0.0.5");
    }

    #[test]
    fn parse_xor_mapped_v6() {
        let txid: [u8; 12] = [0xaa; 12];
        let cookie = STUN_MAGIC_COOKIE.to_be_bytes();
        let addr: [u8; 16] = [
            0x28, 0x04, 0x29, 0x84, 0x95, 0x29, 0x21, 0x00, 0, 0, 0, 0, 0, 0, 0, 1,
        ];
        let mut xaddr = addr;
        for (b, x) in xaddr[..4].iter_mut().zip(cookie) {
            *b ^= x;
        }
        for (b, x) in xaddr[4..16].iter_mut().zip(txid) {
            *b ^= x;
        }
        let port = 40001u16 ^ ((STUN_MAGIC_COOKIE >> 16) as u16);
        let mut attr = vec![0x00, 0x20, 0x00, 0x14, 0x00, 0x02]; // type, len 20, reserved, family v6
        attr.extend_from_slice(&port.to_be_bytes());
        attr.extend_from_slice(&xaddr);
        let buf = stun_response(&txid, &attr);
        let m = parse_mapped(&buf, &txid).expect("xor mapped v6");
        assert_eq!(m.port, 40001);
        assert!(matches!(m.ip, std::net::IpAddr::V6(_)));
        assert!(ip_is_global(&m.ip), "2804::…/global should classify global");
    }

    #[test]
    fn cgnat_and_global_classifiers() {
        let cgn = |s: &str| is_cgnat_ip(&s.parse().unwrap());
        assert!(cgn("100.64.0.1"));
        assert!(cgn("100.127.255.255"));
        assert!(!cgn("100.63.0.1"));
        assert!(!cgn("100.128.0.1"));
        assert!(!cgn("192.168.1.5"));

        assert!(ip_is_global(&"177.87.33.78".parse().unwrap()));
        assert!(ip_is_global(&"8.8.8.8".parse().unwrap()));
        assert!(!ip_is_global(&"10.0.0.1".parse().unwrap()));
        assert!(!ip_is_global(&"192.168.1.5".parse().unwrap()));
        assert!(!ip_is_global(&"fe80::1".parse().unwrap()));
        assert!(!ip_is_global(&"fc00::1".parse().unwrap()));
        assert!(!ip_is_global(&"::1".parse().unwrap()));
        assert!(!ip_is_global(&"2001:db8::1".parse().unwrap()));
        assert!(ip_is_global(&"2804:2984:9529:2100::1".parse().unwrap()));
    }
}