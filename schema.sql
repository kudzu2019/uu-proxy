CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, auth_hash TEXT NOT NULL, server_salt TEXT NOT NULL, token TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);
