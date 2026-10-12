//! In-extension notices: pending team invitations and "a teammate added you
//! to a collection / shared an item with you". The extension polls this,
//! counts the entries on its icon badge and lists them in the popup.
//!
//! Invitations are read live from `pending_invites` (by the caller's email),
//! so an accepted, declined or expired one disappears by itself. The other
//! notices are `notifications` rows, one per collection membership / direct
//! grant: dismissing one deletes it, and listing deletes the caller's notices
//! that are over 30 days old or point at something they can no longer open.

use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    error::{ApiError, Result},
    middleware::auth::AuthUser,
    AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/notifications", get(list))
        .route("/notifications/{id}/read", post(dismiss))
}

#[derive(sqlx::FromRow)]
struct InviteRow {
    token: String,
    team_id: Uuid,
    team_name: String,
    inviter: Option<String>,
    expires_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct NoticeRow {
    id: Uuid,
    kind: String,
    team_name: String,
    actor: Option<String>,
    target_id: Uuid,
    role: String,
    created_at: DateTime<Utc>,
}

async fn list(State(state): State<AppState>, auth: AuthUser) -> Result<Json<Value>> {
    let invites = match auth.email.as_deref() {
        Some(email) => {
            sqlx::query_as::<_, InviteRow>(
                r#"
                SELECT i.token, i.team_id, t.name AS team_name, u.email AS inviter, i.expires_at
                FROM pending_invites i
                JOIN teams t ON t.id = i.team_id
                LEFT JOIN users u ON u.id = i.invited_by
                WHERE lower(i.email) = lower($1) AND i.accepted_at IS NULL AND i.expires_at > NOW()
                  AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = i.team_id AND m.user_id = $2)
                ORDER BY i.created_at DESC
                "#,
            )
            .bind(email)
            .bind(auth.id)
            .fetch_all(&state.db)
            .await?
        }
        None => vec![],
    };
    // Only what still reaches the user is kept (this also bounds the table:
    // the extension lists every few minutes).
    sqlx::query(
        r#"
        DELETE FROM notifications n
        WHERE n.user_id = $1 AND (
          n.created_at <= NOW() - INTERVAL '30 days'
          OR NOT CASE n.kind
            WHEN 'collection_added' THEN EXISTS (SELECT 1 FROM collection_members m
                                                 WHERE m.collection_id = n.target_id AND m.user_id = $1)
            WHEN 'item_shared' THEN EXISTS (SELECT 1 FROM share_grants g
                                            WHERE g.share_id = n.target_id AND g.user_id = $1)
            ELSE false END)
        "#,
    )
    .bind(auth.id)
    .execute(&state.db)
    .await?;
    let notices = sqlx::query_as::<_, NoticeRow>(
        r#"
        SELECT n.id, n.kind, t.name AS team_name, a.email AS actor, n.target_id, n.role, n.created_at
        FROM notifications n
        JOIN teams t ON t.id = n.team_id
        LEFT JOIN users a ON a.id = n.actor_id
        WHERE n.user_id = $1
        ORDER BY n.created_at DESC
        LIMIT 50
        "#,
    )
    .bind(auth.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({
        "invites": invites.iter().map(|i| json!({
            "token": i.token, "team_id": i.team_id, "team_name": i.team_name,
            "inviter": i.inviter, "expires_at": i.expires_at,
        })).collect::<Vec<_>>(),
        "notices": notices.iter().map(|n| json!({
            "id": n.id, "kind": n.kind, "team_name": n.team_name, "actor": n.actor,
            "target_id": n.target_id, "role": n.role, "created_at": n.created_at,
        })).collect::<Vec<_>>(),
    })))
}

