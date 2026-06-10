ALTER TABLE `sessions` ADD `ci_failed_sha` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `ci_failed_checks` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `ci_signaled_sha` text;