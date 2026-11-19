-- Additive schema for Cloudflare R2 hosted report and media files (HTML, images, video, audio, PDF).
CREATE TABLE IF NOT EXISTS stored_files (id TEXT PRIMARY KEY, r2_key TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', content_type TEXT NOT NULL, size INTEGER NOT NULL, uploader_id INTEGER NOT NULL, task_id INTEGER, scope TEXT NOT NULL DEFAULT 'general', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS stored_files_task ON stored_files(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stored_files_uploader ON stored_files(uploader_id, created_at DESC);
