//! Web app assets and the agent entry points `/r` and `/llms.txt` (PROTOCOL §8).

use std::borrow::Cow;

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use rust_embed::RustEmbed;
use sha2::{Digest, Sha256};
use tower_http::compression::CompressionLayer;

use crate::{error::ApiError, state::AppState};

/// The built web app (`web/dist`); `build.rs` puts a placeholder there when it has not been built.
#[derive(RustEmbed)]
#[folder = "../web/dist"]
struct Assets;

const INSTRUCTIONS: &str = include_str!("instructions.md");

/// The agent instructions with the server's CLI command filled in.
pub fn instructions(cli_command: &str, public_url: Option<&str>) -> String {
    let text = INSTRUCTIONS.replace("{cli}", cli_command);
    match public_url {
        Some(url) => text.replacen(
            "\n\n## Join",
            &format!("\n\nRoom links on this server look like `{url}/r#<key>`.\n\n## Join"),
            1,
        ),
        None => text,
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(index))
        .route("/r", get(room_link))
        .route("/llms.txt", get(llms_txt))
        .route("/healthz", get(healthz))
        .fallback(fallback)
        .layer(CompressionLayer::new())
}

async fn index(State(state): State<AppState>, headers: HeaderMap) -> Response {
    asset(&state, "index.html", &headers).await
}

/// `GET /r`: the web app for browsers, markdown instructions for agents.
async fn room_link(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let mut res = if wants_markdown(&headers) {
        text(&state.instructions, "text/markdown; charset=utf-8")
    } else {
        asset(&state, "index.html", &headers).await
    };
    res.headers_mut().insert(header::VARY, HeaderValue::from_static("Accept, User-Agent"));
    res
}

async fn llms_txt(State(state): State<AppState>) -> Response {
    text(&state.instructions, "text/plain; charset=utf-8")
}

async fn healthz() -> &'static str {
    "ok"
}

async fn fallback(State(state): State<AppState>, method: Method, uri: Uri, headers: HeaderMap) -> Response {
    let path = uri.path();
    if path == "/api" || path.starts_with("/api/") {
        return ApiError::not_found("no such API endpoint").into_response();
    }
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    match asset_path(path) {
        Some(p) => asset(&state, &p, &headers).await,
        None => not_found(),
    }
}

fn text(body: &str, content_type: &'static str) -> Response {
    ([(header::CONTENT_TYPE, content_type), (header::CACHE_CONTROL, "no-cache")], body.to_owned()).into_response()
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, [(header::CACHE_CONTROL, "no-cache")], "not found").into_response()
}

/// Maps a URL path to an asset path, rejecting anything that could escape the asset root.
fn asset_path(path: &str) -> Option<String> {
    let path = path.trim_start_matches('/');
    let ok = !path.is_empty()
        && !path.contains('\\')
        && path.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != ".." && !seg.starts_with('.'));
    ok.then(|| path.to_owned())
}

/// True for file names carrying a content hash (`app-3F2A1C9B.js`), which can be cached forever.
fn is_hashed(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    stem.split(['-', '.', '_']).any(|seg| {
        seg.len() >= 8 && seg.bytes().all(|b| b.is_ascii_alphanumeric()) && seg.bytes().any(|b| b.is_ascii_digit())
    })
}

fn cache_control(path: &str, dev: bool) -> &'static str {
    if dev || path.ends_with(".html") {
        "no-cache"
    } else if is_hashed(path) {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=3600"
    }
}

fn content_type(path: &str) -> String {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let textual = mime.type_() == mime_guess::mime::TEXT
        || matches!(mime.subtype().as_str(), "javascript" | "json" | "manifest+json" | "xml" | "svg");
    if textual { format!("{mime}; charset=utf-8") } else { mime.to_string() }
}

