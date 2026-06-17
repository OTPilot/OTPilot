//! Domain favicon pipeline.
//!
//! `POST /icons/resolve` takes a list of domains (with optional same-domain icon
//! URL hints from the extension) and returns, per domain, the public CDN URL of a
//! normalized 64×64 PNG favicon — fetching + storing it on first request and
//! caching the result (including a negative `none` result) in `domain_icons`.
//!
//! The image is fetched and re-encoded **server-side** (never trusting client
//! bytes) so the single per-domain object in the shared bucket can't be poisoned.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::time::Duration;

use axum::{extract::State, routing::post, Json, Router};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tokio::sync::Semaphore;

use crate::{error::Result, AppState};

/// Re-fetch a domain's icon at most this often.
const REFRESH_AFTER_DAYS: i64 = 30;
/// Cap on bytes downloaded for an icon or a homepage HTML scan.
const MAX_DOWNLOAD: usize = 512 * 1024;
/// Edge size of the normalized PNG.
const ICON_SIZE: u32 = 64;
/// Max concurrent outbound favicon fetches across all requests — the endpoint is
/// public, so this bounds resource use under a flood of cache-miss domains.
const MAX_CONCURRENT_FETCHES: usize = 8;

// ── S3/R2 store ──────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct IconStore {
    bucket: Arc<s3::Bucket>,
    public_base: String,
    fetch_sem: Arc<Semaphore>,
}

impl IconStore {
    /// Builds the store from S3_* env vars. Returns None (feature disabled) if any
    /// required var is missing or the bucket can't be initialized.
    pub fn from_env() -> Option<Self> {
        let endpoint = std::env::var("S3_ENDPOINT").ok()?;
        let bucket_name = std::env::var("S3_BUCKET").ok()?;
        let access = std::env::var("S3_ACCESS_KEY_ID").ok()?;
        let secret = std::env::var("S3_SECRET_ACCESS_KEY").ok()?;
        let public_base = std::env::var("S3_PUBLIC_BASE_URL").ok()?;
        let region_name = std::env::var("S3_REGION").unwrap_or_else(|_| "auto".into());

        let region = s3::Region::Custom { region: region_name, endpoint };
        let creds = match s3::creds::Credentials::new(Some(&access), Some(&secret), None, None, None)
        {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("icons: invalid S3 credentials: {e}");
                return None;
            }
        };
        match s3::Bucket::new(&bucket_name, region, creds) {
            Ok(b) => {
                tracing::info!("icons: S3/R2 storage enabled (bucket={bucket_name})");
                Some(Self {
                    bucket: Arc::from(b.with_path_style()),
                    public_base: public_base.trim_end_matches('/').to_string(),
                    fetch_sem: Arc::new(Semaphore::new(MAX_CONCURRENT_FETCHES)),
                })
            }
            Err(e) => {
                tracing::warn!("icons: failed to init S3 bucket: {e}");
                None
            }
        }
    }

    fn public_url(&self, domain: &str) -> String {
        format!("{}/icons/{}.png", self.public_base, domain)
    }

    async fn put_png(&self, domain: &str, png: &[u8]) -> anyhow::Result<()> {
        let path = format!("/icons/{domain}.png");
        let resp = self
            .bucket
            .put_object_with_content_type(&path, png, "image/png")
            .await
            .map_err(|e| anyhow::anyhow!("s3 put failed: {e}"))?;
        // rust-s3 does NOT error on a non-2xx response without `fail-on-err`,
        // so check the status explicitly or we'd cache a non-existent object.
        let code = resp.status_code();
        if !(200..300).contains(&code) {
            return Err(anyhow::anyhow!(
                "s3 put returned HTTP {code}: {}",
                String::from_utf8_lossy(resp.bytes())
            ));
        }
        Ok(())
    }
}

// ── Router ───────────────────────────────────────────────────────────────────

pub fn router() -> Router<AppState> {
    Router::new().route("/icons/resolve", post(resolve))
}

#[derive(Deserialize)]
struct ResolveRequest {
    domains: Vec<String>,
    /// Optional per-domain icon URL discovered by the extension on the page.
    #[serde(default)]
    hints: HashMap<String, String>,
}

#[derive(sqlx::FromRow)]
struct IconRow {
    status: String,
    fresh: bool,
}

