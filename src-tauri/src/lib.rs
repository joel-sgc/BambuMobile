use base64::{engine::general_purpose::STANDARD, Engine as _};
use rumqttc::{
    AsyncClient, ConnectReturnCode, Event, MqttOptions, Packet, QoS, TlsConfiguration, Transport,
};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::Serialize;
use socket2::{Domain, Protocol, Socket, Type};
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State as TauriState};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
    task::AbortHandle,
};

// ── TLS: accept any certificate (Bambu printers use self-signed) ─────────────

#[derive(Debug)]
struct SkipVerifier;

impl ServerCertVerifier for SkipVerifier {
    fn verify_server_cert(
        &self,
        _: &CertificateDer,
        _: &[CertificateDer],
        _: &ServerName,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(
        &self,
        _: &[u8],
        _: &CertificateDer,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::ECDSA_NISTP521_SHA512,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ED25519,
        ]
    }
}

// ── Printer status types (mirrored in vite-env.d.ts) ─────────────────────────

#[derive(Debug, Clone, Serialize, Default)]
pub struct PrinterStatus {
    pub nozzle_temp: f64,
    pub nozzle_target: f64,
    pub bed_temp: f64,
    pub bed_target: f64,
    pub progress: u8,
    pub remaining_mins: u32,
    pub layer_num: u32,
    pub total_layer_num: u32,
    pub stage: String,
    pub gcode_state: String,
    pub ams: Vec<AmsUnit>,
    pub vt_tray: Option<AmsTray>,
    pub chamber_light: bool,
    pub spd_lvl: u8,
    pub subtask_name: String,
    pub task_id: String,
    pub hms: Vec<String>,
    pub device_name: String,
    /// Global slot ID of the tray currently loaded in the nozzle.
    /// 255 = nothing loaded, 254 = external spool, 0-15 = AMS slots.
    pub tray_now: u8,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct AmsUnit {
    pub id: u8,
    pub humidity: u8,
    pub trays: Vec<AmsTray>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AmsTray {
    pub id: u8,
    pub tray_type: String,
    pub color: String,
    pub name: String,
    /// Default print temperature for this filament (°C). Sent in filament-change commands.
    pub tray_temp: u16,
}

impl Default for AmsTray {
    fn default() -> Self {
        AmsTray {
            id: 0,
            tray_type: String::new(),
            color: String::new(),
            name: String::new(),
            tray_temp: 210, // OrcaSlicer default
        }
    }
}

// ── App state ─────────────────────────────────────────────────────────────────

pub(crate) struct AppState {
    pub(crate) connection: Mutex<Option<ConnectionHandles>>,
    // Persistent FTPS control connection — reused across all FTP commands so we
    // pay the TCP+TLS+auth overhead only once instead of once per operation.
    pub(crate) ftp: Arc<std::sync::Mutex<Option<FtpsConn>>>,
}

struct ConnectionHandles {
    ip: String,
    access_code: String,
    serial: String,
    mqtt_client: AsyncClient,
    abort_handles: Vec<AbortHandle>,
    status: Arc<Mutex<PrinterStatus>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified: i64, // sortable: YYYYMMDD (year*10000 + month*100 + day)
}

// ── MQTT payload parsing ──────────────────────────────────────────────────────

fn parse_status(payload: &[u8], status: &mut PrinterStatus) {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return;
    };

    // device_name is set via SSDP discovery (DevName.bambu.com), not MQTT.

    let Some(p) = v.get("print") else { return };

    macro_rules! f64_field {
        ($dst:expr, $key:expr) => {
            if let Some(n) = p.get($key).and_then(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            }) {
                $dst = n;
            }
        };
    }
    macro_rules! u64_field {
        ($dst:expr, $key:expr) => {
            if let Some(n) = p.get($key).and_then(|v| {
                v.as_u64()
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            }) {
                $dst = n as _;
            }
        };
    }
    macro_rules! str_field {
        ($dst:expr, $key:expr) => {
            if let Some(v) = p.get($key) {
                if let Some(s) = v.as_str() {
                    $dst = s.to_owned();
                } else if let Some(n) = v.as_u64() {
                    $dst = n.to_string();
                } else if let Some(n) = v.as_i64() {
                    $dst = n.to_string();
                }
            }
        };
    }

    f64_field!(status.nozzle_temp, "nozzle_temper");
    f64_field!(status.nozzle_target, "nozzle_target_temper");
    f64_field!(status.bed_temp, "bed_temper");
    f64_field!(status.bed_target, "bed_target_temper");
    u64_field!(status.progress, "mc_percent");
    u64_field!(status.remaining_mins, "mc_remaining_time");
    u64_field!(status.layer_num, "layer_num");
    u64_field!(status.total_layer_num, "total_layer_num");
    u64_field!(status.spd_lvl, "spd_lvl");
    str_field!(status.gcode_state, "gcode_state");
    str_field!(status.subtask_name, "subtask_name");
    str_field!(status.task_id, "task_id");

    if let Some(n) = p.get("stg_cur").and_then(|v| v.as_u64()) {
        status.stage = stage_name(n);
    }

    if let Some(lights) = p.get("lights_report").and_then(|v| v.as_array()) {
        for light in lights {
            if light.get("node").and_then(|v| v.as_str()) == Some("chamber_light") {
                status.chamber_light = light.get("mode").and_then(|v| v.as_str()) == Some("on");
            }
        }
    }

    // Bambu firmware sends numeric IDs as JSON strings ("0", "1", …).
    // parse_u8 accepts both forms and is reused for AMS and vt_tray parsing.
    let parse_u8 = |v: &serde_json::Value| -> u8 {
        v.as_u64()
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            .unwrap_or(0) as u8
    };

