import { db } from "../db.js";
import { config } from "../config.js";

const INTEGRATION_KEYS = [
  "jellyfinBaseUrl",
  "jellyfinApiKey",
  "jellyfinUserId",
  "qbBaseUrl",
  "qbUsername",
  "qbPassword"
];

function getSetting(key, fallback = "") {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

export function getIntegrations() {
  return {
    jellyfinBaseUrl: getSetting("jellyfinBaseUrl", config.jellyfinBaseUrl),
    jellyfinApiKey: getSetting("jellyfinApiKey", config.jellyfinApiKey),
    jellyfinUserId: getSetting("jellyfinUserId", config.jellyfinUserId),
    qbBaseUrl: getSetting("qbBaseUrl", config.qbBaseUrl),
    qbUsername: getSetting("qbUsername", config.qbUsername),
    qbPassword: getSetting("qbPassword", config.qbPassword ? "******" : "")
  };
}

export function getRawIntegrationConfig() {
  return {
    jellyfinBaseUrl: getSetting("jellyfinBaseUrl", config.jellyfinBaseUrl),
    jellyfinApiKey: getSetting("jellyfinApiKey", config.jellyfinApiKey),
    jellyfinUserId: getSetting("jellyfinUserId", config.jellyfinUserId),
    qbBaseUrl: getSetting("qbBaseUrl", config.qbBaseUrl),
    qbUsername: getSetting("qbUsername", config.qbUsername),
    qbPassword: getSetting("qbPassword", config.qbPassword)
  };
}

export function saveIntegrations(input) {
  const now = new Date().toISOString();
  const upsert = db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  );

  for (const key of INTEGRATION_KEYS) {
    if (typeof input[key] === "undefined") continue;
    let value = String(input[key] ?? "");
    if (key === "qbPassword" && value.trim() === "******") continue;
    upsert.run(key, value, now);
  }
}