// Public (no auth) so free / not-signed-in users get icons too. Abuse is bounded
// by the SSRF guards, the per-request domain cap, negative caching, and the
// global fetch semaphore.
async fn resolve(
    State(state): State<AppState>,
    Json(body): Json<ResolveRequest>,
) -> Result<Json<Value>> {
    let mut out = Map::new();

    // Feature disabled → report every domain as having no icon.
    let Some(store) = state.icons.clone() else {
        for d in &body.domains {
            out.insert(d.clone(), json!({ "status": "none" }));
        }
        return Ok(Json(Value::Object(out)));
    };

    let client = reqwest::Client::builder()
        .user_agent("OTPilot-IconFetcher/1.0")
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| anyhow::anyhow!("client build: {e}"))?;

    // Cap how many domains a single call can trigger fetches for.
    for raw in body.domains.iter().take(50) {
        let Some(domain) = normalize_domain(raw) else {
            out.insert(raw.clone(), json!({ "status": "none" }));
            continue;
        };

        // Cache hit (and still fresh) → return immediately.
        if let Some(row) = sqlx::query_as::<_, IconRow>(
            "SELECT status, (fetched_at > now() - ($2 || ' days')::interval) AS fresh
             FROM domain_icons WHERE domain = $1",
        )
        .bind(&domain)
        .bind(REFRESH_AFTER_DAYS.to_string())
        .fetch_optional(&state.db)
        .await?
        {
            if row.fresh {
                out.insert(raw.clone(), result_for(&store, &domain, &row.status));
                continue;
            }
        }

        // Miss or stale → fetch, normalize, store. The permit bounds how many
        // outbound favicon fetches run concurrently across all callers.
        let _permit = store.fetch_sem.clone().acquire_owned().await.ok();
        let hint = body.hints.get(raw).or_else(|| body.hints.get(&domain));
        let status = match fetch_and_store(&client, &store, &domain, hint.map(String::as_str)).await
        {
            Ok(true) => "ok",
            Ok(false) => "none",
            Err(e) => {
                tracing::warn!("icons: fetch failed for {domain}: {e}");
                // Leave the cache untouched and let the client retry next time.
                out.insert(raw.clone(), json!({ "status": "pending" }));
                continue;
            }
        };
        upsert_icon(&state.db, &domain, status).await?;
        out.insert(raw.clone(), result_for(&store, &domain, status));
    }

    Ok(Json(Value::Object(out)))
}

fn result_for(store: &IconStore, domain: &str, status: &str) -> Value {
    if status == "ok" {
        json!({ "status": "ok", "url": store.public_url(domain) })
    } else {
        json!({ "status": "none" })
    }
}