/// Dismisses a notice (it's been seen): deleted.
async fn dismiss(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let done = sqlx::query("DELETE FROM notifications WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(auth.id)
        .execute(&state.db)
        .await?
        .rows_affected();
    if done == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

/// What a notice is about.
pub(crate) enum Notice {
    /// Added to collection `target` (not a role change).
    CollectionAdded,
    /// Granted share `target` directly (not through a collection).
    ItemShared,
}

/// Records a notice for `user` (replacing an earlier one about the same
/// collection / share, e.g. removed and added again) and emails them in the
/// background. Best effort, after the change committed: a failure here never
/// fails the request that caused it.
pub(crate) async fn announce(
    state: &AppState,
    notice: Notice,
    user: Uuid,
    team_id: Uuid,
    actor: &AuthUser,
    target: Uuid,
    role: &str,
) {
    let kind = match notice {
        Notice::CollectionAdded => "collection_added",
        Notice::ItemShared => "item_shared",
    };
    if let Err(e) = sqlx::query(
        "INSERT INTO notifications (user_id, kind, team_id, actor_id, target_id, role)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, kind, target_id) DO UPDATE SET
           id = EXCLUDED.id, team_id = EXCLUDED.team_id, actor_id = EXCLUDED.actor_id, role = EXCLUDED.role,
           created_at = NOW()",
    )
    .bind(user)
    .bind(kind)
    .bind(team_id)
    .bind(actor.id)
    .bind(target)
    .bind(role)
    .execute(&state.db)
    .await
    {
        tracing::warn!("notification not recorded: {e}");
    }

    let to: Option<(Option<String>, String)> = sqlx::query_as(
        "SELECT u.email, t.name FROM users u, teams t WHERE u.id = $1 AND t.id = $2",
    )
    .bind(user)
    .bind(team_id)
    .fetch_optional(&state.db)
    .await
    .unwrap_or(None);
    let Some((Some(to), team_name)) = to else {
        return;
    };
    let who = actor.email.as_deref().unwrap_or("A teammate");
    let (enabled, key, from) = (
        state.send_emails,
        state.resend_api_key.as_deref(),
        state.from_email.as_str(),
    );
    match notice {
        Notice::CollectionAdded => {
            crate::email::send_collection_added_email(
                enabled, key, from, &to, who, &team_name, role,
            )
            .await
        }
        Notice::ItemShared => {
            crate::email::send_item_shared_email(enabled, key, from, &to, who, &team_name, role)
                .await
        }
    }
}

#[cfg(all(test, feature = "db-tests"))]
mod db_tests {
    use super::*;
    use crate::test_support::{call, call_with_email, create_user, test_db, test_state, TestDb};
    use axum::http::{Method, StatusCode};

    async fn app() -> (Router, sqlx::PgPool, TestDb) {
        let db = test_db().await;
        let pool = db.pool.clone();
        let app = router()
            .merge(crate::routes::auth::router())
            .merge(crate::routes::collections::router())
            .merge(crate::routes::shares::router())
            .merge(crate::routes::teams::router())
            .with_state(test_state(pool.clone()));
        (app, pool, db)
    }

    async fn team(db: &sqlx::PgPool, owner: Uuid, members: &[Uuid]) -> Uuid {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO teams (name, owner_id) VALUES ('Acme', $1) RETURNING id",
        )
        .bind(owner)
        .fetch_one(db)
        .await
        .unwrap();
        for (u, role) in
            std::iter::once((owner, "owner")).chain(members.iter().map(|m| (*m, "member")))
        {
            sqlx::query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)")
                .bind(id)
                .bind(u)
                .bind(role)
                .execute(db)
                .await
                .unwrap();
        }
        id
    }

    async fn set_email(db: &sqlx::PgPool, user: Uuid, email: &str) {
        sqlx::query("UPDATE users SET email = $1 WHERE id = $2")
            .bind(email)
            .bind(user)
            .execute(db)
            .await
            .unwrap();
    }

    async fn notices(app: &Router, user: Uuid) -> Vec<Value> {
        let (s, b) = call(app, user, Method::GET, "/notifications", None).await;
        assert_eq!(s, StatusCode::OK);
        b["notices"].as_array().cloned().unwrap()
    }

    async fn invites(app: &Router, user: Uuid, email: &str) -> Vec<Value> {
        let (s, b) =
            call_with_email(app, user, Some(email), Method::GET, "/notifications", None).await;
        assert_eq!(s, StatusCode::OK);
        b["invites"].as_array().cloned().unwrap()
    }

    #[tokio::test]
    async fn being_added_to_a_collection_is_a_notice_until_read_or_removed() {
        let (app, db, _g) = app().await;
        let (owner, ana) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        set_email(&db, owner, "owner@acme.io").await;
        let t = team(&db, owner, &[ana]).await;
        let cid = Uuid::new_v4();
        let (s, _) = call(
            &app,
            owner,
            Method::POST,
            &format!("/teams/{t}/collections"),
            Some(json!({ "id": cid, "encrypted_name": "n", "wrapped_key": "k" })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        // Creating it gives its creator no notice.
        assert!(notices(&app, owner).await.is_empty());

        let add = |role: &'static str, key: bool| {
            let app = app.clone();
            async move {
                let body = if key {
                    json!({ "role": role, "wrapped_key": "k-ana" })
                } else {
                    json!({ "role": role })
                };
                call(
                    &app,
                    owner,
                    Method::PUT,
                    &format!("/collections/{cid}/members/{ana}"),
                    Some(body),
                )
                .await
            }
        };
        assert_eq!(add("view", true).await.0, StatusCode::OK);
        let list = notices(&app, ana).await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["kind"], "collection_added");
        assert_eq!(list[0]["team_name"], "Acme");
        assert_eq!(list[0]["actor"], "owner@acme.io");
        assert_eq!(list[0]["target_id"], json!(cid));
        assert_eq!(list[0]["role"], "view");

        // A role change (with or without a new key) isn't news.
        assert_eq!(add("edit", false).await.0, StatusCode::OK);
        assert_eq!(add("edit", true).await.0, StatusCode::OK);
        assert_eq!(notices(&app, ana).await.len(), 1);

        // Someone else can't mark it read; she can.
        let id = list[0]["id"].as_str().unwrap().to_string();
        let (s, _) = call(
            &app,
            owner,
            Method::POST,
            &format!("/notifications/{id}/read"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, _) = call(
            &app,
            ana,
            Method::POST,
            &format!("/notifications/{id}/read"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert!(notices(&app, ana).await.is_empty());

        // Removed then added again: a new notice; removed: it goes away.
        let (s, _) = call(
            &app,
            owner,
            Method::DELETE,
            &format!("/collections/{cid}/members/{ana}"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(add("view", true).await.0, StatusCode::OK);
        assert_eq!(notices(&app, ana).await.len(), 1);
        // Removed and added again before she looked: still one notice.
        let before = notices(&app, ana).await;
        let (s, _) = call(
            &app,
            owner,
            Method::DELETE,
            &format!("/collections/{cid}/members/{ana}"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(add("view", true).await.0, StatusCode::OK);
        let again = notices(&app, ana).await;
        assert_eq!(again.len(), 1);
        // A new notice (new id): dismissing the one she saw before leaves it.
        assert_ne!(again[0]["id"], before[0]["id"]);
        let old_id = before[0]["id"].as_str().unwrap().to_string();
        let (s, _) = call(
            &app,
            ana,
            Method::POST,
            &format!("/notifications/{old_id}/read"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        assert_eq!(notices(&app, ana).await.len(), 1);
        let (s, _) = call(
            &app,
            owner,
            Method::DELETE,
            &format!("/collections/{cid}/members/{ana}"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert!(notices(&app, ana).await.is_empty());
        // Listing dropped it from the table too.
        let stored: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM notifications WHERE user_id = $1")
                .bind(ana)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(stored, 0);
    }

    #[tokio::test]
    async fn a_direct_share_is_a_notice_and_a_collection_share_is_not() {
        let (app, db, _g) = app().await;
        let (owner, ana, beto) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
            create_user(&db, "team_lite").await,
        );
        let t = team(&db, owner, &[ana, beto]).await;
        let item = Uuid::new_v4();
        sqlx::query("INSERT INTO vault_items (id, owner_id, encrypted_item) VALUES ($1, $2, 'x')")
            .bind(item)
            .bind(owner)
            .execute(&db)
            .await
            .unwrap();
        let cid = Uuid::new_v4();
        call(
            &app,
            owner,
            Method::POST,
            &format!("/teams/{t}/collections"),
            Some(json!({ "id": cid, "encrypted_name": "n", "wrapped_key": "k" })),
        )
        .await;
        call(
            &app,
            owner,
            Method::PUT,
            &format!("/collections/{cid}/members/{beto}"),
            Some(json!({ "role": "view", "wrapped_key": "k-beto" })),
        )
        .await;
        let beto_before = notices(&app, beto).await.len();

        let sid = Uuid::new_v4();
        let record = json!({ "v": 2, "key": { "iv": "aXY=", "ct": "a2V5" }, "data": { "iv": "aXY=", "ct": "x" } });
        let (s, _) = call(
            &app,
            owner,
            Method::POST,
            "/shares",
            Some(json!({
                "id": sid, "item_id": item, "whole": true, "record": record,
                "grants": [
                    // Named twice: one notice, with the role stored.
                    { "user_id": ana, "role": "edit", "wrapped_key": "k0" },
                    { "user_id": ana, "role": "view", "wrapped_key": "k1" },
                    { "collection_id": cid, "role": "view", "wrapped_key": "k2" },
                ],
            })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let list = notices(&app, ana).await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["kind"], "item_shared");
        assert_eq!(list[0]["role"], "view");
        assert_eq!(list[0]["target_id"], json!(sid));
        // Through the collection: nothing new for its members.
        assert_eq!(notices(&app, beto).await.len(), beto_before);

        // Changing her grant isn't news; a new direct grant is.
        call(
            &app,
            owner,
            Method::PUT,
            &format!("/shares/{sid}/grants"),
            Some(json!({ "user_id": ana, "role": "edit", "wrapped_key": "k1" })),
        )
        .await;
        assert_eq!(notices(&app, ana).await.len(), 1);
        let (s, _) = call(
            &app,
            owner,
            Method::PUT,
            &format!("/shares/{sid}/grants"),
            Some(json!({ "user_id": beto, "role": "view", "wrapped_key": "k3" })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(notices(&app, beto).await.len(), beto_before + 1);

        // Her grant removed: the notice goes.
        let (s, _) = call(
            &app,
            owner,
            Method::DELETE,
            &format!("/shares/{sid}/grants?user_id={ana}"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert!(notices(&app, ana).await.is_empty());
    }

    async fn invite(db: &sqlx::PgPool, team_id: Uuid, by: Uuid, email: &str) -> String {
        let token = Uuid::new_v4().simple().to_string();
        sqlx::query("INSERT INTO pending_invites (email, team_id, invited_by, token) VALUES ($1, $2, $3, $4)")
            .bind(email).bind(team_id).bind(by).bind(&token).execute(db).await.unwrap();
        token
    }

    #[tokio::test]
    async fn an_existing_account_sees_its_invitation_and_accepts_or_declines_it() {
        let (app, db, _g) = app().await;
        let (owner, ana, beto) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "free").await,
            create_user(&db, "free").await,
        );
        set_email(&db, owner, "owner@acme.io").await;
        let t = team(&db, owner, &[]).await;
        let to_ana = invite(&db, t, owner, "ana@x.io").await;
        let to_beto = invite(&db, t, owner, "Beto@x.io").await;

        // Signing in doesn't accept it: the account existed before the invite.
        let (s, _) = call_with_email(
            &app,
            ana,
            Some("ana@x.io"),
            Method::POST,
            "/auth/sync-user",
            Some(json!({})),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let list = invites(&app, ana, "ana@x.io").await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["token"], to_ana);
        assert_eq!(list[0]["team_name"], "Acme");
        assert_eq!(list[0]["inviter"], "owner@acme.io");
        // Only the invitee sees it.
        assert!(invites(&app, beto, "beto@x.io")
            .await
            .iter()
            .all(|i| i["token"] != to_ana));

        // Someone else can't decline it.
        let (s, _) = call_with_email(
            &app,
            beto,
            Some("beto@x.io"),
            Method::POST,
            &format!("/teams/decline/{to_ana}"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);

        let (s, _) = call_with_email(
            &app,
            ana,
            Some("ana@x.io"),
            Method::POST,
            &format!("/teams/accept/{to_ana}"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert!(invites(&app, ana, "ana@x.io").await.is_empty());

        // Beto declines (email case doesn't matter): gone, and he's not in.
        let (s, _) = call_with_email(
            &app,
            beto,
            Some("beto@x.io"),
            Method::POST,
            &format!("/teams/decline/{to_beto}"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert!(invites(&app, beto, "beto@x.io").await.is_empty());
        let joined: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM team_members WHERE user_id = $1)")
                .bind(beto)
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(!joined);
    }

    #[tokio::test]
    async fn an_account_created_from_the_invitation_joins_on_first_sign_in() {
        let (app, db, _g) = app().await;
        let owner = create_user(&db, "team_lite").await;
        let t = team(&db, owner, &[]).await;
        invite(&db, t, owner, "new@x.io").await;
        // Make the invitation clearly older than the account about to be made.
        sqlx::query("UPDATE pending_invites SET created_at = NOW() - INTERVAL '1 minute'")
            .execute(&db)
            .await
            .unwrap();

        let newcomer = Uuid::new_v4();
        let (s, _) = call_with_email(
            &app,
            newcomer,
            Some("new@x.io"),
            Method::POST,
            "/auth/sync-user",
            Some(json!({})),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let joined: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM team_members WHERE user_id = $1 AND team_id = $2)",
        )
        .bind(newcomer)
        .bind(t)
        .fetch_one(&db)
        .await
        .unwrap();
        assert!(joined);
    }

    #[tokio::test]
    async fn a_decline_waiting_on_an_accept_finds_it_accepted() {
        let (app, db, _g) = app().await;
        let (owner, ana) = (
            create_user(&db, "team_lite").await,
            create_user(&db, "free").await,
        );
        let t = team(&db, owner, &[]).await;
        let token = invite(&db, t, owner, "ana@x.io").await;

        // An accept in progress holds the invite (as accept_invite_inner does).
        let mut accepting = db.begin().await.unwrap();
        sqlx::query("SELECT 1 FROM pending_invites WHERE token = $1 FOR UPDATE")
            .bind(&token)
            .execute(&mut *accepting)
            .await
            .unwrap();
        let decline = {
            let (app, token) = (app.clone(), token.clone());
            tokio::spawn(async move {
                call_with_email(
                    &app,
                    ana,
                    Some("ana@x.io"),
                    Method::POST,
                    &format!("/teams/decline/{token}"),
                    None,
                )
                .await
            })
        };
        crate::test_support::wait_for_lock_waits(&db, 1).await;
        sqlx::query("UPDATE pending_invites SET accepted_at = NOW() WHERE token = $1")
            .bind(&token)
            .execute(&mut *accepting)
            .await
            .unwrap();
        accepting.commit().await.unwrap();
        let (s, _) = decline.await.unwrap();
        assert_eq!(s, StatusCode::NOT_FOUND);

        // Declined first: the accept finds nothing to accept.
        let second = invite(&db, t, owner, "ana@x.io").await;
        let (s, _) = call_with_email(
            &app,
            ana,
            Some("ana@x.io"),
            Method::POST,
            &format!("/teams/decline/{second}"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let (s, _) = call_with_email(
            &app,
            ana,
            Some("ana@x.io"),
            Method::POST,
            &format!("/teams/accept/{second}"),
            None,
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
    }
}
