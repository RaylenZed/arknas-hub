import { db } from "../db.js";

export function writeAudit({ action, actor = "system", target = "", status = "ok", detail = "" }) {
  db.prepare(
    "INSERT INTO audit_logs (action, actor, target, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(action, actor, target, status, detail, new Date().toISOString());
}

export function listAuditLogs(limit = 200) {
  return db
    .prepare(
      "SELECT id, action, actor, target, status, detail, created_at FROM audit_logs ORDER BY id DESC LIMIT ?"
    )
    .all(limit);
}
