/// Sends a transactional email via Resend. No-op when disabled or unconfigured.
async fn send(
    enabled: bool,
    api_key: Option<&str>,
    from: &str,
    to: &str,
    subject: &str,
    body: &str,
) {
    if !enabled {
        tracing::debug!("[email] not sent (SEND_EMAILS is off) — subject: {subject}");
        return;
    }
    let Some(key) = api_key else {
        tracing::warn!("SEND_EMAILS=true but RESEND_API_KEY is not set — email skipped");
        return;
    };

    let client = reqwest::Client::new();
    let _ = client
        .post("https://api.resend.com/emails")
        .bearer_auth(key)
        .json(&serde_json::json!({
            "from": from,
            "to":   [to],
            "subject": subject,
            "text": body,
        }))
        .send()
        .await;
}

/// Welcome email sent once, when a user's account is first created (free plan).
pub async fn send_welcome_email(enabled: bool, api_key: Option<&str>, from: &str, to: &str) {
    let subject = "Welcome to OTPilot 🎉";
    let body = "Welcome to OTPilot!\n\n\
        Your account is ready. OTPilot detects 2FA setup pages, saves your TOTP secrets in one click, \
        and auto-fills your codes on login — no phone needed.\n\n\
        Open your dashboard: https://otpilot.app/dashboard\n\n\
        Want your codes on every device? The Personal plan adds end-to-end encrypted cloud sync across all \
        your browsers — a one-time $15 payment, no subscription:\n\
        https://otpilot.app/dashboard/billing\n\n\
        Questions? Just reply to this email.";
    send(enabled, api_key, from, to, subject, body).await;
}

/// Sent when a user upgrades to the Personal (cloud sync) plan.
pub async fn send_personal_upgrade_email(
    enabled: bool,
    api_key: Option<&str>,
    from: &str,
    to: &str,
) {
    let subject = "You're on OTPilot Personal ✅";
    let body = "Thanks for upgrading to OTPilot Personal!\n\n\
        Your TOTP accounts now sync — end-to-end encrypted — across all your devices. Sign in to the \
        extension on any browser and your accounts follow you.\n\n\
        Manage your devices: https://otpilot.app/dashboard/devices\n\
        Billing & receipts:  https://otpilot.app/dashboard/billing\n\n\
        It's a one-time payment — no subscription, nothing recurring.\n\n\
        Questions? Just reply to this email.";
    send(enabled, api_key, from, to, subject, body).await;
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
    let (subject, body) = if plan == "free" {
        (
            "A new device connected to your OTPilot account".to_string(),
            format!(
                "A new browser just connected to your OTPilot account: {}.\n\nWith the Personal plan you can sync your TOTP accounts across all your devices — it's a one-time $15 payment, no subscription.\n\nUpgrade here: https://otpilot.app/dashboard/billing",
                device_name
            ),
        )
    } else {
        (
            "New device connected to OTPilot".to_string(),
            format!(
                "A new device synced your OTPilot accounts: {}.\n\nIf this wasn't you, review your connected devices here:\nhttps://otpilot.app/dashboard/devices",
                device_name
            ),
        )
    };

    send(enabled, api_key, from, to, &subject, &body).await;
}
