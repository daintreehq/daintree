-- Decisions 0.4.0 thread messages (#16229): the library's QuestionRow keeps a question's follow-up messages beside its answers, each sealed, and an injection intent names the follow-up it typed, or none for an answer. Every intent written before this one was an answer's. The same columns the library's own SQLite store adds in its "thread messages and message intents" step.
ALTER TABLE `decisions_questions` ADD COLUMN `messages_json` text NOT NULL DEFAULT '[]';--> statement-breakpoint
ALTER TABLE `decisions_injection_intents` ADD COLUMN `message_id` text;
