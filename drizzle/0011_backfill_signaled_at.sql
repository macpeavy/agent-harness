-- Backfill signaled_at for sessions already sitting in a signalling state (ADR 0024).
-- The notify pass selects on `signaled_at IS NULL`; without this stamp, the first tick
-- after deploy would fire a signal for every PRE-EXISTING review / needs-attention / done
-- session — replaying history as if it just happened. Stamping them with their own
-- updated_at says "already known"; only transitions from here on signal.
UPDATE `sessions` SET `signaled_at` = `updated_at` WHERE `state` IN ('review', 'needs-attention', 'done') AND `signaled_at` IS NULL;
