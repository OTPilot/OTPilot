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

    if !enabled {
        println!(
            "[email] (not sent — SEND_EMAILS is off)\n  To: {to}\n  Subject: {subject}\n  Body: {body}"
        );
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