    if let Some(ams_obj) = p.get("ams") {
        // tray_now: global slot ID of currently-loaded tray. "255" = nothing loaded.
        if let Some(tn) = ams_obj.get("tray_now") {
            status.tray_now = parse_u8(tn);
        }

        if let Some(ams_arr) = ams_obj.get("ams").and_then(|v| v.as_array()) {
            status.ams = ams_arr
                .iter()
                .filter_map(|unit| {
                    let id = parse_u8(unit.get("id")?);
                    let humidity = unit.get("humidity").map(parse_u8).unwrap_or(0);
                    let trays = unit
                        .get("tray")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .map(|t| {
                                    let id =
                                        parse_u8(t.get("id").unwrap_or(&serde_json::Value::Null));
                                    let tray_type = t
                                        .get("tray_type")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_owned();
                                    let raw = t
                                        .get("tray_color")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("3F3F4600");
                                    // colour is RRGGBBAA; we only need RRGGBB
                                    let color = raw[..raw.len().min(6)].to_owned();
                                    let name = t
                                        .get("tray_sub_brands")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_owned();
                                    // tray_temp is "220" etc. — may be absent for empty slots.
                                    let tray_temp: u16 = t
                                        .get("tray_temp")
                                        .and_then(|v| {
                                            v.as_u64()
                                                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                                        })
                                        .unwrap_or(220) as u16;
                                    AmsTray {
                                        id,
                                        tray_type,
                                        color,
                                        name,
                                        tray_temp,
                                    }
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(AmsUnit {
                        id,
                        humidity,
                        trays,
                    })
                })
                .collect();
        }
    }

    // External spool (mounted outside AMS)
    if let Some(vt) = p.get("vt_tray") {
        let tray_type = vt
            .get("tray_type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_owned();
        status.vt_tray = if !tray_type.is_empty() {
            let id = parse_u8(vt.get("id").unwrap_or(&serde_json::Value::Null));
            let raw = vt
                .get("tray_color")
                .and_then(|v| v.as_str())
                .unwrap_or("3F3F4600");
            let color = raw[..raw.len().min(6)].to_owned();
            let name = vt
                .get("tray_sub_brands")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned();
            let tray_temp: u16 = vt
                .get("tray_temp")
                .and_then(|v| {
                    v.as_u64()
                        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                })
                .unwrap_or(220) as u16;
            Some(AmsTray {
                id,
                tray_type,
                color,
                name,
                tray_temp,
            })
        } else {
            None
        };
    }

    // HMS error codes — each entry has `attr` and `code` (both u32 hex strings).
    // Combine them into the 8-char key used in errors.json, e.g. "03008001".
    // Only update hms when the key is present. Bambu sends incremental updates
    // so most messages omit `hms` entirely — clearing on absence would cause
    // errors to disappear after a single tick.
    if let Some(hms_val) = p.get("hms") {
        status.hms = hms_val
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|entry| {
                        let attr = entry.get("attr").and_then(|v| v.as_u64())?;
                        let code = entry.get("code").and_then(|v| v.as_u64())?;
                        let s = format!("{:08X}{:08X}", attr, code);
                        Some(format!(
                            "{}-{}-{}-{}",
                            &s[0..4],
                            &s[4..8],
                            &s[8..12],
                            &s[12..16]
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
    }
}

fn stage_name(stg: u64) -> String {
    match stg {
        0 => "Idle",
        1 => "Auto bed leveling",
        2 => "Heatbed preheating",
        4 => "Changing filament",
        7 => "Heating hotend",
        9 => "Scanning bed surface",
        10 => "Inspecting first layer",
        13 => "Homing toolhead",
        14 => "Cleaning nozzle",
        17 => "Printing",
        20 => "Paused by user",
        22 => "Filament unloading",
        24 => "Filament loading",
        _ => "Working",
    }
    .to_owned()
}

// ── SSDP: retrieve DevName.bambu.com via unicast M-SEARCH + multicast NOTIFY ──
//
// Unicast M-SEARCH (primary): sent directly to printer_ip:1900 — works over
// Tailscale subnet routes and any network where the IP is reachable.
// Multicast NOTIFY (bonus): listen on 239.255.255.250:1900 for the printer's
// periodic 5-second broadcasts — local network only.

// ── UPnP device description via plain HTTP on port 80 ────────────────────────
// The printer's SSDP Location header points to http://<ip>/ which serves a
// standard UPnP XML description containing <friendlyName> — the user-set name.
// Plain TCP to port 80 routes fine over Tailscale or any VPN.

async fn fetch_upnp_name(ip: &str, app: &AppHandle) -> Option<String> {
    let _ = app.emit("ssdp-debug", format!("[upnp] trying http://{}:80/", ip));

    let mut stream = match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::net::TcpStream::connect(format!("{}:80", ip)),
    )
    .await
    {
        Ok(Ok(s)) => s,
        _ => {
            let _ = app.emit(
                "ssdp-debug",
                format!("[upnp] port 80 not reachable on {}", ip),
            );
            return None;
        }
    };

    let req = format!("GET / HTTP/1.0\r\nHost: {}\r\n\r\n", ip);
    if stream.write_all(req.as_bytes()).await.is_err() {
        return None;
    }

    let mut buf = Vec::new();
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        stream.read_to_end(&mut buf),
    )
    .await;

    let text = String::from_utf8_lossy(&buf);
    let _ = app.emit(
        "ssdp-debug",
        format!(
            "[upnp] response ({} bytes): {}",
            buf.len(),
            &text[..text.len().min(400)]
        ),
    );

    // UPnP XML: <friendlyName>My P1S</friendlyName>
    if let Some(start) = text.find("<friendlyName>") {
        let rest = &text[start + "<friendlyName>".len()..];
        if let Some(end) = rest.find("</friendlyName>") {
            let name = rest[..end].trim().to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }

    None
}

fn ssdp_extract_name(msg: &str, serial_upper: &str) -> Option<String> {
    // Accept the packet if it mentions our serial (case-insensitive) OR if serial
    // is empty. This handles the rare case of a misconfigured serial entry.
    if !serial_upper.is_empty() && !msg.to_uppercase().contains(serial_upper) {
        return None;
    }
    for line in msg.lines() {
        if let Some(name) = line.trim().strip_prefix("DevName.bambu.com:") {
            let name = name.trim();
            if !name.is_empty() {
                return Some(name.to_owned());
            }
        }
    }
    None
}

async fn ssdp_apply(name: String, status: &Arc<Mutex<PrinterStatus>>, app: &AppHandle) {
    let mut st = status.lock().await;
    if st.device_name != name {
        st.device_name = name.clone();
        let _ = app.emit("printer-name", &name);
    }
}

async fn ssdp_name_loop(
    ip: String,
    serial: String,
    status: Arc<Mutex<PrinterStatus>>,
    app: AppHandle,
) {
    let serial_upper = serial.to_uppercase();
    let msearch = concat!(
        "M-SEARCH * HTTP/1.1\r\n",
        "HOST: 239.255.255.250:1900\r\n",
        "MAN: \"ssdp:discover\"\r\n",
        "MX: 1\r\n",
        "ST: urn:bambulab-com:device:3dprinter:1\r\n",
        "\r\n",
    );

    let _ = app.emit("ssdp-debug", format!("[ssdp] starting for printer {}", ip));

    // Multicast listener on :1900
    {
        let su = serial_upper.clone();
        let st = status.clone();
        let ap = app.clone();
        tokio::spawn(async move {
            ssdp_multicast_listen(su, st, ap).await;
        });
    }
    // Listener on port 2021 (Bambu direct broadcast port)
    {
        let su = serial_upper.clone();
        let st = status.clone();
        let ap = app.clone();
        tokio::spawn(async move {
            ssdp_port_listen(2021, su, st, ap).await;
        });
    }

    // Main discovery loop — runs every 30 s, tries all unicast methods.
    let targets = [
        "239.255.255.250:1900".to_string(), // multicast — standard SSDP, works on LAN
        format!("{}:1900", ip),             // unicast to printer — works over Tailscale
        format!("{}:2021", ip),             // unicast on Bambu's alternate port
    ];
    loop {
        // UPnP HTTP — plain TCP, works over Tailscale
        if let Some(name) = fetch_upnp_name(&ip, &app).await {
            ssdp_apply(name, &status, &app).await;
        }

        // SSDP M-SEARCH
        if let Ok(sock) = tokio::net::UdpSocket::bind("0.0.0.0:0").await {
            for target in &targets {
                match sock.send_to(msearch.as_bytes(), target).await {
                    Err(e) => {
                        let _ = app.emit(
                            "ssdp-debug",
                            format!("[msearch] send to {} failed: {}", target, e),
                        );
                    }
                    Ok(_) => {
                        let _ = app.emit("ssdp-debug", format!("[msearch] sent to {}", target));
                    }
                }
            }
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            let mut buf = vec![0u8; 2048];
            loop {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match tokio::time::timeout(remaining, sock.recv_from(&mut buf)).await {
                    Ok(Ok((len, src))) => {
                        let msg = String::from_utf8_lossy(&buf[..len]).to_string();
                        let _ = app.emit(
                            "ssdp-debug",
                            format!(
                                "[msearch] response from {}: {}",
                                src,
                                &msg[..msg.len().min(300)]
                            ),
                        );
                        if let Some(name) = ssdp_extract_name(&msg, &serial_upper) {
                            ssdp_apply(name, &status, &app).await;
                        }
                    }
                    _ => break,
                }
            }
        }

        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    }
}

async fn ssdp_port_listen(
    port: u16,
    serial_upper: String,
    status: Arc<Mutex<PrinterStatus>>,
    app: AppHandle,
) {
    use std::net::SocketAddr;
    let std_socket = (|| -> std::io::Result<std::net::UdpSocket> {
        let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
        sock.set_reuse_address(true)?;
        #[cfg(unix)]
        sock.set_reuse_port(true)?;
        sock.set_broadcast(true)?;
        sock.bind(&SocketAddr::from(([0, 0, 0, 0], port)).into())?;
        Ok(sock.into())
    })();
    let std_socket = match std_socket {
        Ok(s) => {
            let _ = app.emit("ssdp-debug", format!("[port{}] listening", port));
            s
        }
        Err(e) => {
            let _ = app.emit("ssdp-debug", format!("[port{}] bind failed: {}", port, e));
            return;
        }
    };
    std_socket.set_nonblocking(true).ok();
    let socket = match tokio::net::UdpSocket::from_std(std_socket) {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut buf = vec![0u8; 2048];
    loop {
        let (len, src) = match socket.recv_from(&mut buf).await {
            Ok(r) => r,
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
        };
        let msg = String::from_utf8_lossy(&buf[..len]).to_string();
        let _ = app.emit(
            "ssdp-debug",
            format!(
                "[port{}] packet from {}: {}",
                port,
                src,
                &msg[..msg.len().min(200)]
            ),
        );
        if let Some(name) = ssdp_extract_name(&msg, &serial_upper) {
            ssdp_apply(name, &status, &app).await;
        }
    }
}

async fn ssdp_multicast_listen(
    serial_upper: String,
    status: Arc<Mutex<PrinterStatus>>,
    app: AppHandle,
) {
    use std::net::{Ipv4Addr, SocketAddr};

    let std_socket = (|| -> std::io::Result<std::net::UdpSocket> {
        let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
        sock.set_reuse_address(true)?;
        #[cfg(unix)]
        sock.set_reuse_port(true)?;
        sock.bind(&SocketAddr::from(([0, 0, 0, 0], 1900)).into())?;
        Ok(sock.into())
    })();

    let std_socket = match std_socket {
        Ok(s) => s,
        Err(e) => {
            let _ = app.emit(
                "ssdp-debug",
                format!("[multicast] bind :1900 failed: {}", e),
            );
            return;
        }
    };
    std_socket.set_nonblocking(true).ok();
    let multicast = Ipv4Addr::new(239, 255, 255, 250);
    match std_socket.join_multicast_v4(&multicast, &Ipv4Addr::UNSPECIFIED) {
        Ok(_) => {
            let _ = app.emit(
                "ssdp-debug",
                "[multicast] joined 239.255.255.250 on :1900".to_string(),
            );
        }
        Err(e) => {
            let _ = app.emit("ssdp-debug", format!("[multicast] join failed: {}", e));
        }
    }

    let socket = match tokio::net::UdpSocket::from_std(std_socket) {
        Ok(s) => s,
        Err(e) => {
            let _ = app.emit(
                "ssdp-debug",
                format!("[multicast] tokio wrap failed: {}", e),
            );
            return;
        }
    };

    let mut buf = vec![0u8; 2048];
    loop {
        let (len, src) = match socket.recv_from(&mut buf).await {
            Ok(r) => r,
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
        };
        let msg = String::from_utf8_lossy(&buf[..len]).to_string();
        let _ = app.emit(
            "ssdp-debug",
            format!(
                "[multicast] packet from {}: {}",
                src,
                &msg[..msg.len().min(200)]
            ),
        );
        if let Some(name) = ssdp_extract_name(&msg, &serial_upper) {
            ssdp_apply(name, &status, &app).await;
        }
    }
}

// ── Camera: MJPG over TLS on port 6000 ───────────────────────────────────────
//
// Protocol (per OpenBambuAPI/video.md):
//   1. TLS connect to <ip>:6000 (self-signed cert, no verification)
//   2. Send 80-byte auth packet:
//        [0..3]   u32 LE = 0x40        (payload size)
//        [4..7]   u32 LE = 0x3000      (packet type: auth)
//        [8..15]  u64    = 0            (flags + padding)
//        [16..47] 32 bytes: "bblp" NUL-padded
//        [48..79] 32 bytes: access_code NUL-padded
//   3. Loop: read 16-byte frame header (payload_size u32 LE, ...) then JPEG.

async fn camera_loop(ip: String, access_code: String, app: AppHandle) {
    let tls_cfg = Arc::new(
        rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(SkipVerifier))
            .with_no_client_auth(),
    );
    let connector = tokio_rustls::TlsConnector::from(tls_cfg);

    // Derive a ServerName from the IP (no SNI for raw IPs, but verification
    // is disabled anyway so the printer's self-signed cert is accepted).
    let server_name: ServerName<'static> = match ip.parse::<std::net::IpAddr>() {
        Ok(addr) => ServerName::IpAddress(rustls::pki_types::IpAddr::from(addr)),
        Err(_) => match ServerName::try_from(ip.clone()) {
            Ok(n) => n,
            Err(_) => return,
        },
    };

    loop {
        let Ok(stream) = tokio::net::TcpStream::connect(format!("{}:6000", ip)).await else {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            continue;
        };

        let Ok(mut tls) = connector.connect(server_name.clone(), stream).await else {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            continue;
        };

        // Build and send 80-byte auth packet
        let mut auth = [0u8; 80];
        auth[0..4].copy_from_slice(&0x40u32.to_le_bytes());
        auth[4..8].copy_from_slice(&0x3000u32.to_le_bytes());
        let user = b"bblp";
        auth[16..16 + user.len()].copy_from_slice(user);
        let pass = access_code.as_bytes();
        let plen = pass.len().min(32);
        auth[48..48 + plen].copy_from_slice(&pass[..plen]);

        if tls.write_all(&auth).await.is_err() {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            continue;
        }

        // Read frames until error or disconnect
        loop {
            let mut hdr = [0u8; 16];
            if tls.read_exact(&mut hdr).await.is_err() {
                break;
            }

            let payload_size = u32::from_le_bytes(hdr[0..4].try_into().unwrap()) as usize;
            if payload_size == 0 || payload_size > 1_048_576 {
                break;
            }

            let mut frame = vec![0u8; payload_size];
            if tls.read_exact(&mut frame).await.is_err() {
                break;
            }

            // Validate JPEG start-of-image marker
            if payload_size >= 2 && frame[0] == 0xFF && frame[1] == 0xD8 {
                let b64 = STANDARD.encode(&frame);
                let _ = app.emit("camera-frame", b64);
            }
        }

        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
async fn connect_printer(
    ip: String,
    access_code: String,
    serial: String,
    app: AppHandle,
    state: TauriState<'_, AppState>,
) -> Result<(), String> {
    let mut conn = state.connection.lock().await;
    if conn.is_some() {
        return Err("Already connected".into());
    }

    // MQTT with TLS (skip cert verification for Bambu self-signed cert)
    let tls_cfg = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(SkipVerifier))
        .with_no_client_auth();

    let mut opts = MqttOptions::new("bamboo-mobile", &ip, 8883);
    opts.set_credentials("bblp", &access_code);
    opts.set_keep_alive(std::time::Duration::from_secs(10));
    opts.set_transport(Transport::Tls(TlsConfiguration::Rustls(Arc::new(tls_cfg))));

    let (mqtt_client, mut eventloop) = AsyncClient::new(opts, 64);

    // Poll until CONNACK with 10s timeout
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            match eventloop.poll().await {
                Ok(Event::Incoming(Packet::ConnAck(ack))) => {
                    return if ack.code == ConnectReturnCode::Success {
                        Ok(())
                    } else {
                        Err(format!(
                            "Authentication failed ({:?}) — check access code",
                            ack.code
                        ))
                    };
                }
                Ok(_) => continue,
                Err(e) => return Err(format!("Cannot reach printer: {}", e)),
            }
        }
    })
    .await
    .unwrap_or_else(|_| Err("Timed out — check printer IP and network".to_string()))?;

    // Subscribe and request a full status dump
    let topic = format!("device/{}/report", serial);
    mqtt_client
        .subscribe(&topic, QoS::AtMostOnce)
        .await
        .map_err(|e| e.to_string())?;
    // pushall is sent by the background task once SubAck confirms the subscription,
    // ensuring SUBSCRIBE is always processed by the broker before PUBLISH.

    let status = Arc::new(Mutex::new(PrinterStatus::default()));
    let mut abort_handles: Vec<AbortHandle> = Vec::new();

    // MQTT event loop task
    let status_c = status.clone();
    let app_c = app.clone();
    let mqtt_client_c = mqtt_client.clone();
    let serial_c = serial.clone();
    let handle = tokio::spawn(async move {
        let report_topic = format!("device/{}/report", serial_c);
        let req_topic = format!("device/{}/request", serial_c);
        let pushall = serde_json::json!({
            "pushing": {"sequence_id": "0", "command": "pushall", "version": 1}
        })
        .to_string();
        let get_version = serde_json::json!({
            "info": {"sequence_id": "0", "command": "get_version"}
        })
        .to_string();

        loop {
            match eventloop.poll().await {
                Ok(Event::Incoming(Packet::ConnAck(_))) => {
                    // Re-subscribe first so the broker always sees SUBSCRIBE before
                    // PUBLISH — some firmware (X1, H2, P2S) enforces this strictly.
                    let _ = mqtt_client_c
                        .subscribe(&report_topic, QoS::AtMostOnce)
                        .await;
                }
                Ok(Event::Incoming(Packet::SubAck(_))) => {
                    // Subscription confirmed — safe to publish. Send both the full
                    // status dump and a get_version to retrieve the device name.
                    let _ = mqtt_client_c
                        .publish(&req_topic, QoS::AtMostOnce, false, pushall.clone())
                        .await;
                    let _ = mqtt_client_c
                        .publish(&req_topic, QoS::AtMostOnce, false, get_version.clone())
                        .await;
                }
                Ok(Event::Incoming(Packet::Publish(msg))) => {
                    // Emit raw payload for the debug page before any parsing.
                    if let Ok(raw) = std::str::from_utf8(&msg.payload) {
                        let _ = app_c.emit("mqtt-raw", raw);
                    }
                    let mut st = status_c.lock().await;
                    let prev_name = st.device_name.clone();
                    parse_status(&msg.payload, &mut st);
                    if st.device_name != prev_name && !st.device_name.is_empty() {
                        let _ = app_c.emit("printer-name", &st.device_name);
                    }
                    let _ = app_c.emit("printer-status", st.clone());
                }
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
                _ => {}
            }
        }
    });
    abort_handles.push(handle.abort_handle());
    drop(handle);

    // Camera: MJPG over TLS on port 6000
    let camera_handle = tokio::spawn(camera_loop(ip.clone(), access_code.clone(), app.clone()));
    abort_handles.push(camera_handle.abort_handle());
    drop(camera_handle);

    // SSDP: unicast M-SEARCH + multicast NOTIFY to get the user-set printer name
    let ssdp_handle = tokio::spawn(ssdp_name_loop(
        ip.clone(),
        serial.clone(),
        status.clone(),
        app,
    ));
    abort_handles.push(ssdp_handle.abort_handle());
    drop(ssdp_handle);

    *conn = Some(ConnectionHandles {
        ip,
        access_code,
        serial,
        mqtt_client,
        abort_handles,
        status,
    });

    Ok(())
}

#[tauri::command]
async fn disconnect_printer(state: TauriState<'_, AppState>) -> Result<(), String> {
    // Close the persistent FTP control connection
    let ftp_arc = Arc::clone(&state.ftp);
    tokio::task::spawn_blocking(move || {
        if let Ok(mut slot) = ftp_arc.lock() {
            if let Some(mut conn) = slot.take() {
                ftp_writeln(&mut conn.stream, "QUIT").ok();
            }
        }
    })
    .await
    .ok();

    let mut conn = state.connection.lock().await;
    if let Some(c) = conn.take() {
        for h in c.abort_handles {
            h.abort();
        }
        let _ = c.mqtt_client.disconnect().await;
    }
    Ok(())
}

#[tauri::command]
async fn get_status(state: TauriState<'_, AppState>) -> Result<PrinterStatus, String> {
    let conn = state.connection.lock().await;
    match &*conn {
        Some(c) => Ok(c.status.lock().await.clone()),
        None => Err("Not connected".into()),
    }
}

#[tauri::command]
async fn set_print_speed(level: u8, state: TauriState<'_, AppState>) -> Result<(), String> {
    let conn = state.connection.lock().await;
    let c = conn.as_ref().ok_or("Not connected")?;
    let topic = format!("device/{}/request", c.serial);
    let payload = serde_json::json!({
        "print": {
            "sequence_id": "0",
            "command": "print_speed",
            "param": level.to_string()
        }
    });
    c.mqtt_client
        .publish(&topic, QoS::AtMostOnce, false, payload.to_string())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_chamber_light(on: bool, state: TauriState<'_, AppState>) -> Result<(), String> {
    let conn = state.connection.lock().await;
    let c = conn.as_ref().ok_or("Not connected")?;
    let topic = format!("device/{}/request", c.serial);
    let payload = serde_json::json!({
        "system": {
            "sequence_id": "0",
            "command": "ledctrl",
            "led_node": "chamber_light",
            "led_mode": if on { "on" } else { "off" },
            "led_on_time": 500,
            "led_off_time": 500,
            "loop_times": 0,
            "interval_time": 0
        }
    });
    c.mqtt_client
        .publish(&topic, QoS::AtLeastOnce, false, payload.to_string())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_gcode(gcode: String, state: TauriState<'_, AppState>) -> Result<(), String> {
    let conn = state.connection.lock().await;
    let c = conn.as_ref().ok_or("Not connected")?;
    let topic = format!("device/{}/request", c.serial);
    let payload = serde_json::json!({
        "print": {
            "sequence_id": "0",
            "command": "gcode_line",
            "param": gcode
        }
    });
    c.mqtt_client
        .publish(&topic, QoS::AtMostOnce, false, payload.to_string())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn printer_command(command: String, state: TauriState<'_, AppState>) -> Result<(), String> {
    let conn = state.connection.lock().await;
    let c = conn.as_ref().ok_or("Not connected")?;
    let topic = format!("device/{}/request", c.serial);
    let payload = serde_json::json!({ "print": { "command": command } });
    c.mqtt_client
        .publish(&topic, QoS::AtLeastOnce, false, payload.to_string())
        .await
        .map_err(|e| e.to_string())
}

// ── FTPS file manager (implicit TLS, port 990) ───────────────────────────────
// Minimal FTPS over rustls — no third-party FTP library, consistent with the
// existing SkipVerifier setup used for MQTT and the camera stream.

type FtpsStream = rustls::StreamOwned<rustls::ClientConnection, std::net::TcpStream>;

struct FtpsConn {
    stream: FtpsStream,
}

// Returns a live FTP control stream, reconnecting transparently if the server
// closed the connection while we were idle.
fn ensure_ftp<'a>(
    slot: &'a mut Option<FtpsConn>,
    ip: &str,
    access_code: &str,
) -> Result<&'a mut FtpsStream, String> {
    let alive = slot
        .as_mut()
        .map(|c| {
            ftp_writeln(&mut c.stream, "NOOP").is_ok()
                && ftp_read_response(&mut c.stream)
                    .map(|(code, _)| code == 200)
                    .unwrap_or(false)
        })
        .unwrap_or(false);
    if !alive {
        *slot = Some(FtpsConn {
            stream: ftps_connect(ip, access_code)?,
        });
    }
    Ok(&mut slot.as_mut().unwrap().stream)
}

// Tries to RETR a single path. Returns Ok(Some(bytes)) on success,
// Ok(None) if the file doesn't exist (550), Err on a control-channel failure.
fn ftp_try_retr(ctrl: &mut FtpsStream, ip: &str, path: &str) -> Result<Option<Vec<u8>>, String> {
    let data_addr = ftp_pasv(ctrl, ip)?;
    ftp_writeln(ctrl, &format!("RETR {}", path))?;

    let data_tcp = match std::net::TcpStream::connect(data_addr) {
        Ok(s) => s,
        Err(_) => {
            ftp_read_response(ctrl).ok();
            return Ok(None);
        }
    };
    data_tcp
        .set_read_timeout(Some(std::time::Duration::from_secs(15)))
        .ok();
    let mut data = match ftps_tls_stream(ip, data_tcp) {
        Ok(s) => s,
        Err(_) => {
            ftp_read_response(ctrl).ok();
            return Ok(None);
        }
    };

    let (code, _) = ftp_read_response(ctrl)?;
    if code != 125 && code != 150 {
        drop(data);
        return Ok(None);
    }

    let mut bytes = Vec::new();
    data.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    drop(data);
    ftp_read_response(ctrl).ok();
    Ok(Some(bytes))
}

// Downloads the first `max_bytes` of a remote file. If EOF is reached before
// the limit the 226 response is consumed cleanly; if we hit the limit first we
// force-close the data connection (ensure_ftp will reconnect the control channel
// on the next call via its NOOP health-check).
fn ftp_read_partial(
    ctrl: &mut FtpsStream,
    ip: &str,
    path: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let data_addr = ftp_pasv(ctrl, ip)?;
    ftp_writeln(ctrl, &format!("RETR {}", path))?;

    let data_tcp =
        std::net::TcpStream::connect(data_addr).map_err(|e| format!("Data connect: {}", e))?;
    data_tcp
        .set_read_timeout(Some(std::time::Duration::from_secs(30)))
        .ok();
    let mut data = ftps_tls_stream(ip, data_tcp)?;

    let (code, msg) = ftp_read_response(ctrl)?;
    if code != 125 && code != 150 {
        return Err(format!("RETR: {} {}", code, msg));
    }

    let mut buf = Vec::with_capacity(max_bytes.min(65_536));
    let mut chunk = [0u8; 8_192];
    loop {
        let n = data.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            drop(data);
            ftp_read_response(ctrl).ok(); // 226 — clean EOF
            return Ok(buf);
        }
        let space = max_bytes - buf.len();
        buf.extend_from_slice(&chunk[..n.min(space)]);
        if buf.len() >= max_bytes {
            drop(data); // force-close; control conn cleaned up by next ensure_ftp NOOP
            return Ok(buf);
        }
    }
}

// Parses the largest embedded thumbnail from a gcode header.
// Handles both `; thumbnail begin WxH SIZE` and `; thumbnail_QOI begin WxH SIZE`.
// Returns raw image bytes (PNG).
fn parse_gcode_thumbnail(data: &[u8]) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(data).unwrap_or("");

    let mut best_size = 0usize;
    let mut best_bytes: Option<Vec<u8>> = None;
    let mut in_thumb = false;
    let mut b64 = String::new();
    let mut current_size = 0usize;

    for line in text.lines() {
        let line = line.trim();
        if in_thumb {
            if line.starts_with("; thumbnail") && line.contains("end") {
                in_thumb = false;
                if !b64.is_empty() {
                    if let Ok(decoded) = STANDARD.decode(&b64) {
                        if current_size > best_size || best_bytes.is_none() {
                            best_size = current_size;
                            best_bytes = Some(decoded);
                        }
                    }
                }
                b64.clear();
                current_size = 0;
            } else if let Some(part) = line.strip_prefix("; ") {
                b64.push_str(part.trim());
            }
        } else if let Some(rest) = line.strip_prefix("; thumbnail").and_then(|s| {
            s.strip_prefix(" begin ")
                .or_else(|| s.strip_prefix("_QOI begin "))
                .or_else(|| s.strip_prefix("_PNG begin "))
        }) {
            // rest = "WxH SIZE"
            current_size = rest
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            in_thumb = true;
            b64.clear();
        }
    }

    best_bytes
}

fn detect_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        "image/png"
    } else {
        "image/jpeg"
    }
}

