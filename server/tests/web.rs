//! Agent entry points and static web assets.

mod common;

use common::TestServer;
use reqwest::StatusCode;

const CHROME: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const BROWSER_ACCEPT: &str = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8";

fn expected_markdown(cli: &str) -> String {
    include_str!("../src/instructions.md").replace("{cli}", cli)
}

#[tokio::test]
async fn room_link_gives_agents_markdown() {
    let s = TestServer::start().await;
    let cli = format!("npx -y agents-room@{}", env!("CARGO_PKG_VERSION"));
    let res = s.http.get(s.url("/r")).header("User-Agent", "curl/8.5.0").header("Accept", "*/*").send().await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(res.headers()["content-type"].to_str().unwrap().starts_with("text/markdown"));
    assert!(res.headers()["vary"].to_str().unwrap().contains("User-Agent"));
    let body = res.text().await.unwrap();
    assert_eq!(body, expected_markdown(&cli));
    assert!(body.contains(&format!("    {cli} join '<the full link>'")));
    assert!(body.contains(&format!("`{cli} install claude-code`")));

    for (ua, accept) in [
        ("python-requests/2.32.3", "*/*"),
        ("node", "*/*"),
        ("Go-http-client/1.1", ""),
        ("claude-code/2.0", "text/html"),
        (CHROME, "text/markdown, text/html;q=0.9"),
        (CHROME, "text/plain"),
    ] {
        let mut req = s.http.get(s.url("/r")).header("User-Agent", ua);
        if !accept.is_empty() {
            req = req.header("Accept", accept);
        }
        let res = req.send().await.unwrap();
        let ct = res.headers()["content-type"].to_str().unwrap().to_owned();
        assert!(ct.starts_with("text/markdown"), "{ua} / {accept}: {ct}");
    }
}

#[tokio::test]
async fn room_link_gives_browsers_the_web_app() {
    let s = TestServer::start().await;
    let res =
        s.http.get(s.url("/r")).header("User-Agent", CHROME).header("Accept", BROWSER_ACCEPT).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["content-type"], "text/html; charset=utf-8");
    assert_eq!(res.headers()["cache-control"], "no-cache");
    assert_eq!(res.headers()["referrer-policy"], "no-referrer");
    assert_eq!(res.headers()["x-frame-options"], "DENY");
    let html = res.text().await.unwrap();
    assert!(html.to_ascii_lowercase().contains("<html"), "{html}");

    let index = s.http.get(s.url("/")).header("User-Agent", CHROME).send().await.unwrap();
    assert_eq!(index.status(), StatusCode::OK);
    let etag = index.headers()["etag"].to_str().unwrap().to_owned();
    assert_eq!(index.text().await.unwrap(), html);
    let cached = s.http.get(s.url("/")).header("If-None-Match", &etag).send().await.unwrap();
    assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
}

#[tokio::test]
async fn llms_txt_serves_the_instructions() {
    let s = TestServer::with(|c| {
        c.cli_command = "lincor".into();
        c.public_url = Some("https://chat.example.com".into());
    })
    .await;
    let res = s
        .http
        .get(s.url("/llms.txt"))
        .header("User-Agent", CHROME)
        .header("Accept", BROWSER_ACCEPT)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(res.headers()["content-type"].to_str().unwrap().starts_with("text/plain"));
    let body = res.text().await.unwrap();
    assert!(body.starts_with("# Agents secure chat: room link\n"));
    assert!(body.contains("    lincor join '<the full link>'"));
    assert!(body.contains("Room links on this server look like `https://chat.example.com/r#<key>`."));
    let r = s.http.get(s.url("/r")).header("User-Agent", "curl/8").send().await.unwrap().text().await.unwrap();
    assert_eq!(r, body);
}

#[tokio::test]
async fn static_files_and_missing_paths() {
    let s = TestServer::start().await;
    assert_eq!(s.http.get(s.url("/no/such/file.js")).send().await.unwrap().status(), StatusCode::NOT_FOUND);
    assert_eq!(s.http.get(s.url("/.env")).send().await.unwrap().status(), StatusCode::NOT_FOUND);
    assert_eq!(s.http.get(s.url("/%2e%2e/Cargo.toml")).send().await.unwrap().status(), StatusCode::NOT_FOUND);
    assert_eq!(s.http.post(s.url("/r")).send().await.unwrap().status(), StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn web_dir_overrides_embedded_assets() {
    let web = tempfile::tempdir().unwrap();
    std::fs::write(web.path().join("index.html"), "<!doctype html><html><body>dev build</body></html>").unwrap();
    std::fs::create_dir(web.path().join("assets")).unwrap();
    std::fs::write(web.path().join("assets/app-1A2B3C4D.js"), "console.log(1)").unwrap();
    let dir = web.path().to_owned();
    let s = TestServer::with(move |c| c.web_dir = Some(dir)).await;
    let res = s.http.get(s.url("/")).send().await.unwrap();
    assert_eq!(res.text().await.unwrap(), "<!doctype html><html><body>dev build</body></html>");
    let res =
        s.http.get(s.url("/r")).header("User-Agent", CHROME).header("Accept", BROWSER_ACCEPT).send().await.unwrap();
    assert!(res.text().await.unwrap().contains("dev build"));
    let res = s.http.get(s.url("/assets/app-1A2B3C4D.js")).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(res.headers()["content-type"].to_str().unwrap().contains("javascript"));
    assert_eq!(res.headers()["cache-control"], "no-cache");
    assert_eq!(res.text().await.unwrap(), "console.log(1)");
}
