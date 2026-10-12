-- Why people uninstall the extension: the anonymous form Chrome opens after
-- a removal (chrome.runtime.setUninstallURL → the web's /goodbye page). No
-- account, email or device identifies an answer — only the extension
-- version, how many days it was installed and the plan, from the URL.
-- Read straight from the database for now.
CREATE TABLE uninstall_feedback (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- missed_fill | missing_feature | other_manager | privacy | too_complex | broken | just_trying | other
  reason         TEXT        NOT NULL,
  -- The site it didn't work on, when that was the reason.
  site           TEXT,
  comment        TEXT,
  version        TEXT,
  days_installed INTEGER,
  plan           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX uninstall_feedback_created ON uninstall_feedback (created_at);
