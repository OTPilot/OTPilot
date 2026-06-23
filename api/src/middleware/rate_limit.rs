//! Minimal in-process fixed-window rate limiter.
//!
//! Keyed by an arbitrary string (e.g. "totp:<user_id>"). Each key gets a window
//! start + hit count; once the window elapses the counter resets. This is
//! per-process — behind multiple API instances the effective limit is multiplied
//! by the instance count, which is an acceptable bound for the abuse it guards
//! against (runaway code generation, invite-email spam). No external dependency.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct RateLimiter {
    inner: Mutex<HashMap<String, (Instant, u32)>>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Records a hit for `key`. Returns `true` while at or under `max` hits within
    /// `window`, `false` once the limit is exceeded.
    pub fn check(&self, key: &str, max: u32, window: Duration) -> bool {
        let now = Instant::now();
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());

        // Opportunistic cleanup so the map can't grow unboundedly: when it gets
        // large, drop every entry whose window has already elapsed.
        if map.len() > 10_000 {
            map.retain(|_, (start, _)| now.duration_since(*start) <= window);
        }

        let entry = map.entry(key.to_string()).or_insert((now, 0));
        if now.duration_since(entry.0) > window {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= max
    }
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_max_then_blocks() {
        let rl = RateLimiter::new();
        let win = Duration::from_secs(60);
        for _ in 0..3 {
            assert!(rl.check("k", 3, win));
        }
        // 4th hit in the same window is blocked.
        assert!(!rl.check("k", 3, win));
    }

    #[test]
    fn separate_keys_are_independent() {
        let rl = RateLimiter::new();
        let win = Duration::from_secs(60);
        assert!(rl.check("a", 1, win));
        assert!(!rl.check("a", 1, win));
        // Different key has its own budget.
        assert!(rl.check("b", 1, win));
    }
}
