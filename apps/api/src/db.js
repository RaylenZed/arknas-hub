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

CREATE TABLE IF NOT EXISTS app_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  error_detail TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS user_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, group_id)
);

CREATE TABLE IF NOT EXISTS ddns_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  domain TEXT NOT NULL,
  ip_address TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unknown',
  config_json TEXT NOT NULL DEFAULT '{}',
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_quotas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  mount_path TEXT NOT NULL,
  quota_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, mount_path)
);

CREATE TABLE IF NOT EXISTS storage_spaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  mount_path TEXT NOT NULL,
  fs_type TEXT NOT NULL DEFAULT 'bind',
  total_bytes INTEGER NOT NULL DEFAULT 0,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  cache_mode TEXT NOT NULL DEFAULT 'off',
  status TEXT NOT NULL DEFAULT 'normal',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS network_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  iface TEXT UNIQUE NOT NULL,
  ipv4_mode TEXT NOT NULL DEFAULT 'dhcp',
  ipv4_address TEXT NOT NULL DEFAULT '',
  ipv4_netmask TEXT NOT NULL DEFAULT '',
  ipv4_gateway TEXT NOT NULL DEFAULT '',
  ipv4_dns TEXT NOT NULL DEFAULT '',
  ipv6_mode TEXT NOT NULL DEFAULT 'disabled',
  ipv6_address TEXT NOT NULL DEFAULT '',
  ipv6_prefix INTEGER NOT NULL DEFAULT 64,
  ipv6_gateway TEXT NOT NULL DEFAULT '',
  mtu INTEGER NOT NULL DEFAULT 1500,
  apply_last_status TEXT NOT NULL DEFAULT 'unknown',
  apply_last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS external_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'link',
  source_path TEXT NOT NULL,
  token TEXT NOT NULL,
  access_url TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  path TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'rw',
  visibility TEXT NOT NULL DEFAULT 'all-users',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(app_id, path)
);

CREATE TABLE IF NOT EXISTS compose_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  project_path TEXT NOT NULL,
  compose_file TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'inline',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("app_tasks", "log_text", "TEXT NOT NULL DEFAULT ''");
ensureColumn("app_tasks", "options_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("app_tasks", "retried_from", "INTEGER");

function seedDefaultAdmin() {
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(config.adminUsername);
  if (existing) return;
  const now = new Date().toISOString();
  const passwordHash = bcrypt.hashSync(config.adminPassword, 10);
  db.prepare(
    "INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, 'admin', ?, ?)"
  ).run(config.adminUsername, passwordHash, now, now);
}

function seedDefaultGroups() {
  const now = new Date().toISOString();
  const upsertGroup = db.prepare(
    "INSERT INTO user_groups (name, description, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at"
  );
  upsertGroup.run("Administrators", "default administrator group", now, now);
  upsertGroup.run("Users", "default user group", now, now);

  const admin = db.prepare("SELECT id FROM users WHERE username = ?").get(config.adminUsername);
  const administratorsGroup = db.prepare("SELECT id FROM user_groups WHERE name = 'Administrators'").get();
  if (admin && administratorsGroup) {
    db.prepare(
      "INSERT OR IGNORE INTO user_group_members (user_id, group_id, created_at) VALUES (?, ?, ?)"
    ).run(admin.id, administratorsGroup.id, now);
  }
}

function seedDefaultStorageSpaces() {
  const now = new Date().toISOString();
  const rows = [
    { name: "media", mountPath: config.mediaPath },
    { name: "downloads", mountPath: config.downloadsPath },
    { name: "docker-data", mountPath: config.dockerDataPath }
  ];
  const upsert = db.prepare(
    `INSERT INTO storage_spaces (name, mount_path, fs_type, total_bytes, used_bytes, cache_mode, status, created_at, updated_at)
     VALUES (?, ?, 'bind', 0, 0, 'off', 'normal', ?, ?)
     ON CONFLICT(name) DO UPDATE SET mount_path = excluded.mount_path, updated_at = excluded.updated_at`
  );
  for (const row of rows) {
    upsert.run(row.name, row.mountPath, now, now);
  }
}

seedDefaultAdmin();
seedDefaultGroups();
seedDefaultStorageSpaces();

export { db };
