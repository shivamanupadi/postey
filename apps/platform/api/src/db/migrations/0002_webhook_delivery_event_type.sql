-- The deliveries log stored only an opaque event id; store the event type so
-- the dashboard can show what was delivered. Old rows read as NULL.
ALTER TABLE webhook_deliveries ADD COLUMN event_type TEXT;
