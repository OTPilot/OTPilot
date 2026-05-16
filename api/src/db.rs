use sqlx::PgPool;

pub async fn connect() -> anyhow::Result<PgPool> {
    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let pool = PgPool::connect(&url).await?;
    Ok(pool)
}
