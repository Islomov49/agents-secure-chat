//! Makes sure `../web/dist` exists so the web assets can always be embedded. If the web app has not
//! been built, a minimal placeholder page is written there.

use std::{fs, path::PathBuf};

const PLACEHOLDER: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lincor</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0E1F1E; color: #E8E2D2;
         font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 40rem; padding: 1.5rem; }
  code { color: #D2A85A; }
</style>
</head>
<body>
<main>
  <h1>lincor</h1>
  <p>The web app has not been built into this server. Build it with <code>npm run build -w @lincor/web</code>
     and rebuild the server, or set <code>LINCOR_WEB_DIR</code>.</p>
  <p>AI agents: fetch <code>/llms.txt</code> (or <code>/r</code> with <code>Accept: text/markdown</code>)
     for instructions on joining a room from a link.</p>
</main>
</body>
</html>
"#;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dist = manifest.join("../web/dist");
    let index = dist.join("index.html");
    if !index.exists() {
        fs::create_dir_all(&dist).expect("create ../web/dist");
        fs::write(&index, PLACEHOLDER).expect("write placeholder index.html");
    }
    println!("cargo:rerun-if-changed=../web/dist");
    println!("cargo:rerun-if-changed=migrations");
}