fn ftps_tls_stream(ip: &str, tcp: std::net::TcpStream) -> Result<FtpsStream, String> {
    let cfg = Arc::new(
        rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(SkipVerifier))
            .with_no_client_auth(),
    );
    let name: rustls::pki_types::ServerName<'static> = match ip.parse::<std::net::IpAddr>() {
        Ok(a) => rustls::pki_types::ServerName::IpAddress(rustls::pki_types::IpAddr::from(a)),
        Err(_) => rustls::pki_types::ServerName::try_from(ip.to_owned())
            .map_err(|_| format!("Invalid hostname: {}", ip))?,
    };
    let conn = rustls::ClientConnection::new(cfg, name).map_err(|e| e.to_string())?;
    Ok(rustls::StreamOwned::new(conn, tcp))
}

fn ftp_writeln(s: &mut impl Write, cmd: &str) -> Result<(), String> {
    s.write_all(format!("{}\r\n", cmd).as_bytes())
        .map_err(|e| e.to_string())
}

fn ftp_read_response(s: &mut impl Read) -> Result<(u16, String), String> {
    loop {
        let mut line = Vec::new();
        let mut b = [0u8; 1];
        loop {
            s.read_exact(&mut b).map_err(|e| e.to_string())?;
            if b[0] == b'\n' {
                break;
            }
            if b[0] != b'\r' {
                line.push(b[0]);
            }
        }
        let line = String::from_utf8_lossy(&line).into_owned();
        if line.len() >= 4 {
            if let Ok(code) = line[..3].parse::<u16>() {
                if line.as_bytes().get(3) == Some(&b' ') {
                    return Ok((code, line[4..].to_owned()));
                }
                // dash = multiline continuation — keep reading
            }
        }
    }
}

