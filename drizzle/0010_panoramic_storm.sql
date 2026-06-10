CREATE TABLE `chief_registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`base_url` text NOT NULL,
	`registered_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `signaled_at` integer;