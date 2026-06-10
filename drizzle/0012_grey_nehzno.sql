CREATE TABLE `driver_heartbeats` (
	`driver` text PRIMARY KEY NOT NULL,
	`pid` integer NOT NULL,
	`interval_ms` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`started_at` integer NOT NULL
);
