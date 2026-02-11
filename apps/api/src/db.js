import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import path from "node:path";
import { config, ensureDir } from "./config.js";

ensureDir(path.dirname(config.dbPath));

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  target TEXT,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ssl_certs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT UNIQUE NOT NULL,
  sans TEXT,
  issuer TEXT,
  cert_path TEXT,
  key_path TEXT,
  fullchain_path TEXT,
  valid_from TEXT,
  valid_to TEXT,
  last_renewed_at TEXT,
  auto_renew INTEGER NOT NULL DEFAULT 1,
  bound_routes TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

function seedDefaultAdmin() {
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(config.adminUsername);
  if (existing) return;
  const now = new Date().toISOString();
  const passwordHash = bcrypt.hashSync(config.adminPassword, 10);
  db.prepare(
    "INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, 'admin', ?, ?)"
  ).run(config.adminUsername, passwordHash, now, now);
}

seedDefaultAdmin();

export { db };
