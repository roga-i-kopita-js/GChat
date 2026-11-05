-- Run after db:migrate against the intended GChat database.
-- Directions are relative to Web using the native bridge.
-- Native loads these rules through native.bridge_policy and enforces them at the Web bridge.
-- Repeated execution adds missing defaults and preserves other operator rules.
BEGIN;

INSERT INTO gchat_native_websocket_restrictions (direction, message_pattern)
VALUES
  ('send', 'device.*'),
  ('send', 'call.*'),
  ('send', 'rtc.*'),
  ('receive', 'device.*'),
  ('receive', 'call.ice_config'),
  ('receive', 'rtc.*')
ON CONFLICT (direction, message_pattern) DO NOTHING;

COMMIT;