// Returns the data-channel address using the *control* IP + the port from PASV.
// Ignoring the PASV-advertised IP avoids failures when the printer reports a
// different interface address (e.g. wlan0 vs eth0) than the one we connected to.
fn ftp_pasv(s: &mut FtpsStream, server_ip: &str) -> Result<std::net::SocketAddr, String> {
    ftp_writeln(s, "PASV")?;
    let (code, msg) = ftp_read_response(s)?;
    if code != 227 {
        return Err(format!("PASV failed: {}", msg));
    }
    let start = msg.find('(').ok_or("Invalid PASV response")?;
    let end = msg.find(')').ok_or("Invalid PASV response")?;
    let n: Vec<u16> = msg[start + 1..end]
        .split(',')
        .filter_map(|p| p.trim().parse().ok())
        .collect();
    if n.len() != 6 {
        return Err("PASV parse error".into());
    }
    let port = n[4] * 256 + n[5];
    format!("{}:{}", server_ip, port)
        .parse()
        .map_err(|e: std::net::AddrParseError| e.to_string())
}

fn ftps_connect(ip: &str, access_code: &str) -> Result<FtpsStream, String> {
    let tcp = std::net::TcpStream::connect(format!("{}:990", ip))
        .map_err(|e| format!("FTP connect: {}", e))?;
    tcp.set_read_timeout(Some(std::time::Duration::from_secs(15)))
        .ok();
    tcp.set_write_timeout(Some(std::time::Duration::from_secs(15)))
        .ok();

    let mut s = ftps_tls_stream(ip, tcp)?;

    ftp_read_response(&mut s)?; // 220 welcome

    ftp_writeln(&mut s, "USER bblp")?;
    ftp_read_response(&mut s)?; // 331
    ftp_writeln(&mut s, &format!("PASS {}", access_code))?;
    let (code, msg) = ftp_read_response(&mut s)?;
    if code != 230 {
        return Err(format!("FTP login failed: {} {}", code, msg));
    }

    ftp_writeln(&mut s, "PBSZ 0")?;
    ftp_read_response(&mut s)?;
    ftp_writeln(&mut s, "PROT P")?;
    ftp_read_response(&mut s)?;
    ftp_writeln(&mut s, "TYPE I")?;
    ftp_read_response(&mut s)?; // binary mode for image/video transfers

    Ok(s)
}

