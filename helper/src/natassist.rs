//! M8 experiment: router-assisted NAT port mapping (UPnP IGD / NAT-PMP), and
//! whether it can help GStreamer's `webrtcbin` ICE stack at all.
//!
//! Context (project.md §Milestone 8): the helper is the WebRTC *sender*. ICE
//! gathers a server-reflexive candidate from the UDP socket that libnice created
//! internally; `webrtcbin` exposes no way to pin that socket's local port (no
//! port-range / source-port property — verified against gst-inspect-1.0). This
//! module therefore measures what the milestone asks for and lets the facts
//! decide:
//!
//!   1. Is the router reachable for port mapping (SSDP IGD, NAT-PMP)?
//!   2. If yes: can a UDP mapping be created and verified externally — a STUN
//!      binding on the *same* socket reports the mapped public ip:port?
//!   3. Even a perfect mapping is created for a port that libnice did NOT pick,
//!      so it can never become an ICE candidate (M8 item 4). The experiment
//!      demonstrates that directly, and the conclusion (keep the feature only
//!      as an opt-in diagnostic, or leave it out) is recorded upstream.
//!
//! Pure `std::net` (blocking), consistent with `stun.rs` — no new HTTP deps.

use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant};

use url::Url;

use crate::stun;

const SSDP_MULTICAST: &str = "239.255.255.250:1900";
const IGD_ST: &str = "urn:schemas-upnp-org:device:InternetGatewayDevice:1";
const UDP: &str = "UDP";
const APP_TAG: &str = "golive-m8";
const SSDP_SETTLE: Duration = Duration::from_millis(2500);
const IO_TIMEOUT: Duration = Duration::from_secs(4);
const PMP_PORT: u16 = 5351;
const MAPPING_LEASE: u32 = 3600;

