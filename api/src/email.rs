//! Transactional emails, sent through Resend.
//!
//! Every email shares one layout (`Mail::html`, the "code tile" design: logo,
//! a white card with the message, the key facts in a monospace tile like a
//! 2FA code, one button). Each email only fills in a `Mail`; the plain-text
//! version (`Mail::text`) goes along for clients that don't render HTML.

use chrono::{DateTime, Utc};
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::sync::{mpsc, Semaphore};

const SITE: &str = "https://otpilot.app";
const STORE_URL: &str =
    "https://chromewebstore.google.com/detail/otpilot/mbfpjhjhcmgcchnnnnjcdblkbjifgjpk";

/// What one email says; the layout is the same for all of them.
#[derive(Default)]
struct Mail {
    subject: String,
    /// Small label above the title.
    eyebrow: &'static str,
    title: String,
    paras: Vec<String>,
    /// Key facts shown in the code tile (label, value).
    details: Vec<(&'static str, String)>,
    cta: (&'static str, String),
    /// Small print under the button.
    footnote: Option<String>,
    /// A last line with a link: (text, link label, url).
    aside: Option<(&'static str, &'static str, String)>,
}

/// Escapes text for HTML (every value that comes from a user goes through it).
fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

const FONT: &str = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO: &str = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

impl Mail {
    fn html(&self) -> String {
        let paras: String = self
            .paras
            .iter()
            .map(|p| {
                format!(
                    r#"<p style="margin:0 0 14px;font:15px/1.6 {FONT};color:#475569;">{}</p>"#,
                    esc(p)
                )
            })
            .collect();
        let tile = if self.details.is_empty() {
            String::new()
        } else {
            let rows: String = self
                .details
                .iter()
                .enumerate()
                .map(|(i, (k, v))| {
                    format!(
                        r#"<p style="margin:{top} 0 0;font:11px {MONO};letter-spacing:.1em;text-transform:uppercase;color:#64748b;">{k}</p><p style="margin:2px 0 0;font:500 16px {MONO};color:#7dd3fc;word-break:break-word;">{v}</p>"#,
                        top = if i == 0 { "0" } else { "12px" },
                        k = esc(k),
                        v = esc(v),
                    )
                })
                .collect();
            format!(
                r#"<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;background:#0f172a;border-radius:10px;"><tr><td style="padding:18px 20px;">{rows}</td></tr></table>"#
            )
        };
        let small = |text: String| {
            format!(r#"<p style="margin:16px 0 0;font:13px/1.55 {FONT};color:#64748b;">{text}</p>"#)
        };
        let footnote = self
            .footnote
            .as_deref()
            .map(|f| small(esc(f)))
            .unwrap_or_default();
        let aside = self
            .aside
            .as_ref()
            .map(|(text, link, url)| {
                small(format!(
                    r#"{} <a href="{}" style="color:#0284c7;">{}</a>"#,
                    esc(text),
                    esc(url),
                    esc(link)
                ))
            })
            .unwrap_or_default();
        let footer_link = |url: &str, label: &str| {
            format!(
                r#"<a href="{SITE}{url}" style="color:#94a3b8;text-decoration:underline;">{label}</a>"#
            )
        };
        format!(
            r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>{subject}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;">{preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;"><tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;">
<tr><td align="center" style="padding-bottom:20px;"><img src="{SITE}/logo.png" width="40" height="40" alt="OTPilot" style="border:0;display:block;"></td></tr>
<tr><td style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:32px 30px;">
<p style="margin:0 0 10px;font:500 12px {MONO};color:#0284c7;">— {eyebrow}</p>
<h1 style="margin:0 0 16px;font:700 22px/1.3 {FONT};color:#0f172a;">{title}</h1>
{paras}{tile}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="background:#0284c7;border-radius:8px;"><a href="{cta_url}" style="display:block;padding:13px 20px;font:600 15px {FONT};color:#ffffff;text-decoration:none;">{cta_label}</a></td></tr></table>
{footnote}{aside}
</td></tr>
<tr><td align="center" style="padding:20px 10px 0;font:12px/1.7 {FONT};color:#94a3b8;">OTPilot · 2FA codes and passwords in your browser<br>Questions? Reply to this email.<br>{home} · {settings} · {privacy}</td></tr>
</table></td></tr></table></body></html>"#,
            subject = esc(&self.subject),
            preheader = esc(self.paras.first().map(String::as_str).unwrap_or("")),
            eyebrow = esc(&self.eyebrow.to_lowercase()),
            title = esc(&self.title),
            cta_url = esc(&self.cta.1),
            cta_label = esc(self.cta.0),
            home = footer_link("", "otpilot.app"),
            settings = footer_link("/dashboard/settings", "Account settings"),
            privacy = footer_link("/privacy", "Privacy"),
        )
    }

    fn text(&self) -> String {
        let mut out = format!("{}\n\n", self.title);
        for p in &self.paras {
            out.push_str(p);
            out.push_str("\n\n");
        }
        for (k, v) in &self.details {
            out.push_str(&format!("{k}: {v}\n"));
        }
        if !self.details.is_empty() {
            out.push('\n');
        }
        out.push_str(&format!("{}: {}\n\n", self.cta.0, self.cta.1));
        if let Some(f) = &self.footnote {
            out.push_str(f);
            out.push_str("\n\n");
        }
        if let Some((text, link, url)) = &self.aside {
            out.push_str(&format!("{text} {link}: {url}\n\n"));
        }
        out.push_str("Questions? Just reply to this email.\n— OTPilot");
        out
    }
}

/// Emails being sent at once, at most.
const MAX_SENDING: usize = 8;
/// Emails waiting their turn, at most. Past that (Resend down or very slow)
/// new ones are dropped with a warning rather than piling up in memory.
const MAX_WAITING: usize = 500;

struct Outgoing {
    key: String,
    body: serde_json::Value,
}

/// The queue to the sender task, started on first use: it takes one email at
/// a time off a bounded channel and sends up to `MAX_SENDING` at once.
fn outbox() -> &'static mpsc::Sender<Outgoing> {
    static OUTBOX: OnceLock<mpsc::Sender<Outgoing>> = OnceLock::new();
    OUTBOX.get_or_init(|| {
        let (tx, mut rx) = mpsc::channel::<Outgoing>(MAX_WAITING);
        tokio::spawn(async move {
            let client = reqwest::Client::new();
            let sending = Arc::new(Semaphore::new(MAX_SENDING));
            while let Some(mail) = rx.recv().await {
                let Ok(turn) = sending.clone().acquire_owned().await else {
                    return;
                };
                let client = client.clone();
                tokio::spawn(async move {
                    let sent = client
                        .post("https://api.resend.com/emails")
                        .bearer_auth(mail.key)
                        .timeout(Duration::from_secs(20))
                        .json(&mail.body)
                        .send()
                        .await;
                    if let Err(e) = sent {
                        tracing::warn!("[email] not sent: {e}");
                    }
                    drop(turn);
                });
            }
        });
        tx
    })
}

/// Queues one email for Resend: the request that caused it doesn't wait for
/// delivery. No-op when disabled or unconfigured. False only when the queue
/// was full and the email was dropped (a caller that claimed it can retry).
async fn send(enabled: bool, api_key: Option<&str>, from: &str, to: &str, mail: Mail) -> bool {
    if !enabled {
        tracing::debug!(
            "[email] not sent (SEND_EMAILS is off) — subject: {}",
            mail.subject
        );
        return true;
    }
    let Some(key) = api_key else {
        tracing::warn!("SEND_EMAILS=true but RESEND_API_KEY is not set — email skipped");
        return true;
    };
    let outgoing = Outgoing {
        key: key.to_string(),
        body: serde_json::json!({
            "from": from,
            "to":   [to],
            "subject": mail.subject,
            "html": mail.html(),
            "text": mail.text(),
        }),
    };
    if outbox().try_send(outgoing).is_err() {
        tracing::warn!("[email] queue full — dropped: {}", mail.subject);
        return false;
    }
    true
}

/// Team invitation. `recipient_has_account` picks the copy: existing users get a
/// direct accept link (and the invite shows in their extension); new users are
/// told to install the extension and sign up with this email (the invite is
/// accepted on their first sign-in).
#[allow(clippy::too_many_arguments)]
pub async fn send_team_invite_email(
    enabled: bool,
    api_key: Option<&str>,
    from: &str,
    to: &str,
    inviter: &str,
    team_name: &str,
    accept_url: &str,
    recipient_has_account: bool,
) {
    let details = vec![
        ("Team", team_name.to_string()),
        ("Invited by", inviter.to_string()),
        ("Expires", "in 48 hours".to_string()),
    ];
    let mail = if recipient_has_account {
        Mail {
            subject: format!("{inviter} invited you to \"{team_name}\" on OTPilot"),
            eyebrow: "Team invitation",
            title: format!("{inviter} invited you to {team_name}"),
            paras: vec![
                "Join the team to get the 2FA codes, logins and collections your teammates share with you, right in the extension.".into(),
                "You can also accept it from the OTPilot extension: the invitation is waiting there.".into(),
            ],
            details,
            cta: ("Accept invitation", accept_url.to_string()),
            ..Default::default()
        }
    } else {
        Mail {
            subject: "You've been invited to OTPilot".into(),
            eyebrow: "Team invitation",
            title: format!("{inviter} invited you to {team_name}"),
            paras: vec![
                "Install the OTPilot extension and create your account with this email address. The invitation is accepted when you sign in.".into(),
            ],
            details,
            cta: ("Get OTPilot", SITE.to_string()),
            ..Default::default()
        }
    };
    send(enabled, api_key, from, to, mail).await;
}

/// Notifies a recipient that a teammate shared a TOTP code with them (Team Lite).
pub async fn send_shared_code_email(
    enabled: bool,
    api_key: Option<&str>,
    from: &str,
    to: &str,
    sharer: &str,
    account_name: &str,
) {
    let mail = Mail {
        subject: format!("{sharer} shared a code with you on OTPilot"),
        eyebrow: "Shared with you",
        title: format!("{sharer} shared a 2FA code with you"),
        paras: vec![
            "Open the OTPilot extension. The code appears under \"Shared with you\" and refreshes every 30 seconds.".into(),
        ],
        details: vec![("Account", account_name.to_string())],
        cta: ("Open team", format!("{SITE}/dashboard/team")),
        ..Default::default()
    };
    send(enabled, api_key, from, to, mail).await;
}

fn role_label(role: &str) -> &'static str {
    match role {
        "manage" => "Can manage",
        "edit" => "Can edit",
        _ => "View only",
    }
}

/// A teammate added the recipient to a team collection. The collection's name
/// is encrypted end to end, so the email can't say which one.
pub async fn send_collection_added_email(
    enabled: bool,
    api_key: Option<&str>,
    from: &str,
    to: &str,
    adder: &str,
    team_name: &str,
    role: &str,
) {
    let mail = Mail {
        subject: format!("{adder} added you to a collection on OTPilot"),
        eyebrow: "Team collection",
        title: format!("{adder} added you to a shared collection"),
        paras: vec![
            "Open the OTPilot extension and go to the Team tab to see it. Its items show in your vault, tagged with the collection.".into(),
            "Collections are end-to-end encrypted, so its name only shows in the extension.".into(),
        ],
        details: vec![("Team", team_name.to_string()), ("Your role", role_label(role).to_string())],
        cta: ("Open team", format!("{SITE}/dashboard/team")),
        ..Default::default()
    };
    send(enabled, api_key, from, to, mail).await;
}

/// A teammate shared one of their items with the recipient directly. The
/// item is encrypted end to end, so the email can't say which one.
pub async fn send_item_shared_email(
    enabled: bool,
    api_key: Option<&str>,
    from: &str,
    to: &str,
    sharer: &str,
    team_name: &str,
    role: &str,
) {
    let mail = Mail {
        subject: format!("{sharer} shared an item with you on OTPilot"),
        eyebrow: "Shared with you",
        title: format!("{sharer} shared an item with you"),
        paras: vec![
            format!("It shows in your OTPilot vault as \"Shared · {sharer}\", and it fills in like your own logins."),
            "Shared items are end-to-end encrypted, so what was shared only shows in the extension.".into(),
        ],
        details: vec![("Team", team_name.to_string()), ("Access", role_label(role).to_string())],
        cta: ("Open team", format!("{SITE}/dashboard/team")),
        ..Default::default()
    };
    send(enabled, api_key, from, to, mail).await;
}

/// A new account. `trial_ends` when it started with the Personal trial: the
/// welcome then says so (one email, not a welcome plus a trial one).
pub async fn send_welcome_email(
    enabled: bool,
    api_key: Option<&str>,
    from: &str,
    to: &str,
    trial_ends: Option<DateTime<Utc>>,
) {
    let mut mail = Mail {
        subject: "Welcome to OTPilot".into(),
        eyebrow: "Welcome",
        title: "Your OTPilot account is ready".into(),
        paras: vec![
            "OTPilot spots 2FA setup pages, saves the secret in one click and fills your codes when you sign in. No phone needed.".into(),
            "Passwords, notes and cards live in the same encrypted vault, unlocked with your master password.".into(),
        ],
        cta: ("Open your dashboard", format!("{SITE}/dashboard")),
        aside: Some((
            "Want your vault on every browser? Personal adds end-to-end encrypted sync for $3/month or $30/year.",
            "See plans",
            format!("{SITE}/dashboard/billing"),
        )),
        ..Default::default()
    };
    if let Some(ends) = trial_ends {
        mail.paras.push(
            "Your account comes with 30 days of Personal, free: turn on sync in the extension and your vault follows you to every browser, end-to-end encrypted.".into(),
        );
        mail.details = trial_details(ends);
        mail.footnote = Some(TRIAL_AFTER.into());
        mail.aside = None;
    }
    send(enabled, api_key, from, to, mail).await;
}

/// What happens when a trial ends, said in every trial email.
const TRIAL_AFTER: &str = "When the trial ends you go back to Free. Nothing is deleted.";

fn long_date(at: DateTime<Utc>) -> String {
    at.format("%B %-d, %Y").to_string()
}

fn trial_details(ends: DateTime<Utc>) -> Vec<(&'static str, String)> {
    vec![
        ("Plan", "Personal (trial)".into()),
        ("Ends", long_date(ends)),
        ("Card", "None needed".into()),
    ]
}

/// An existing account started the Personal trial (from the extension or
/// the dashboard).
pub async fn send_trial_started_email(
    enabled: bool,
    api_key: Option<&str>,
    from: &str,
    to: &str,
    ends: DateTime<Utc>,
) {
    let mail = Mail {
        subject: "Sync is on: 30 days of Personal, free".into(),
        eyebrow: "Personal trial",
        title: "Your 30 days of sync start now".into(),
        paras: vec![
            "Your vault is encrypted on your device before it's uploaded, so we can't read it.".into(),
            "Install OTPilot in another browser and sign in with this email to get your codes there too.".into(),
        ],
        details: trial_details(ends),
        cta: ("Get OTPilot for another browser", STORE_URL.to_string()),
        footnote: Some(TRIAL_AFTER.into()),
        ..Default::default()
    };
    send(enabled, api_key, from, to, mail).await;
}

/// Whole days left until `ends`, rounded up (a trial ending in 48 h 30 min
/// has 3 days left).
fn days_left(ends: DateTime<Utc>, now: DateTime<Utc>) -> i64 {
    ((ends - now).num_minutes() + 1439).div_euclid(1440).max(1)
}

/// `trial::REMINDER_DAYS` before the trial ends.
pub async fn send_trial_reminder_email(
    enabled: bool,
    api_key: Option<&str>,
    from: &str,
    to: &str,
    ends: DateTime<Utc>,
    items: Option<i64>,
    devices: i64,
) -> bool {
    send(
        enabled,
        api_key,
        from,
        to,
        trial_reminder(ends, Utc::now(), items, devices),
    )
    .await
}

/// `items` is None when unknown (a vault synced only by a 1.x client, whose
/// blob the server can't count): the email then claims nothing about it.
fn trial_reminder(
    ends: DateTime<Utc>,
    now: DateTime<Utc>,
    items: Option<i64>,
    devices: i64,
) -> Mail {
    let days = days_left(ends, now);
    let when = if days == 1 {
        "tomorrow".to_string()
    } else {
        format!("in {days} days")
    };
    let date = long_date(ends);
    let progress = match (items, devices) {
        (None, _) => "Personal keeps your vault backed up and in sync across your browsers, end-to-end encrypted.".to_string(),
        (Some(0), _) => "Sync hasn't stored anything yet: turn it on in the extension to try it before the trial ends.".to_string(),
        (Some(i), d) if d >= 2 => format!("Since you started, OTPilot has kept {i} {} in sync across {d} browsers.", plural(i, "item")),
        (Some(i), _) => format!("Since you started, OTPilot has backed up {i} {}, end-to-end encrypted.", plural(i, "item")),
    };
    let mut details = vec![("Ends", date.clone())];
    if let Some(items) = items.filter(|&i| i > 0) {
        details.push((
            "Synced",
            format!(
                "{items} {} · {devices} {}",
                plural(items, "item"),
                plural(devices, "device")
            ),
        ));
    }
    details.push(("Personal", "$3/month or $30/year".into()));
    Mail {
        subject: format!("Your OTPilot trial ends {when}"),
        eyebrow: "Trial ending",
        title: format!("Your trial ends {when}"),
        paras: vec![progress, format!("On {date} sync pauses unless you subscribe.")],
        details,
        cta: ("Keep sync", format!("{SITE}/dashboard/billing")),
        footnote: Some("If you don't subscribe, everything stays on your devices and keeps working. Only sync stops.".into()),
        aside: Some(("Paying yearly?", "Two months free", format!("{SITE}/dashboard/billing"))),
    }
}

/// The trial ended (the user is on Free again).
pub async fn send_trial_ended_email(
    enabled: bool,
    api_key: Option<&str>,
    from: &str,
    to: &str,
    counted_items: Option<i64>,
) -> bool {
    send(enabled, api_key, from, to, trial_ended(counted_items)).await
}

/// `counted_items` is None when unknown (see `trial_reminder`).
fn trial_ended(counted_items: Option<i64>) -> Mail {
    let limit = FREE_ITEM_LIMIT;
    let mut paras = vec![
        "Your trial ended. Everything is still on each device and your codes keep working; they just don't sync between browsers anymore.".to_string(),
    ];
    if let Some(counted) = counted_items.filter(|&i| i > limit) {
        paras.push(format!(
            "Free holds {limit} items. You can keep editing the {counted} you have; adding more needs Personal."
        ));
    }
    let mut details = vec![("Plan", "Free".to_string())];
    if let Some(counted) = counted_items {
        details.push(("Items", format!("{counted} of {limit} on Free")));
    }
    details.push(("Sync", "Paused".into()));
    Mail {
        subject: "Your OTPilot trial ended".into(),
        eyebrow: "Trial ended",
        title: "Sync is paused".into(),
        paras,
        details,
        cta: ("Subscribe to Personal", format!("{SITE}/dashboard/billing")),
        footnote: Some(
            "Changes you make now stay on the device where you make them, until you subscribe."
                .into(),
        ),
        ..Default::default()
    }
}

/// `Vault.FREE_ITEM_LIMIT` in the extension (the server can't count items
/// itself beyond `counts_for_limit`).
const FREE_ITEM_LIMIT: i64 = 50;

fn plural(n: i64, word: &str) -> String {
    if n == 1 {
        word.to_string()
    } else {
        format!("{word}s")
    }
}

/// Sent when a user subscribes to the Personal (cloud sync) plan.
pub async fn send_personal_subscription_email(
    enabled: bool,
    api_key: Option<&str>,
    from: &str,
    to: &str,
) {
    let mail = Mail {
        subject: "You're on OTPilot Personal".into(),
        eyebrow: "Personal plan",
        title: "Thanks for subscribing to Personal".into(),
        paras: vec![
            "Your vault now syncs across all your devices, end-to-end encrypted, with no limit on passwords and notes. Sign in to the extension on any browser and it follows you.".into(),
            "Your subscription renews automatically. You can cancel anytime from the billing page.".into(),
        ],
        cta: ("Manage your devices", format!("{SITE}/dashboard/devices")),
        aside: Some((
            "Receipts and cancellation are on the billing page.",
            "Billing",
            format!("{SITE}/dashboard/billing"),
        )),
        ..Default::default()
    };
    send(enabled, api_key, from, to, mail).await;
}

/// 1.x one-time purchase (a checkout started before 2.0 can still complete).
pub async fn send_personal_upgrade_email(
    enabled: bool,
    api_key: Option<&str>,
    from: &str,
    to: &str,
) {
    let mail = Mail {
        subject: "You're on OTPilot Personal".into(),
        eyebrow: "Personal plan",
        title: "Thanks for upgrading to Personal".into(),
        paras: vec![
            "Your vault now syncs across all your devices, end-to-end encrypted. Sign in to the extension on any browser and it follows you.".into(),
            "It's a one-time payment: nothing recurring.".into(),
        ],
        cta: ("Manage your devices", format!("{SITE}/dashboard/devices")),
        aside: Some((
            "Your receipt is on the billing page.",
            "Billing",
            format!("{SITE}/dashboard/billing"),
        )),
        ..Default::default()
    };
    send(enabled, api_key, from, to, mail).await;
}

/// Sent when a new device connects to an existing account (security notice).
pub async fn send_new_device_email(
    enabled: bool,
    api_key: Option<&str>,
    from: &str,
    to: &str,
    device_name: &str,
    plan: &str,
) {
    let mail = if plan == "free" {
        Mail {
            subject: "A new device connected to your OTPilot account".into(),
            eyebrow: "Security notice",
            title: "A new browser connected to your account".into(),
            paras: vec![
                "With the Personal plan your vault syncs across all your devices, end-to-end encrypted, for $3/month or $30/year.".into(),
            ],
            details: vec![("Device", device_name.to_string())],
            cta: ("See plans", format!("{SITE}/dashboard/billing")),
            footnote: Some("If this wasn't you, review your devices from the dashboard.".into()),
            ..Default::default()
        }
    } else {
        Mail {
            subject: "New device connected to OTPilot".into(),
            eyebrow: "Security notice",
            title: "A new device connected to your account".into(),
            paras: vec!["A browser just synced your OTPilot vault.".into()],
            details: vec![("Device", device_name.to_string())],
            cta: ("Review your devices", format!("{SITE}/dashboard/devices")),
            footnote: Some(
                "If this wasn't you, disconnect the device and change your master password.".into(),
            ),
            ..Default::default()
        }
    };
    send(enabled, api_key, from, to, mail).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Mail {
        Mail {
            subject: "Hi <there>".into(),
            eyebrow: "Team invitation",
            title: "Eve <script> invited you".into(),
            paras: vec!["One & two".into()],
            details: vec![("Team", "\"Acme\" <ops>".into())],
            cta: (
                "Accept invitation",
                "https://otpilot.app/teams/accept/abc?x=1&y=2".into(),
            ),
            ..Default::default()
        }
    }

    #[test]
    fn html_escapes_every_value() {
        let html = sample().html();
        assert!(!html.contains("<script>"));
        assert!(html.contains("Eve &lt;script&gt; invited you"));
        assert!(html.contains("&quot;Acme&quot; &lt;ops&gt;"));
        assert!(html.contains("One &amp; two"));
        assert!(html.contains("accept/abc?x=1&amp;y=2"));
        assert!(html.contains("— team invitation"));
    }

    #[test]
    fn days_left_rounds_up() {
        let now = Utc::now();
        assert_eq!(days_left(now + chrono::Duration::hours(50), now), 3);
        assert_eq!(days_left(now + chrono::Duration::hours(72), now), 3);
        assert_eq!(days_left(now + chrono::Duration::hours(5), now), 1);
        assert_eq!(
            days_left(now + chrono::Duration::minutes(48 * 60 + 30), now),
            3
        );
        assert_eq!(
            days_left(now + chrono::Duration::minutes(24 * 60 + 30), now),
            2
        );
    }

    #[test]
    fn the_reminder_says_what_was_synced() {
        let now = Utc::now();
        let ends = now + chrono::Duration::hours(71);
        let mail = trial_reminder(ends, now, Some(38), 2);
        assert_eq!(mail.subject, "Your OTPilot trial ends in 3 days");
        assert!(mail.paras[0].contains("38 items in sync across 2 browsers"));
        assert!(mail
            .details
            .iter()
            .any(|(k, v)| *k == "Synced" && v == "38 items · 2 devices"));

        let tomorrow = trial_reminder(now + chrono::Duration::hours(20), now, Some(0), 1);
        assert_eq!(tomorrow.title, "Your trial ends tomorrow");
        assert!(tomorrow.paras[0].contains("hasn't stored anything"));
        assert!(!tomorrow.details.iter().any(|(k, _)| *k == "Synced"));

        // A 1.x-only vault: no count, so no claim that nothing synced.
        let unknown = trial_reminder(ends, now, None, 1);
        assert!(!unknown.paras[0].contains("hasn't stored"));
        assert!(!unknown.details.iter().any(|(k, _)| *k == "Synced"));
    }

    #[test]
    fn the_ended_email_mentions_the_free_limit_only_when_over_it() {
        assert_eq!(trial_ended(Some(38)).paras.len(), 1);
        let over = trial_ended(Some(72));
        assert!(over.paras[1].contains("keep editing the 72"));
        let unknown = trial_ended(None);
        assert_eq!(unknown.paras.len(), 1);
        assert!(!unknown.details.iter().any(|(k, _)| *k == "Items"));
    }

    #[test]
    fn text_carries_the_details_and_the_link() {
        let text = sample().text();
        assert!(text.starts_with("Eve <script> invited you\n\nOne & two\n\n"));
        assert!(text.contains("Team: \"Acme\" <ops>\n"));
        assert!(text.contains("Accept invitation: https://otpilot.app/teams/accept/abc?x=1&y=2"));
    }
}
