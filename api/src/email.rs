pub async fn send_new_device_email(api_key: &str, from: &str, to: &str, device_name: &str) {
    let client = reqwest::Client::new();
    let _ = client
        .post("https://api.resend.com/emails")
        .bearer_auth(api_key)
        .json(&serde_json::json!({
            "from": from,
            "to":   [to],
            "subject": "New device connected to OTPilot",
            "text": format!(
                "A new device synced your OTPilot accounts: {}.\n\nIf this wasn't you, sign in to your dashboard to review your connected devices.",
                device_name
            ),
        }))
        .send()
        .await;
}