fn month_num(m: &str) -> i64 {
    match m {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => 0,
    }
}

fn parse_list_entry(line: &str) -> Option<FileEntry> {
    // Unix listing: permissions links owner group size month day time-or-year name…
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 9 {
        return None;
    }
    let is_dir = parts[0].starts_with('d');
    let size: u64 = parts[4].parse().ok()?;
    let month = month_num(parts[5]);
    let day: i64 = parts[6].parse().unwrap_or(0);
    // parts[7] is either "HH:MM" (recent file, year omitted) or "YYYY" (older file)
    let (year, hhmm): (i64, i64) = if parts[7].contains(':') {
        let cur_year = 1970
            + (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
                / 31_557_600) as i64;
        let mut p = parts[7].splitn(2, ':');
        let h: i64 = p.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let m: i64 = p.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        (cur_year, h * 100 + m)
    } else {
        (parts[7].parse().unwrap_or(2026), 0)
    };
    // Encode as YYYYMMDDHHmm so the value sorts newest-highest
    let modified = year * 100_000_000 + month * 1_000_000 + day * 10_000 + hhmm;
    let name = parts[8..].join(" ");
    if name == "." || name == ".." || name.is_empty() {
        return None;
    }
    Some(FileEntry {
        name,
        size,
        is_dir,
        modified,
    })
}