async fn asset(state: &AppState, path: &str, headers: &HeaderMap) -> Response {
    let dev = state.config.web_dir.is_some();
    let (bytes, etag): (Cow<'static, [u8]>, Option<String>) = match &state.config.web_dir {
        Some(dir) => match tokio::fs::read(dir.join(path)).await {
            Ok(b) => (Cow::Owned(b), None),
            Err(_) => return not_found(),
        },
        None => match Assets::get(path) {
            Some(f) => {
                let tag = format!("\"{}\"", hex::encode(&f.metadata.sha256_hash()[..16]));
                (f.data, Some(tag))
            }
            None => return not_found(),
        },
    };
    let (bytes, etag) = if path == "index.html" {
        // The static agent block shows this server's configured CLI command.
        let page = with_cli_command(&bytes, &state.config.cli_command);
        let tag = etag.map(|t| format!("\"{}\"", hex::encode(&Sha256::digest(format!("{t}{}", state.config.cli_command))[..16])));
        (Cow::Owned(page), tag)
    } else {
        (bytes, etag)
    };
    let cache = cache_control(path, dev);
    if let Some(tag) = &etag
        && headers
            .get(header::IF_NONE_MATCH)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.split(',').any(|t| t.trim() == tag || t.trim() == "*"))
    {
        return (StatusCode::NOT_MODIFIED, [(header::ETAG, tag.as_str()), (header::CACHE_CONTROL, cache)])
            .into_response();
    }
    let mut res = Response::new(Body::from(bytes));
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(&content_type(path)).expect("valid mime"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    if path.ends_with(".html") {
        // The page holds a room key in memory: no framing, no referrer.
        h.insert("x-frame-options", HeaderValue::from_static("DENY"));
        h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    }
    if let Some(tag) = etag {
        h.insert(header::ETAG, HeaderValue::from_str(&tag).expect("hex etag"));
    }
    res
}

/// Replaces the contents of `<span id="agentCli">…</span>` in the web app's HTML with `cli` (HTML-escaped).
fn with_cli_command(html: &[u8], cli: &str) -> Vec<u8> {
    const OPEN: &str = "<span id=\"agentCli\">";
    let Ok(text) = std::str::from_utf8(html) else { return html.to_vec() };
    let Some(start) = text.find(OPEN).map(|i| i + OPEN.len()) else { return html.to_vec() };
    let Some(len) = text[start..].find("</span>") else { return html.to_vec() };
    let escaped = cli.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
    format!("{}{}{}", &text[..start], escaped, &text[start + len..]).into_bytes()
}

/// One media range of an `Accept` header.
struct MediaRange {
    range: String,
    q: f32,
}

fn parse_accept(accept: &str) -> Vec<MediaRange> {
    accept
        .split(',')
        .filter_map(|part| {
            let mut params = part.split(';');
            let range = params.next()?.trim().to_ascii_lowercase();
            if range.is_empty() {
                return None;
            }
            let q = params
                .filter_map(|p| p.trim().strip_prefix("q="))
                .find_map(|v| v.trim().parse::<f32>().ok())
                .unwrap_or(1.0);
            Some(MediaRange { range, q })
        })
        .collect()
}

/// Quality for `mime` from its most specific matching range (exact > `type/*` > `*/*`).
fn quality(ranges: &[MediaRange], mime: &str) -> f32 {
    let wildcard = format!("{}/*", mime.split('/').next().unwrap_or(""));
    ranges
        .iter()
        .filter_map(|r| {
            let specificity = if r.range == mime {
                3
            } else if r.range == wildcard {
                2
            } else if r.range == "*/*" {
                1
            } else {
                return None;
            };
            Some((specificity, r.q))
        })
        .max_by_key(|(specificity, _)| *specificity)
        .map_or(0.0, |(_, q)| q)
}

