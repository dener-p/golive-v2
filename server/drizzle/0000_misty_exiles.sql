CREATE TABLE `helper_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`username` text NOT NULL,
	`avatar` text,
	`device_name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`room_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`host_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`turn_urls` text,
	`turn_username` text,
	`turn_credential` text
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`username` text NOT NULL,
	`avatar` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
