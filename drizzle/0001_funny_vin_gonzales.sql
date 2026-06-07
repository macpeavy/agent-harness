CREATE TABLE `chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`feature_id` text NOT NULL,
	`surface` text NOT NULL,
	`intent` text NOT NULL,
	`contract` text NOT NULL,
	`acceptance` text NOT NULL,
	`data_shapes` text,
	`pre_resolved` text,
	`out_of_scope` text,
	`tier_hint` text DEFAULT 'cheap' NOT NULL,
	`state` text DEFAULT 'planned' NOT NULL,
	`dispatch_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dispatch_id`) REFERENCES `dispatches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `edges` (
	`id` text PRIMARY KEY NOT NULL,
	`feature_id` text NOT NULL,
	`from_chunk_id` text NOT NULL,
	`to_chunk_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_chunk_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_chunk_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `edges_from_to_unq` ON `edges` (`from_chunk_id`,`to_chunk_id`);--> statement-breakpoint
CREATE TABLE `features` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`state` text DEFAULT 'planning' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