/// Markdown when `Accept` prefers `text/markdown`/`text/plain` over HTML, or when the client is not
/// a browser (a browser is a `Mozilla` User-Agent that accepts `text/html`).
pub fn wants_markdown(headers: &HeaderMap) -> bool {
    let get = |name| headers.get(name).and_then(|v: &HeaderValue| v.to_str().ok()).unwrap_or("");
    let accept = get(header::ACCEPT);
    let ua = get(header::USER_AGENT);
    let ranges = parse_accept(accept);
    let named = |mime: &str| ranges.iter().any(|r| r.range == mime && r.q > 0.0);
    let text_q = quality(&ranges, "text/markdown").max(quality(&ranges, "text/plain"));
    if (named("text/markdown") || named("text/plain")) && text_q >= quality(&ranges, "text/html") {
        return true;
    }
    let browser = ua.contains("Mozilla") && ranges.iter().any(|r| r.range == "text/html");
    !browser
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(accept: Option<&str>, ua: Option<&str>) -> HeaderMap {
        let mut m = HeaderMap::new();
        if let Some(a) = accept {
            m.insert(header::ACCEPT, a.parse().unwrap());
        }
        if let Some(u) = ua {
            m.insert(header::USER_AGENT, u.parse().unwrap());
        }
        m
    }

    const CHROME: &str =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
    const BROWSER_ACCEPT: &str = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

    #[test]
    fn negotiation() {
        assert!(!wants_markdown(&h(Some(BROWSER_ACCEPT), Some(CHROME))));
        assert!(wants_markdown(&h(Some("*/*"), Some("curl/8.5.0"))));
        assert!(wants_markdown(&h(None, Some("curl/8.5.0"))));
        assert!(wants_markdown(&h(None, None)));
        assert!(wants_markdown(&h(Some("text/html"), Some("python-requests/2.32"))));
        assert!(wants_markdown(&h(Some("*/*"), Some(CHROME))), "Mozilla without text/html is not a browser");
        assert!(wants_markdown(&h(Some("text/markdown, text/html;q=0.9"), Some(CHROME))));
        assert!(wants_markdown(&h(Some("text/plain"), Some(CHROME))));
        assert!(!wants_markdown(&h(Some("text/html, text/plain;q=0.5"), Some(CHROME))));
        assert!(wants_markdown(&h(Some("text/markdown, text/html, */*"), Some("Claude-User"))));
    }

    #[test]
    fn cli_command_in_html() {
        let html = b"<pre><span id=\"agentCli\">npx -y agents-room@0.1.0</span> join</pre>";
        let out = String::from_utf8(with_cli_command(html, "node /opt/a&b/lincor.js")).unwrap();
        assert_eq!(out, "<pre><span id=\"agentCli\">node /opt/a&amp;b/lincor.js</span> join</pre>");
        assert_eq!(with_cli_command(b"<p>no span</p>", "x"), b"<p>no span</p>");
    }

    #[test]
    fn instructions_text() {
        let t = instructions("npx -y agents-room@1.2.3", None);
        assert!(t.starts_with("# Agents secure chat: room link\n"));
        assert!(t.contains("    npx -y agents-room@1.2.3 join '<the full link>'"));
        assert!(t.contains("`npx -y agents-room@1.2.3 install codex`"));
        assert!(!t.contains("{cli}"));
        let t = instructions("lincor", Some("https://agents-room.cc"));
        assert!(t.contains("Room links on this server look like `https://agents-room.cc/r#<key>`.\n\n## Join"));
    }

    #[test]
    fn paths_and_caching() {
        assert_eq!(asset_path("/assets/app.js").as_deref(), Some("assets/app.js"));
        assert!(asset_path("/../etc/passwd").is_none());
        assert!(asset_path("/a/./b").is_none());
        assert!(asset_path("/.env").is_none());
        assert!(asset_path("/").is_none());
        assert!(is_hashed("assets/app-3F2A1C9B.js"));
        assert!(is_hashed("chunk.abc12345.css"));
        assert!(!is_hashed("fonts/MartianMono-Regular.woff2"));
        assert_eq!(cache_control("index.html", false), "no-cache");
        assert_eq!(cache_control("app.js", true), "no-cache");
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("a.png"), "image/png");
    }
}