/// What kind of router NAT assistance was discovered.
pub enum Gateway {
    /// UPnP IGD found: control URL for the port-mapping service.
    Igd {
        gateway_ip: IpAddr,
        service: String,
        control_url: String,
    },
    /// NAT-PMP gateway answered with its public (WAN) IP.
    Pmp {
        gateway_ip: IpAddr,
        public_ip: IpAddr,
        epoch: u32,
    },
    /// Neither discovered.
    Unavailable { reason: String },
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// Discover router NAT assistance: SSDP IGD first, then NAT-PMP against
/// gateway candidates (ipconfig any-locale + derived from our own LAN IP).
pub fn discover() -> Gateway {
    let ssdp = ssdp_probe();
    for (src, loc) in &ssdp {
        if let Some((service, control_url)) = igd_control_from_location(loc) {
            if !src.is_unspecified() {
                return Gateway::Igd {
                    gateway_ip: *src,
                    service,
                    control_url,
                };
            }
        }
    }

    let candidates = default_gateway_candidates();
    let mut probed: Vec<String> = Vec::new();
    let mut answered: Option<(IpAddr, u32, IpAddr)> = None; // gw, epoch, public
    for gw in &candidates {
        probed.push(gw.to_string());
        if let Some((epoch, public_ip)) = pmp_probe(*gw) {
            answered = Some((*gw, epoch, public_ip));
            break;
        }
    }
    match answered {
        Some((gw, epoch, public_ip)) => Gateway::Pmp {
            gateway_ip: gw,
            public_ip,
            epoch,
        },
        None => Gateway::Unavailable {
            reason: format!(
                "SSDP found no IGD ({} reply/ies); NAT-PMP probed [{}]: unanswered",
                ssdp.len(),
                probed.join(", ")
            ),
        },
    }
}

/// M-SEARCH for `urn:schemas-upnp-org:device:InternetGatewayDevice:1`, return
/// (responder ip, LOCATION xml url) pairs. Tries an ephemeral source port first,
/// then the SSDP-mandated 1900 (some routers only answer that).
fn ssdp_probe() -> Vec<(IpAddr, String)> {
    let mut out: Vec<(IpAddr, String)> = Vec::new();
    for attempt in 0..2 {
        let bind = if attempt == 0 {
            "0.0.0.0:0"
        } else {
            "0.0.0.0:1900"
        };
        let sock = match UdpSocket::bind(bind) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let _ = sock.set_multicast_ttl_v4(2);
        let _ = sock.set_read_timeout(Some(Duration::from_millis(400)));
        let msg = format!(
            "M-SEARCH * HTTP/1.1\r\nHOST: {SSDP_MULTICAST}\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {IGD_ST}\r\n\r\n"
        );
        for _ in 0..3 {
            let _ = sock.send_to(msg.as_bytes(), SSDP_MULTICAST);
            std::thread::sleep(Duration::from_millis(60));
        }
        let started = Instant::now();
        let mut buf = [0u8; 2048];
        while started.elapsed() < SSDP_SETTLE {
            match sock.recv_from(&mut buf) {
                Ok((n, from)) => {
                    if let Some(loc) = location_from(&String::from_utf8_lossy(&buf[..n])) {
                        let ip = from.ip();
                        if !ip.is_unspecified() && !out.iter().any(|(i, l)| *i == ip && l == &loc) {
                            out.push((ip, loc));
                        }
                    }
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::TimedOut
                        || e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => break,
            }
        }
        if !out.is_empty() {
            break;
        }
    }
    out
}

/// Find the `LOCATION:` header value in an SSDP response.
fn location_from(text: &str) -> Option<String> {
    for line in text.split("\r\n") {
        let line = line.trim();
        if let Some(rest) = line
            .strip_prefix("LOCATION:")
            .or_else(|| line.strip_prefix("location:"))
        {
            let loc = rest.trim();
            if loc.contains("://") {
                return Some(loc.to_string());
            }
        }
    }
    None
}

/// Candidate default gateways: `ipconfig` (any locale) plus candidates derived
/// from our own LAN IP (.1 / .254). Windows-only ipconfig parsing; the derived
/// fallback works everywhere.
fn default_gateway_candidates() -> Vec<IpAddr> {
    let mut out: Vec<IpAddr> = Vec::new();
    #[cfg(windows)]
    if let Ok(proc) = std::process::Command::new("ipconfig").output() {
        let text = String::from_utf8_lossy(&proc.stdout);
        for line in text.lines() {
            let lower = line.to_ascii_lowercase();
            if lower.contains("gateway") && line.contains(':') {
                let v = line.split(':').nth(1).unwrap_or("").trim();
                if let Ok(addr) = v.parse::<IpAddr>() {
                    if !addr.is_unspecified() && !out.contains(&addr) {
                        out.push(addr);
                        if out.len() >= 3 {
                            break;
                        }
                    }
                }
            }
        }
    }

    // Locale-independent fallback: the gateway is almost always .1 or .254 in
    // the same /24 as our own LAN address.
    if let IpAddr::V4(v4) = local_interface_ip() {
        let o = v4.octets();
        for h in [1u8, 254u8] {
            let cand = IpAddr::V4(std::net::Ipv4Addr::new(o[0], o[1], o[2], h));
            if !out.contains(&cand) && cand != IpAddr::V4(v4) {
                out.push(cand);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// UPnP IGD
// ---------------------------------------------------------------------------

fn igd_control_from_location(location: &str) -> Option<(String, String)> {
    let xml = http_get(location)?;
    let base = Url::parse(location).ok()?;
    for (service, control) in extract_services(&xml) {
        if service.contains("WANIPConnection") || service.contains("WANPPPConnection") {
            if let Ok(resolved) = base.join(&control) {
                return Some((service, resolved.to_string()));
            }
        }
    }
    None
}

fn http_get(url: &str) -> Option<String> {
    let u = Url::parse(url).ok()?;
    let host = u.host_str()?.to_string();
    let port = u.port_or_known_default().unwrap_or(80);
    let path = if u.path().is_empty() {
        "/".to_string()
    } else {
        u.path().to_string()
    };
    let query = u.query().map(|q| format!("?{q}")).unwrap_or_default();
    let req = format!(
        "GET {path}{query} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nUser-Agent: golive-m8/0.1\r\n\r\n"
    );
    let mut stream = TcpStream::connect((host.as_str(), port)).ok()?;
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.write_all(req.as_bytes());
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    http_body(&text).map(|b| b.to_string())
}

fn http_body(text: &str) -> Option<&str> {
    let idx = text.find("\r\n\r\n")?;
    Some(&text[idx + 4..])
}

/// Extract (serviceType, controlURL) pairs from a device-description XML.
fn extract_services(xml: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for block in xml.split("<service>").skip(1) {
        let block = match block.split("</service>").next() {
            Some(b) => b,
            None => continue,
        };
        if let (Some(t), Some(c)) = (
            extract_tag(block, "serviceType"),
            extract_tag(block, "controlURL"),
        ) {
            out.push((t, c));
        }
    }
    out
}

fn extract_tag(s: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = s.find(&open)? + open.len();
    let rest = s.get(start..)?;
    let end = rest.find(&close)?;
    let v = rest[..end].trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

fn soap_call(control_url: &str, service: &str, action: &str, body: &str) -> String {
    let u = match Url::parse(control_url) {
        Ok(u) => u,
        Err(_) => return String::new(),
    };
    let host = match u.host_str() {
        Some(h) => h.to_string(),
        None => return String::new(),
    };
    let port = u.port_or_known_default().unwrap_or(80);
    let path = if u.path().is_empty() {
        "/".to_string()
    } else {
        u.path().to_string()
    };
    let q = u.query().map(|x| format!("?{x}")).unwrap_or_default();
    let req = format!(
        "POST {path}{q} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: text/xml; charset=\"utf-8\"\r\nSOAPAction: \"{service}#{action}\"\r\nConnection: close\r\nContent-Length: {len}\r\n\r\n{body}",
        len = body.len()
    );
    let Ok(mut stream) = TcpStream::connect((host.as_str(), port)) else {
        return String::new();
    };
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.write_all(req.as_bytes());
    let mut out = Vec::new();
    let _ = stream.read_to_end(&mut out);
    String::from_utf8_lossy(&out).to_string()
}

fn add_mapping_body(service: &str, external: u16, internal: u16, client: &str) -> String {
    format!(
        r#"<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:AddPortMapping xmlns:u="{service}"><NewRemoteHost></NewRemoteHost><NewExternalPort>{external}</NewExternalPort><NewProtocol>UDP</NewProtocol><NewInternalPort>{internal}</NewInternalPort><NewInternalClient>{client}</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>{APP_TAG}</NewPortMappingDescription><NewLeaseDuration>{MAPPING_LEASE}</NewLeaseDuration></u:AddPortMapping></s:Body></s:Envelope>"#
    )
}

fn delete_mapping_body(service: &str, external: u16) -> String {
    format!(
        r#"<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:DeletePortMapping xmlns:u="{service}"><NewRemoteHost></NewRemoteHost><NewExternalPort>{external}</NewExternalPort><NewProtocol>{UDP}</NewProtocol></u:DeletePortMapping></s:Body></s:Envelope>"#
    )
}

fn get_external_ip_body(service: &str) -> String {
    format!(
        r#"<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetExternalIPAddress xmlns:u="{service}"></u:GetExternalIPAddress></s:Body></s:Envelope>"#
    )
}

/// True when the SOAP response carries an error (HTTP 5xx or `errorCode`).
fn soap_failed(resp: &str) -> bool {
    let head = resp.lines().next().unwrap_or("");
    head.contains("500") || resp.contains("errorCode") || resp.contains("<s:Fault>")
}

fn soap_error(resp: &str) -> String {
    if let Some(code) = extract_tag(resp, "errorCode") {
        return format!("errorCode {code}");
    }
    if let Some(d) = extract_tag(resp, "errorDescription") {
        return d;
    }
    resp.lines().next().unwrap_or("?unknown?").to_string()
}

// ---------------------------------------------------------------------------
// NAT-PMP / PCP side
// ---------------------------------------------------------------------------

fn pmp_probe(gw: IpAddr) -> Option<(u32, IpAddr)> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    let _ = sock.set_read_timeout(Some(Duration::from_millis(700)));
    recv_or_none(&sock, gw, &[0u8, 0], 12, parse_pmp_probe).map(|r| (r.epoch, r.public_ip))
}

fn pmp_map(gw: IpAddr, internal: u16, external: u16, lifetime: u32) -> Option<ReceivedPmp> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    let _ = sock.set_read_timeout(Some(Duration::from_millis(700)));
    recv_or_none(
        &sock,
        gw,
        &pmp_map_request(internal, external, lifetime),
        16,
        parse_pmp_map_response,
    )
}

fn recv_or_none(
    sock: &UdpSocket,
    gw: IpAddr,
    req: &[u8],
    min: usize,
    parse: impl Fn(&[u8]) -> Option<ReceivedPmp>,
) -> Option<ReceivedPmp> {
    sock.send_to(req, SocketAddr::new(gw, PMP_PORT)).ok()?;
    let mut buf = [0u8; 64];
    for _ in 0..4 {
        match sock.recv_from(&mut buf) {
            Ok((n, _)) if n >= min => {
                if let Some(v) = parse(&buf[..n]) {
                    return Some(v);
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::WouldBlock => {}
            Ok(_) => {}
            Err(_) => return None,
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReceivedPmp {
    pub public_ip: IpAddr,
    pub epoch: u32,
    pub external_port: u16,
    pub lifetime: u32,
}

pub fn parse_pmp_probe(buf: &[u8]) -> Option<ReceivedPmp> {
    if buf.len() < 12 || buf[1] != 0 {
        return None;
    }
    if u16::from_be_bytes([buf[2], buf[3]]) != 0 {
        return None;
    }
    Some(ReceivedPmp {
        public_ip: IpAddr::V4(std::net::Ipv4Addr::new(buf[8], buf[9], buf[10], buf[11])),
        epoch: u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]),
        external_port: 0,
        lifetime: 0,
    })
}

pub fn parse_pmp_map_response(buf: &[u8]) -> Option<ReceivedPmp> {
    if buf.len() < 16 || buf[1] != 1 {
        return None;
    }
    if u16::from_be_bytes([buf[2], buf[3]]) != 0 {
        return None;
    }
    Some(ReceivedPmp {
        public_ip: IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
        epoch: u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]),
        external_port: u16::from_be_bytes([buf[10], buf[11]]),
        lifetime: u32::from_be_bytes([buf[12], buf[13], buf[14], buf[15]]),
    })
}

pub fn pmp_map_request(internal: u16, external: u16, lifetime: u32) -> Vec<u8> {
    let mut req = vec![0, 1, 0, 0];
    req.extend_from_slice(&internal.to_be_bytes());
    req.extend_from_slice(&external.to_be_bytes());
    req.extend_from_slice(&lifetime.to_be_bytes());
    req
}

// ---------------------------------------------------------------------------
// Verification helper (reuses stun.rs)
// ---------------------------------------------------------------------------

fn stun_verify(sock: &UdpSocket) -> Option<(IpAddr, u16)> {
    // One Google STUN endpoint; the same socket the mapping was created for.
    let addr: SocketAddr = ("74.125.250.129", 19302)
        .to_socket_addrs()
        .ok()
        .and_then(|mut it| it.next())
        .unwrap_or(SocketAddr::from(([74, 125, 250, 129], 19302)));
    let txid = stun::new_txid(0x4E41);
    let m = stun::query_mapped(sock, addr, &txid)?;
    Some((m.ip, m.port))
}

/// The LAN IP of the default interface, found by connecting a UDP socket to a
/// public address (no packets are sent) and reading getsockname.
fn local_interface_ip() -> IpAddr {
    if let Ok(probe) = UdpSocket::bind("0.0.0.0:0") {
        let _ = probe.connect(SocketAddr::from(([8, 8, 8, 8], 53)));
        if let Ok(local) = probe.local_addr() {
            return local.ip();
        }
    }
    IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED)
}

fn local_port_and_lan_ip() -> Option<(UdpSocket, u16, IpAddr)> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    let port = sock.local_addr().ok()?.port();
    let lan = local_interface_ip();
    Some((sock, port, lan))
}

// ---------------------------------------------------------------------------
// The experiment
// ---------------------------------------------------------------------------

/// Run the full M8 experiment and return a human-readable report for the
/// command ack (shown on the host page).
pub fn experiment() -> String {
    let mut lines: Vec<String> = Vec::new();
    let gateway = discover();
    match &gateway {
        Gateway::Igd { gateway_ip, .. } => {
            lines.push(format!("UPnP IGD reachable @ {gateway_ip}"));
        }
        Gateway::Pmp {
            gateway_ip,
            public_ip,
            epoch,
        } => {
            lines.push(format!(
                "NAT-PMP gateway {gateway_ip} (wan {public_ip}, epoch {epoch}s)"
            ));
        }
        Gateway::Unavailable { reason } => {
            lines.push(format!("no router NAT assistance: {reason}"));
        }
    }

    match gateway {
        Gateway::Unavailable { .. } => {
            lines.push("conclusion: nothing to map; srflx ICE already covers this network".into());
        }
        Gateway::Igd {
            gateway_ip: _,
            service,
            control_url,
        } => {
            let Some((sock, local_port, lan)) = local_port_and_lan_ip() else {
                lines.push("udp bind failed".into());
                return join(&lines);
            };
            let _ = sock.set_read_timeout(Some(Duration::from_millis(600)));
            lines.push(format!("bound local udp {lan}:{local_port}"));

            let resp = soap_call(
                &control_url,
                &service,
                "AddPortMapping",
                &add_mapping_body(&service, local_port, local_port, &lan.to_string()),
            );
            if soap_failed(&resp) {
                lines.push(format!("AddPortMapping refused ({})", soap_error(&resp)));
                return join(&lines);
            }
            let wan = external_ip_via_upnp(&control_url, &service);
            match wan {
                Some(ip) => lines.push(format!(
                    "router mapped wan {ip}:{local_port} -> {lan}:{local_port}"
                )),
                None => lines.push(format!(
                    "mapping {lan}:{local_port} created (wan ip unknown)"
                )),
            }

            let srflx = stun_verify(&sock);
            let _ = soap_call(
                &control_url,
                &service,
                "DeletePortMapping",
                &delete_mapping_body(&service, local_port),
            );
            match srflx {
                Some((ip, port)) => {
                    lines.push(format!("stun same-socket srflx {ip}:{port}"));
                    if Some(ip) == wan && port == local_port {
                        lines.push(
                            "router mapping == srflx: the NAT is port-preserving and honored the reservation"
                                .into(),
                        );
                    } else {
                        lines.push(format!(
                            "mapping != ICE socket: webrtcbin/libnice picks its own source port ({port}), not the mapped one -> a router mapping can never become the srflx candidate here"
                        ));
                    }
                }
                None => lines.push("stun verification failed (udp egress?)".into()),
            }
        }
        Gateway::Pmp {
            gateway_ip,
            public_ip,
            ..
        } => {
            let Some((sock, local_port, _lan)) = local_port_and_lan_ip() else {
                lines.push("udp bind failed".into());
                return join(&lines);
            };
            let _ = sock.set_read_timeout(Some(Duration::from_millis(600)));
            if let Some(map) = pmp_map(gateway_ip, local_port, local_port, MAPPING_LEASE) {
                lines.push(format!(
                    "NAT-PMP mapped {public_ip}:{} -> local {local_port} (lease {}s)",
                    map.external_port, map.lifetime
                ));
                let srflx = stun_verify(&sock);
                let _ = pmp_map(gateway_ip, local_port, map.external_port, 0); // delete on NAT-PMP
                match srflx {
                    Some((ip, port)) if ip == public_ip && port == map.external_port => {
                        lines.push(format!("srflx {ip}:{port} == PMP mapping (port-preserving)"));
                    }
                    Some((ip, port)) => lines.push(format!(
                        "srflx {ip}:{port} != PMP mapping -> the ICE socket did not use the mapped port"
                    )),
                    None => lines.push("stun verification failed".into()),
                }
            } else {
                lines.push("NAT-PMP mapping refused (unsupported/blocked)".into());
            }
        }
    }

    lines.push(
        "note: webrtcbin has no source-port pinning, so router mappings stay a diagnostic, not ICE input"
            .into(),
    );
    join(&lines)
}

fn external_ip_via_upnp(control_url: &str, service: &str) -> Option<IpAddr> {
    let resp = soap_call(
        control_url,
        service,
        "GetExternalIPAddress",
        &get_external_ip_body(service),
    );
    if soap_failed(&resp) {
        return None;
    }
    extract_tag(&resp, "NewExternalIPAddress").and_then(|s| s.parse().ok())
}

fn join(lines: &[String]) -> String {
    lines.join(" · ")
}

// ---------------------------------------------------------------------------
// Unit tests (no network)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssdp_location_parse() {
        let resp = concat!(
            "HTTP/1.1 200 OK\r\n",
            "CACHE-CONTROL: max-age=1800\r\n",
            "LOCATION: http://192.168.15.1:49152/rootDesc.xml\r\n",
            "SERVER: FRITZ!Box UPnP/1.0\r\n",
            "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n"
        );
        assert_eq!(
            location_from(resp).as_deref(),
            Some("http://192.168.15.1:49152/rootDesc.xml")
        );
        assert_eq!(location_from("garbage without location"), None);
    }

    #[test]
    fn service_extraction() {
        let xml = concat!(
            "<?xml version=\"1.0\"?><root><device><serviceList>",
            "<service><serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType><serviceId>g</serviceId><controlURL>/upnp/WANCommon</controlURL></service>",
            "<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><serviceId>WANIPConn1</serviceId><controlURL>/upnp/control/WANIPConn1</controlURL></service>",
            "</serviceList></device></root>"
        );
        let services = extract_services(xml);
        assert!(services
            .iter()
            .any(|(t, c)| t.contains("WANIPConnection:1") && c == "/upnp/control/WANIPConn1"));
    }

    #[test]
    fn tag_extraction_handles_whitespace() {
        assert_eq!(
            extract_tag("<a> 192.168.1.1 </a>", "a").as_deref(),
            Some("192.168.1.1")
        );
        assert_eq!(extract_tag("<a></a>", "a"), None);
        assert_eq!(extract_tag("<b>x</b>", "a"), None);
    }

    #[test]
    fn relative_control_url_resolved() {
        let base = Url::parse("http://192.168.1.1:49152/rootDesc.xml").unwrap();
        assert_eq!(
            base.join("/upnp/control/WANIPConn1").unwrap().to_string(),
            "http://192.168.1.1:49152/upnp/control/WANIPConn1"
        );
    }

    #[test]
    fn soap_bodies_look_right() {
        let body = add_mapping_body("urn:x:WANIPConnection:1", 5000, 5000, "192.168.1.50");
        assert!(body.contains("<NewExternalPort>5000</NewExternalPort>"));
        assert!(body.contains("<NewInternalPort>5000</NewInternalPort>"));
        assert!(body.contains("<NewInternalClient>192.168.1.50</NewInternalClient>"));
        assert!(body.contains("<NewProtocol>UDP</NewProtocol>"));
        assert!(body.contains(&format!(
            "<NewPortMappingDescription>{APP_TAG}</NewPortMappingDescription>"
        )));
    }

    #[test]
    fn soap_fault_detection() {
        let ok = "HTTP/1.1 200 OK\r\n\r\n<s:Envelope>...</s:Envelope>";
        assert!(!soap_failed(ok));
        let err = concat!(
            "HTTP/1.1 500 Internal Server Error\r\n",
            "<errorCode>725</errorCode><errorDescription>OnlyPermanentLeasesSupported</errorDescription>"
        );
        assert!(soap_failed(err));
        assert_eq!(soap_error(err), "errorCode 725");
    }

    #[test]
    fn pmp_packet_build_and_parse() {
        let req = pmp_map_request(4000, 4000, 3600);
        assert_eq!(
            req,
            vec![0, 1, 0, 0, 0x0f, 0xa0, 0x0f, 0xa0, 0, 0, 0x0e, 0x10]
        );

        let probe_resp = [0u8, 0, 0, 0, 0, 0, 0, 1, 177, 87, 33, 78];
        let p = parse_pmp_probe(&probe_resp).expect("probe");
        assert_eq!(p.public_ip, "177.87.33.78".parse::<IpAddr>().unwrap());

        let mut map_resp = vec![0u8, 1, 0, 0, 0, 0, 0, 1];
        map_resp.extend_from_slice(&[0x0f, 0xa0, 0x4e, 0x21, 0, 0, 0x0e, 0x10]);
        let m = parse_pmp_map_response(&map_resp).expect("map");
        assert_eq!(m.external_port, 0x4e21);
        assert_eq!(m.lifetime, 3600);
    }

    #[test]
    fn http_body_splits_headers() {
        assert_eq!(
            http_body("HTTP/1.1 200 OK\r\n\r\n<xml/>").unwrap(),
            "<xml/>"
        );
        assert_eq!(http_body("no separator"), None);
    }
}
