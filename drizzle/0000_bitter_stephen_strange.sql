CREATE TABLE `dispatches` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`title` text NOT NULL,
	`branch` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`build_session_id` text,
	`review_session_id` text,
	`pr_url` text,
	`route` text,
	`amend_rounds` integer DEFAULT 0 NOT NULL,
	`escalated` text,
	`build_cost_usd` real,
	`review_cost_usd` real,
	`amend_cost_usd` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
