CREATE OR REPLACE FUNCTION trim_sync_logs()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM sync_logs
  WHERE id IN (
    SELECT id FROM sync_logs
    WHERE user_id = NEW.user_id AND device_id = NEW.device_id
    ORDER BY created_at DESC
    OFFSET 10
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sync_logs_trim
AFTER INSERT ON sync_logs
FOR EACH ROW EXECUTE FUNCTION trim_sync_logs();