async fn upsert_icon(db: &sqlx::PgPool, domain: &str, status: &str) -> Result<()> {
    let storage_key = (status == "ok").then(|| format!("icons/{domain}.png"));
    sqlx::query(
        r#"
        INSERT INTO domain_icons (domain, status, storage_key, content_type, fetched_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (domain) DO UPDATE
        SET status = EXCLUDED.status, storage_key = EXCLUDED.storage_key,
            content_type = EXCLUDED.content_type, fetched_at = NOW(), updated_at = NOW()
        "#,
    )
    .bind(domain)
    .bind(status)
    .bind(storage_key)
    .bind((status == "ok").then_some("image/png"))
    .execute(db)
    .await?;
    Ok(())
}

// ── Fetch + normalize ────────────────────────────────────────────────────────

/// Returns Ok(true) if a usable icon was stored, Ok(false) if none was found.
/// Err only on transient/unexpected failures (so the caller marks it `pending`).
async fn fetch_and_store(
    client: &reqwest::Client,
    store: &IconStore,
    domain: &str,
    hint: Option<&str>,
) -> anyhow::Result<bool> {
    // 1) The exact account host (using the page's hint when present).
    if let Some(png) = fetch_icon_png(client, domain, hint).await {
        store.put_png(domain, &png).await?;
        return Ok(true);
    }

    // 2) Fallback to the registrable parent domain (e.g. ap.www.namecheap.com →
    //    namecheap.com), since enrollment often happens on an icon-less subdomain.
    //    The icon is stored under the ORIGINAL host key so the account still matches.
    if let Some(parent) = registrable_domain(domain) {
        if parent != domain {
            if let Some(png) = fetch_icon_png(client, &parent, None).await {
                store.put_png(domain, &png).await?;
                return Ok(true);
            }
        }
    }

    Ok(false)
}

/// Tries hint (same-domain) → homepage `<link rel=icon>` → `/favicon.ico` for one
/// domain, returning the normalized 64×64 PNG bytes if any source yields an image.
async fn fetch_icon_png(
    client: &reqwest::Client,
    domain: &str,
    hint: Option<&str>,
) -> Option<Vec<u8>> {
    if let Some(h) = hint {
        if let Ok(u) = reqwest::Url::parse(h) {
            if u.scheme() == "https" && host_matches_domain(u.host_str(), domain) {
                if let Some(png) = download_and_normalize(client, u.as_str()).await {
                    return Some(png);
                }
            }
        }
    }
    if let Some(href) = discover_link_icon(client, domain).await {
        if let Some(png) = download_and_normalize(client, &href).await {
            return Some(png);
        }
    }
    let fav = format!("https://{domain}/favicon.ico");
    download_and_normalize(client, &fav).await
}

/// Registrable domain (eTLD+1) per the Public Suffix List, e.g.
/// `ap.www.namecheap.com` → `namecheap.com`, `foo.bar.co.uk` → `bar.co.uk`.
fn registrable_domain(domain: &str) -> Option<String> {
    psl::domain_str(domain).map(str::to_string)
}

/// Downloads bytes (with SSRF + size guards) and re-encodes to a 64×64 PNG.
/// Returns None if the host is non-public, the download fails, or it isn't an image.
async fn download_and_normalize(client: &reqwest::Client, url: &str) -> Option<Vec<u8>> {
    let parsed = reqwest::Url::parse(url).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    if !host_is_public(parsed.host_str()?).await {
        return None;
    }
    let bytes = fetch_capped(client, url).await?;
    normalize_to_png(&bytes)
}

/// Fetches the homepage HTML and extracts the best `<link rel="...icon...">` href,
/// resolved to an absolute URL on the same domain.
async fn discover_link_icon(client: &reqwest::Client, domain: &str) -> Option<String> {
    let base = format!("https://{domain}/");
    if !host_is_public(domain).await {
        return None;
    }
    let html_bytes = fetch_capped(client, &base).await?;
    let html = String::from_utf8_lossy(&html_bytes);
    let href = extract_icon_href(&html)?;
    let abs = reqwest::Url::parse(&base).ok()?.join(&href).ok()?;
    if abs.scheme() == "https" && host_matches_domain(abs.host_str(), domain) {
        Some(abs.into())
    } else {
        None
    }
}

async fn fetch_capped(client: &reqwest::Client, url: &str) -> Option<Vec<u8>> {
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    if let Some(len) = resp.content_length() {
        if len as usize > MAX_DOWNLOAD {
            return None;
        }
    }
    let bytes = resp.bytes().await.ok()?;
    if bytes.len() > MAX_DOWNLOAD {
        return None;
    }
    Some(bytes.to_vec())
}

fn normalize_to_png(bytes: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    let resized = img.resize_to_fill(ICON_SIZE, ICON_SIZE, image::imageops::FilterType::Lanczos3);
    let mut out = std::io::Cursor::new(Vec::new());
    resized.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

/// Minimal scan for `<link rel="...icon...">` → href, no HTML parser dependency.
fn extract_icon_href(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let mut search_from = 0;
    let mut fallback: Option<String> = None;
    while let Some(rel_pos) = lower[search_from..].find("<link") {
        let start = search_from + rel_pos;
        let end = lower[start..].find('>').map(|e| start + e).unwrap_or(lower.len());
        let tag = &html[start..end];
        let tag_lower = &lower[start..end];
        search_from = end;
        if !tag_lower.contains("rel=") || !tag_lower.contains("icon") {
            continue;
        }
        if let Some(href) = attr_value(tag, "href") {
            // Prefer apple-touch-icon (usually higher res); otherwise keep the first.
            if tag_lower.contains("apple-touch-icon") {
                return Some(href);
            }
            if fallback.is_none() {
                fallback = Some(href);
            }
        }
    }
    fallback
}

/// Extracts a quoted attribute value (case-insensitive name) from a tag fragment.
fn attr_value(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let key = format!("{name}=");
    let idx = lower.find(&key)? + key.len();
    let rest = &tag[idx..];
    let bytes = rest.as_bytes();
    let (quote, content_start) = match bytes.first() {
        Some(b'"') => ('"', 1),
        Some(b'\'') => ('\'', 1),
        _ => return None,
    };
    let end = rest[content_start..].find(quote)? + content_start;
    let val = rest[content_start..end].trim();
    if val.is_empty() {
        None
    } else {
        Some(val.to_string())
    }
}

// ── Domain / SSRF helpers ────────────────────────────────────────────────────

/// Lowercases, strips `*.`/`www.`/trailing dot and any accidental path/port, and
/// validates the result looks like a hostname with a dot. None → unusable.
fn normalize_domain(input: &str) -> Option<String> {
    let mut d = input.trim().to_lowercase();
    if let Some(rest) = d.strip_prefix("*.") {
        d = rest.to_string();
    }
    if let Some(rest) = d.strip_prefix("www.") {
        d = rest.to_string();
    }
    d = d.split('/').next().unwrap_or("").to_string();
    d = d.split(':').next().unwrap_or("").to_string();
    d = d.trim_end_matches('.').to_string();
    if d.is_empty() || d.len() > 253 || !d.contains('.') {
        return None;
    }
    if !d.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
        return None;
    }
    Some(d)
}

fn host_matches_domain(host: Option<&str>, domain: &str) -> bool {
    match host {
        Some(h) => {
            let h = h.to_lowercase();
            h == domain || h.ends_with(&format!(".{domain}"))
        }
        None => false,
    }
}

/// True only if the host resolves and every resolved address is a public IP.
async fn host_is_public(host: &str) -> bool {
    let Ok(addrs) = tokio::net::lookup_host((host, 443u16)).await else {
        return false;
    };
    let mut any = false;
    for sa in addrs {
        any = true;
        if !ip_is_public(sa.ip()) {
            return false;
        }
    }
    any
}

fn ip_is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || v4.octets()[0] == 0
                || is_cgnat(v4))
        }
        IpAddr::V6(v6) => {
            let seg0 = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || (seg0 & 0xfe00) == 0xfc00   // unique local fc00::/7
                || (seg0 & 0xffc0) == 0xfe80)   // link-local fe80::/10
        }
    }
}

/// Carrier-grade NAT range 100.64.0.0/10.
fn is_cgnat(v4: Ipv4Addr) -> bool {
    let o = v4.octets();
    o[0] == 100 && (64..=127).contains(&o[1])
}