#[tauri::command]
async fn list_files(
    path: String,
    state: TauriState<'_, AppState>,
) -> Result<Vec<FileEntry>, String> {
    let (ip, access_code) = {
        let conn = state.connection.lock().await;
        let c = conn.as_ref().ok_or("Not connected")?;
        (c.ip.clone(), c.access_code.clone())
    };
    let ftp_arc = Arc::clone(&state.ftp);

    tokio::task::spawn_blocking(move || -> Result<Vec<FileEntry>, String> {
        let mut slot = ftp_arc.lock().unwrap();
        let ctrl = ensure_ftp(&mut slot, &ip, &access_code)?;

        let data_addr = ftp_pasv(ctrl, &ip)?;
        ftp_writeln(ctrl, &format!("LIST {}", path))?;

        let data_tcp =
            std::net::TcpStream::connect(data_addr).map_err(|e| format!("Data connect: {}", e))?;
        data_tcp
            .set_read_timeout(Some(std::time::Duration::from_secs(30)))
            .ok();
        let mut data = ftps_tls_stream(&ip, data_tcp)?;

        let (code, msg) = ftp_read_response(ctrl)?;
        if code != 125 && code != 150 {
            return Err(format!("LIST error: {} {}", code, msg));
        }

        let mut listing = String::new();
        data.read_to_string(&mut listing)
            .map_err(|e| e.to_string())?;
        drop(data);
        ftp_read_response(ctrl).ok(); // 226 transfer complete

        let mut entries: Vec<FileEntry> = listing.lines().filter_map(parse_list_entry).collect();
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then(b.modified.cmp(&a.modified))
                .then(a.name.cmp(&b.name))
        });
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fetch_thumbnail(
    path: String,
    app: AppHandle,
    state: TauriState<'_, AppState>,
) -> Result<String, String> {
    // Serve from disk cache when available
    let file_name = std::path::Path::new(&path)
        .file_name()
        .ok_or("invalid path")?
        .to_owned();
    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let cache_path = cache_dir.join("thumbnails").join(&file_name);

    if cache_path.exists() {
        let bytes = std::fs::read(&cache_path).map_err(|e| e.to_string())?;
        return Ok(STANDARD.encode(&bytes));
    }

    let (ip, access_code) = {
        let conn = state.connection.lock().await;
        let c = conn.as_ref().ok_or("Not connected")?;
        (c.ip.clone(), c.access_code.clone())
    };
    let ftp_arc = Arc::clone(&state.ftp);

    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut slot = ftp_arc.lock().unwrap();
        let ctrl = ensure_ftp(&mut slot, &ip, &access_code)?;

        let data_addr = ftp_pasv(ctrl, &ip)?;
        ftp_writeln(ctrl, &format!("RETR {}", path))?;

        let data_tcp =
            std::net::TcpStream::connect(data_addr).map_err(|e| format!("Data connect: {}", e))?;
        data_tcp
            .set_read_timeout(Some(std::time::Duration::from_secs(30)))
            .ok();
        let mut data = ftps_tls_stream(&ip, data_tcp)?;

        let (code, msg) = ftp_read_response(ctrl)?;
        if code != 125 && code != 150 {
            return Err(format!("RETR: {} {}", code, msg));
        }

        let mut bytes = Vec::new();
        data.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        drop(data);
        ftp_read_response(ctrl).ok();

        // Persist to cache for future visits
        if let Some(parent) = cache_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&cache_path, &bytes).ok();

        Ok(STANDARD.encode(&bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fetch_print_preview(
    subtask_name: String,
    task_id: String,
    app: AppHandle,
    state: TauriState<'_, AppState>,
) -> Result<String, String> {
    if subtask_name.is_empty() {
        return Err("No active job".to_string());
    }

    // Cache is stored without extension; MIME is detected from magic bytes on read-back.
    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let cache_path = cache_dir.join("previews").join(&subtask_name);
    if cache_path.exists() {
        let bytes = std::fs::read(&cache_path).map_err(|e| e.to_string())?;
        return Ok(format!(
            "data:{};base64,{}",
            detect_mime(&bytes),
            STANDARD.encode(&bytes)
        ));
    }

    let (ip, access_code) = {
        let conn = state.connection.lock().await;
        let c = conn.as_ref().ok_or("Not connected")?;
        (c.ip.clone(), c.access_code.clone())
    };
    let ftp_arc = Arc::clone(&state.ftp);

    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut diag: Vec<String> = Vec::new();
        let mut slot = ftp_arc.lock().unwrap();

        // ── 1. Try /image/ — list the directory and fetch the most recently modified file.
        //       OrcaSlicer uploads the preview image here when sending a print via LAN,
        //       so the newest entry corresponds to the active job.
        //       If task_id is a non-zero cloud ID, also try exact match first.
        {
            // Exact match by task_id (cloud prints only; LAN prints have task_id = "0")
            if !task_id.is_empty() && task_id != "0" {
                let ctrl = ensure_ftp(&mut slot, &ip, &access_code)?;
                for ext in &["png", "jpg", "jpeg"] {
                    let path = format!("/image/{}.{}", task_id, ext);
                    match ftp_try_retr(ctrl, &ip, &path) {
                        Ok(Some(bytes)) => {
                            if let Some(p) = cache_path.parent() {
                                std::fs::create_dir_all(p).ok();
                            }
                            std::fs::write(&cache_path, &bytes).ok();
                            return Ok(format!(
                                "data:{};base64,{}",
                                detect_mime(&bytes),
                                STANDARD.encode(&bytes)
                            ));
                        }
                        Ok(None) => diag.push(format!("{path}: 550")),
                        Err(e) => diag.push(format!("{path}: err({e})")),
                    }
                }
            }

            // List /image/ and pick the newest file
            let newest: Option<String> = {
                let ctrl = ensure_ftp(&mut slot, &ip, &access_code)?;
                let data_addr = ftp_pasv(ctrl, &ip)?;
                ftp_writeln(ctrl, "LIST /image/")?;
                let data_tcp = std::net::TcpStream::connect(data_addr)
                    .map_err(|e| format!("image-list data: {}", e))?;
                data_tcp
                    .set_read_timeout(Some(std::time::Duration::from_secs(15)))
                    .ok();
                let mut data = ftps_tls_stream(&ip, data_tcp)?;
                let (code, _) = ftp_read_response(ctrl)?;
                if code == 125 || code == 150 {
                    let mut listing = String::new();
                    data.read_to_string(&mut listing)
                        .map_err(|e| e.to_string())?;
                    drop(data);
                    ftp_read_response(ctrl).ok();
                    let mut entries: Vec<FileEntry> = listing
                        .lines()
                        .filter_map(parse_list_entry)
                        .filter(|e| !e.is_dir)
                        .collect();
                    entries.sort_by(|a, b| b.modified.cmp(&a.modified));
                    entries.into_iter().next().map(|e| e.name)
                } else {
                    drop(data);
                    diag.push("/image/: LIST failed".to_string());
                    None
                }
            };

            if let Some(ref img_name) = newest {
                let path = format!("/image/{}", img_name);
                let ctrl = ensure_ftp(&mut slot, &ip, &access_code)?;
                match ftp_try_retr(ctrl, &ip, &path) {
                    Ok(Some(bytes)) => {
                        if let Some(p) = cache_path.parent() {
                            std::fs::create_dir_all(p).ok();
                        }
                        std::fs::write(&cache_path, &bytes).ok();
                        return Ok(format!(
                            "data:{};base64,{}",
                            detect_mime(&bytes),
                            STANDARD.encode(&bytes)
                        ));
                    }
                    Ok(None) => diag.push(format!("{path}: 550")),
                    Err(e) => diag.push(format!("{path}: err({e})")),
                }
            }
        }

        // ── 2. Try pre-rendered JPEG/PNG files in /cache/ ────────────────────
        {
            let ctrl = ensure_ftp(&mut slot, &ip, &access_code)?;
            for path in &[
                format!("/cache/{}.jpg", subtask_name),
                format!("/cache/{}.jpeg", subtask_name),
                format!("/cache/{}.png", subtask_name),
            ] {
                match ftp_try_retr(ctrl, &ip, path) {
                    Ok(Some(bytes)) => {
                        if let Some(p) = cache_path.parent() {
                            std::fs::create_dir_all(p).ok();
                        }
                        std::fs::write(&cache_path, &bytes).ok();
                        return Ok(format!(
                            "data:{};base64,{}",
                            detect_mime(&bytes),
                            STANDARD.encode(&bytes)
                        ));
                    }
                    Ok(None) => diag.push(format!("{path}: 550")),
                    Err(e) => diag.push(format!("{path}: err({e})")),
                }
            }
        }

        // ── 3. Extract thumbnail from the gcode file header ───────────────────
        {
            let ctrl = ensure_ftp(&mut slot, &ip, &access_code)?;
            let mut gcode_candidates = vec![format!("/cache/{}.gcode", subtask_name)];
            if let Some(idx) = subtask_name.rfind("_plate_") {
                let suffix = &subtask_name[idx..];
                gcode_candidates.push(format!("/cache/{}{}.gcode", subtask_name, suffix));
            }
            for gcode_path in &gcode_candidates {
                match ftp_read_partial(ctrl, &ip, gcode_path, 2 * 1024 * 1024) {
                    Ok(header) => {
                        let head_str =
                            String::from_utf8_lossy(&header[..header.len().min(300)]).to_string();
                        diag.push(format!(
                            "{gcode_path}: {len}b, head={head_str:?}",
                            len = header.len()
                        ));
                        if let Some(bytes) = parse_gcode_thumbnail(&header) {
                            if let Some(p) = cache_path.parent() {
                                std::fs::create_dir_all(p).ok();
                            }
                            std::fs::write(&cache_path, &bytes).ok();
                            return Ok(format!(
                                "data:{};base64,{}",
                                detect_mime(&bytes),
                                STANDARD.encode(&bytes)
                            ));
                        } else {
                            diag.push("no thumbnail in header".to_string());
                        }
                    }
                    Err(e) => diag.push(format!("{gcode_path}: err({e})")),
                }
            }
        }

        Err(diag.join(" | "))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn download_file(
    path: String,
    app: AppHandle,
    state: TauriState<'_, AppState>,
) -> Result<String, String> {
    let (ip, access_code) = {
        let conn = state.connection.lock().await;
        let c = conn.as_ref().ok_or("Not connected")?;
        (c.ip.clone(), c.access_code.clone())
    };
    let ftp_arc = Arc::clone(&state.ftp);

    let filename = path.split('/').last().unwrap_or("download").to_owned();
    let save_dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&save_dir).ok();
    let save_path = save_dir.join(&filename);

    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut slot = ftp_arc.lock().unwrap();
        let ctrl = ensure_ftp(&mut slot, &ip, &access_code)?;

        let data_addr = ftp_pasv(ctrl, &ip)?;
        ftp_writeln(ctrl, &format!("RETR {}", path))?;

        let data_tcp =
            std::net::TcpStream::connect(data_addr).map_err(|e| format!("Data connect: {}", e))?;
        data_tcp
            .set_read_timeout(Some(std::time::Duration::from_secs(300)))
            .ok();
        let mut data = ftps_tls_stream(&ip, data_tcp)?;

        let (code, msg) = ftp_read_response(ctrl)?;
        if code != 125 && code != 150 {
            return Err(format!("RETR: {} {}", code, msg));
        }

        let mut bytes = Vec::new();
        data.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        drop(data);
        ftp_read_response(ctrl).ok();

        std::fs::write(&save_path, &bytes).map_err(|e| e.to_string())?;
        Ok(filename)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_file(path: String, state: TauriState<'_, AppState>) -> Result<(), String> {
    let (ip, access_code) = {
        let conn = state.connection.lock().await;
        let c = conn.as_ref().ok_or("Not connected")?;
        (c.ip.clone(), c.access_code.clone())
    };
    let ftp_arc = Arc::clone(&state.ftp);

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut slot = ftp_arc.lock().unwrap();
        let ctrl = ensure_ftp(&mut slot, &ip, &access_code)?;
        ftp_writeln(ctrl, &format!("DELE {}", path))?;
        let (code, msg) = ftp_read_response(ctrl)?;
        if code != 250 {
            return Err(format!("Delete failed: {} {}", code, msg));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Recursively deletes a file or directory over the existing FTPS control connection.
fn ftp_delete_recursive(ctrl: &mut FtpsStream, ip: &str, path: &str) -> Result<(), String> {
    ftp_writeln(ctrl, &format!("DELE {}", path))?;
    let (code, _) = ftp_read_response(ctrl)?;
    if code == 250 {
        return Ok(());
    }

    // Not a plain file — treat as directory: list, recurse, then RMD
    let data_addr = ftp_pasv(ctrl, ip)?;
    ftp_writeln(ctrl, &format!("LIST {}", path))?;

    let data_tcp =
        std::net::TcpStream::connect(data_addr).map_err(|e| format!("Data connect: {}", e))?;
    data_tcp
        .set_read_timeout(Some(std::time::Duration::from_secs(30)))
        .ok();
    let mut data = ftps_tls_stream(ip, data_tcp)?;

    let (code, msg) = ftp_read_response(ctrl)?;
    if code != 125 && code != 150 {
        return Err(format!("LIST error: {} {}", code, msg));
    }

    let mut listing = String::new();
    data.read_to_string(&mut listing)
        .map_err(|e| e.to_string())?;
    drop(data);
    ftp_read_response(ctrl).ok();

    let base = path.trim_end_matches('/');
    let children: Vec<String> = listing
        .lines()
        .filter_map(parse_list_entry)
        .map(|e| format!("{}/{}", base, e.name))
        .collect();

    for child in children {
        ftp_delete_recursive(ctrl, ip, &child)?;
    }

    ftp_writeln(ctrl, &format!("RMD {}", path))?;
    let (code, msg) = ftp_read_response(ctrl)?;
    if code != 250 {
        return Err(format!("RMD failed: {} {}", code, msg));
    }
    Ok(())
}

#[tauri::command]
async fn delete_entry(path: String, state: TauriState<'_, AppState>) -> Result<(), String> {
    let (ip, access_code) = {
        let conn = state.connection.lock().await;
        let c = conn.as_ref().ok_or("Not connected")?;
        (c.ip.clone(), c.access_code.clone())
    };
    let ftp_arc = Arc::clone(&state.ftp);

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut slot = ftp_arc.lock().unwrap();
        let ctrl = ensure_ftp(&mut slot, &ip, &access_code)?;
        ftp_delete_recursive(ctrl, &ip, &path)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Filament load / unload ────────────────────────────────────────────────────
//
// Protocol source: OrcaSlicer DeviceManager.cpp `command_ams_change_filament`.
//
// Both load and unload use the same MQTT command `ams_change_filament`.
// Unload is signalled by target=255 and slot_id=255 ("new protocol").
//
// Field names (different from what might be guessed):
//   ams_id   – AMS unit index (0-3), or 255 for VT/external/none
//   target   – global tray ID (unit*4+slot), or 255 for unload
//   slot_id  – per-unit slot (0-3), or 255 for unload
//   curr_temp – nozzle temp of the filament being unloaded
//   tar_temp  – nozzle temp of the filament being loaded
// OrcaSlicer defaults both temps to 210 when unspecified.

// Returns the print temperature for any global slot ID.
fn tray_temperature(status: &PrinterStatus, global_id: u8) -> u16 {
    match global_id {
        254 => status.vt_tray.as_ref().map(|t| t.tray_temp).unwrap_or(210),
        255 => 210, // nothing loaded — OrcaSlicer default
        id => {
            let unit_id = id / 4;
            let slot_id = id % 4;
            status
                .ams
                .iter()
                .find(|u| u.id == unit_id)
                .and_then(|u| u.trays.iter().find(|t| t.id == slot_id))
                .map(|t| t.tray_temp)
                .unwrap_or(210)
        }
    }
}

#[tauri::command]
async fn load_filament(tray_id: u8, state: TauriState<'_, AppState>) -> Result<(), String> {
    // Capture everything while holding locks, then drop before async publish
    // so we never hold a Mutex across an await point.
    let (mqtt_client, topic, payload) = {
        let conn = state.connection.lock().await;
        let c = conn.as_ref().ok_or("Not connected")?;
        let status = c.status.lock().await;

        let curr_tray = status.tray_now;
        let curr_temp = tray_temperature(&status, curr_tray);
        let tar_temp  = tray_temperature(&status, tray_id);

        // Decompose global tray_id into the three fields OrcaSlicer sends.
        // VT tray (254): OrcaSlicer maps ams_id 254→255, leaving target=255, slot_id=0.
        let (ams_id, target, slot_id): (u8, u8, u8) = if tray_id == 254 {
            (255, 255, 0)
        } else {
            let unit = tray_id / 4;
            let slot = tray_id % 4;
            (unit, tray_id, slot)
        };

        let topic   = format!("device/{}/request", c.serial);
        let payload = serde_json::json!({
            "print": {
                "sequence_id": "0",
                "command":     "ams_change_filament",
                "curr_temp":   curr_temp,
                "tar_temp":    tar_temp,
                "ams_id":      ams_id,
                "target":      target,
                "slot_id":     slot_id
            }
        });
        (c.mqtt_client.clone(), topic, payload)
    }; // connection + status locks dropped here

    mqtt_client
        .publish(&topic, QoS::AtLeastOnce, false, payload.to_string())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn unload_filament(state: TauriState<'_, AppState>) -> Result<(), String> {
    let (mqtt_client, topic, payload) = {
        let conn = state.connection.lock().await;
        let c = conn.as_ref().ok_or("Not connected")?;
        let status = c.status.lock().await;

        let curr_tray = status.tray_now;
        let curr_temp = tray_temperature(&status, curr_tray);
        // ams_id for unload = the unit that is currently loaded, or 255 if none.
        let ams_id: u8 = if curr_tray == 255 || curr_tray == 254 {
            255
        } else {
            curr_tray / 4
        };

        let topic   = format!("device/{}/request", c.serial);
        // Unload: target=255 slot_id=255 ("new protocol to mark unload" per OrcaSlicer).
        let payload = serde_json::json!({
            "print": {
                "sequence_id": "0",
                "command":     "ams_change_filament",
                "curr_temp":   curr_temp,
                "tar_temp":    curr_temp,
                "ams_id":      ams_id,
                "target":      255,
                "slot_id":     255
            }
        });
        (c.mqtt_client.clone(), topic, payload)
    }; // locks dropped here

    mqtt_client
        .publish(&topic, QoS::AtLeastOnce, false, payload.to_string())
        .await
        .map_err(|e| e.to_string())
}

// ── Print from SD card ────────────────────────────────────────────────────────
//
// Protocol source: OrcaSlicer DeviceManager.cpp + OpenBambuAPI/mqtt.md +
// community MQTT captures.
//
// Key points verified against OrcaSlicer source:
//  • `url`  — must use three slashes with NO host: "ftp:///cache/file.gcode.3mf"
//             (the printer resolves the path locally; "ftp://ip/path" is rejected).
//  • `param` — for 3MF files: internal path inside the ZIP archive, always
//              "Metadata/plate_1.gcode" for single-plate prints.
//              For plain .gcode files: the FTP path itself.
//  • `project_id`, `subtask_id`, `file`, `md5` — required by firmware; all "0"/"".
//  • QoS 1 (AtLeastOnce) — same as other critical print-control commands.
//  • Lock must NOT be held across the async publish (clone mqtt_client first).

#[tauri::command]
async fn start_print(
    path: String,
    bed_leveling: bool,
    flow_cali: bool,
    timelapse: bool,
    use_ams: bool,
    state: TauriState<'_, AppState>,
) -> Result<(), String> {
    let (mqtt_client, topic, payload) = {
        let conn = state.connection.lock().await;
        let c = conn.as_ref().ok_or("Not connected")?;

        let filename = path.split('/').last().unwrap_or(&path).to_owned();
        let lower = filename.to_lowercase();
        let is_3mf = lower.ends_with(".gcode.3mf");

        // Strip known suffixes to get a clean display name.
        let subtask_name = if lower.ends_with(".gcode.3mf") {
            filename[..filename.len() - ".gcode.3mf".len()].to_owned()
        } else if lower.ends_with(".gcode") {
            filename[..filename.len() - ".gcode".len()].to_owned()
        } else {
            filename.clone()
        };

        // `param` is the path *inside* the 3MF ZIP archive — only meaningful
        // for .gcode.3mf files. For plain .gcode files it must be an empty
        // string: sending the FTP path here causes the firmware to try to
        // extract that path from the file as if it were a ZIP, which fails
        // immediately with error 05004003 "unable to parse the file".
        let param = if is_3mf {
            "Metadata/plate_1.gcode".to_owned()
        } else {
            String::new()
        };

        // `url` must use the file:// scheme pointing at the printer's SD card
        // mount path. The FTP root maps to /sdcard/ on the printer's filesystem,
        // so FTP path "/cache/file.gcode.3mf" → "file:///sdcard/cache/file.gcode.3mf".
        // This is the exact format the official Bambu app uses for SD-card prints.
        // Using ftp:///path instead routes through the printer's internal FTP server
        // and triggers spurious "MicroSD Card read/write exception" HMS alerts.
        let url = format!("file:///sdcard{}", path);

        let topic = format!("device/{}/request", c.serial);
        let payload = serde_json::json!({
            "print": {
                "sequence_id": "0",
                "command":      "project_file",
                "param":        param,
                "url":          url,
                "file":         "",
                "md5":          "",
                "project_id":   "0",
                "profile_id":   "0",
                "task_id":      "0",
                "subtask_id":   "0",
                "subtask_name": subtask_name,
                "timelapse":    timelapse,
                "bed_type":     "auto",
                "bed_leveling": bed_leveling,
                "flow_cali":    flow_cali,
                "vibration_cali": true,
                "layer_inspect":  false,
                "use_ams":      use_ams
            }
        });
        (c.mqtt_client.clone(), topic, payload)
    }; // connection lock dropped here — never hold it across an async await

    mqtt_client
        .publish(&topic, QoS::AtLeastOnce, false, payload.to_string())
        .await
        .map_err(|e| e.to_string())
}

// ── Debug helpers ─────────────────────────────────────────────────────────────

#[tauri::command]
async fn debug_send_request(
    payload: String,
    state: TauriState<'_, AppState>,
) -> Result<(), String> {
    let conn = state.connection.lock().await;
    let c = conn.as_ref().ok_or("Not connected")?;
    let topic = format!("device/{}/request", c.serial);
    c.mqtt_client
        .publish(&topic, QoS::AtMostOnce, false, payload)
        .await
        .map_err(|e| e.to_string())
}

// ── Dev-only helpers ──────────────────────────────────────────────────────────

#[tauri::command]
async fn inject_test_hms(
    code: String,
    app: AppHandle,
    state: TauriState<'_, AppState>,
) -> Result<(), String> {
    let arc = {
        let conn = state.connection.lock().await;
        conn.as_ref().map(|c| c.status.clone())
    };
    if let Some(arc) = arc {
        let mut st = arc.lock().await.clone();
        st.hms = if code.is_empty() { vec![] } else { vec![code] };
        let _ = app.emit("printer-status", st);
    }
    Ok(())
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {
        }))
        .plugin(tauri_plugin_deep_link::init())    
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            connection: Mutex::new(None),
            ftp: Arc::new(std::sync::Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            connect_printer,
            disconnect_printer,
            get_status,
            printer_command,
            set_chamber_light,
            set_print_speed,
            send_gcode,
            list_files,
            delete_file,
            delete_entry,
            fetch_thumbnail,
            fetch_print_preview,
            download_file,
            inject_test_hms,
            debug_send_request,
            start_print,
            load_filament,
            unload_filament,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
