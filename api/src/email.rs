//! Transactional emails, sent through Resend.
//!
//! Every email shares one layout (`Mail::html`, the "code tile" design: logo,
//! a white card with the message, the key facts in a monospace tile like a
//! 2FA code, one button). Each email only fills in a `Mail`; the plain-text
//! version (`Mail::text`) goes along for clients that don't render HTML.

use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::sync::{mpsc, Semaphore};

const SITE: &str = "https://otpilot.app";

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
/// delivery. No-op when disabled or unconfigured.
async fn send(enabled: bool, api_key: Option<&str>, from: &str, to: &str, mail: Mail) {
    if !enabled {
        tracing::debug!(
            "[email] not sent (SEND_EMAILS is off) — subject: {}",
            mail.subject
        );
        return;
    }
    let Some(key) = api_key else {
        tracing::warn!("SEND_EMAILS=true but RESEND_API_KEY is not set — email skipped");
        return;
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
    }
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

/// Welcome email sent once, when a user's account is first created (free plan).
pub async fn send_welcome_email(enabled: bool, api_key: Option<&str>, from: &str, to: &str) {
    let mail = Mail {
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
    send(enabled, api_key, from, to, mail).await;
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
    fn text_carries_the_details_and_the_link() {
        let text = sample().text();
        assert!(text.starts_with("Eve <script> invited you\n\nOne & two\n\n"));
        assert!(text.contains("Team: \"Acme\" <ops>\n"));
        assert!(text.contains("Accept invitation: https://otpilot.app/teams/accept/abc?x=1&y=2"));
    }
}
