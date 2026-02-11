import fs from "node:fs";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import cron from "node-cron";
import * as acme from "acme-client";
import { config, ensureDir } from "../config.js";
import { HttpError } from "../lib/httpError.js";
import { db } from "../db.js";
import { logError, logInfo } from "../lib/logger.js";
import { writeAudit } from "./auditService.js";

ensureDir(config.certsDir);

const accountKeyPath = path.join(config.certsDir, "acme-account.key");

function requireCloudflareToken() {
  if (!config.cloudflareApiToken) {
    throw new HttpError(400, "Cloudflare API Token 未配置");
  }
}

async function cfRequest(endpoint, { method = "GET", body } = {}) {
  requireCloudflareToken();
  const resp = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.cloudflareApiToken}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await resp.json();
  if (!resp.ok || data.success === false) {
    throw new HttpError(resp.status, `Cloudflare API 错误: ${JSON.stringify(data.errors || data)}`);
  }
  return data.result;
}

async function findZoneForDomain(domain) {
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i += 1) {
    const candidate = parts.slice(i).join(".");
    const zones = await cfRequest(`/zones?name=${candidate}&status=active`);
    if (Array.isArray(zones) && zones.length > 0) {
      return zones[0];
    }
  }
  throw new HttpError(400, `无法为域名 ${domain} 匹配 Cloudflare Zone`);
}

async function createDnsChallengeRecord(domain, txtValue) {
  const zone = await findZoneForDomain(domain);
  const name = `_acme-challenge.${domain}`;
  const record = await cfRequest(`/zones/${zone.id}/dns_records`, {
    method: "POST",
    body: {
      type: "TXT",
      name,
      content: txtValue,
      ttl: 120
    }
  });
  return { zoneId: zone.id, recordId: record.id };
}

async function deleteDnsRecord(zoneId, recordId) {
  await cfRequest(`/zones/${zoneId}/dns_records/${recordId}`, { method: "DELETE" });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAccountKey() {
  if (fs.existsSync(accountKeyPath)) {
    return fs.readFileSync(accountKeyPath, "utf8");
  }
  const key = await acme.crypto.createPrivateKey();
  fs.writeFileSync(accountKeyPath, key, "utf8");
  return key;
}

function certPaths(domain) {
  const safeDomain = domain.replace(/[^a-zA-Z0-9.-]/g, "_");
  const dir = path.join(config.certsDir, safeDomain);
  ensureDir(dir);
  return {
    dir,
    certPath: path.join(dir, "cert.pem"),
    keyPath: path.join(dir, "privkey.pem"),
    fullchainPath: path.join(dir, "fullchain.pem")
  };
}

function parseCertInfo(certPem) {
  const certBlock = certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  if (!certBlock) return {};
  const cert = new X509Certificate(certBlock[0]);
  return {
    validFrom: new Date(cert.validFrom).toISOString(),
    validTo: new Date(cert.validTo).toISOString(),
    issuer: cert.issuer
  };
}

function upsertCertRecord({
  domain,
  sans,
  issuer,
  certPath,
  keyPath,
  fullchainPath,
  validFrom,
  validTo,
  autoRenew = 1
}) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ssl_certs
      (domain, sans, issuer, cert_path, key_path, fullchain_path, valid_from, valid_to, last_renewed_at, auto_renew, bound_routes, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT bound_routes FROM ssl_certs WHERE domain = ?), '[]'), 'active', ?, ?)
     ON CONFLICT(domain) DO UPDATE SET
       sans = excluded.sans,
       issuer = excluded.issuer,
       cert_path = excluded.cert_path,
       key_path = excluded.key_path,
       fullchain_path = excluded.fullchain_path,
       valid_from = excluded.valid_from,
       valid_to = excluded.valid_to,
       last_renewed_at = excluded.last_renewed_at,
       auto_renew = excluded.auto_renew,
       status = 'active',
       updated_at = excluded.updated_at`
  ).run(
    domain,
    JSON.stringify(sans || []),
    issuer || "",
    certPath,
    keyPath,
    fullchainPath,
    validFrom || "",
    validTo || "",
    now,
    autoRenew ? 1 : 0,
    domain,
    now,
    now
  );
}

export function listCertificates() {
  const rows = db
    .prepare(
      "SELECT id, domain, sans, issuer, cert_path, key_path, fullchain_path, valid_from, valid_to, last_renewed_at, auto_renew, bound_routes, status, created_at, updated_at FROM ssl_certs ORDER BY id DESC"
    )
    .all();

  return rows.map((r) => ({
    ...r,
    sans: safeJsonParse(r.sans, []),
    bound_routes: safeJsonParse(r.bound_routes, [])
  }));
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function getCertById(id) {
  const row = db
    .prepare(
      "SELECT id, domain, sans, issuer, cert_path, key_path, fullchain_path, valid_from, valid_to, last_renewed_at, auto_renew, bound_routes, status, created_at, updated_at FROM ssl_certs WHERE id = ?"
    )
    .get(id);
  if (!row) throw new HttpError(404, "证书不存在");
  return row;
}

export async function issueCertificate({ domain, sans = [], email = "", autoRenew = true }) {
  requireCloudflareToken();
  if (!domain) throw new HttpError(400, "domain 必填");

  const finalSans = Array.from(new Set([domain, ...sans].filter(Boolean)));
  const accountKey = await getAccountKey();
  const client = new acme.Client({
    directoryUrl: config.acmeDirectory,
    accountKey
  });

  try {
    await client.createAccount({
      termsOfServiceAgreed: true,
      contact: email || config.acmeEmail ? [`mailto:${email || config.acmeEmail}`] : undefined
    });
  } catch {
    // account already exists
  }

  const [privateKey, csr] = await acme.crypto.createCsr({
    commonName: domain,
    altNames: finalSans
  });

  const dnsRecords = new Map();

  const cert = await client.auto({
    csr,
    email: email || config.acmeEmail || undefined,
    termsOfServiceAgreed: true,
    challengePriority: ["dns-01"],
    challengeCreateFn: async (authz, _challenge, keyAuthorization) => {
      const txtValue = await acme.crypto.createDigest(keyAuthorization);
      const record = await createDnsChallengeRecord(authz.identifier.value, txtValue);
      dnsRecords.set(authz.identifier.value, record);
      await sleep(15000);
    },
    challengeRemoveFn: async (authz) => {
      const record = dnsRecords.get(authz.identifier.value);
      if (record) {
        await deleteDnsRecord(record.zoneId, record.recordId);
      }
    }
  });

  const { certPath, keyPath, fullchainPath } = certPaths(domain);
  fs.writeFileSync(keyPath, privateKey, "utf8");
  fs.writeFileSync(certPath, cert, "utf8");
  fs.writeFileSync(fullchainPath, cert, "utf8");

  const certInfo = parseCertInfo(cert);
  upsertCertRecord({
    domain,
    sans: finalSans,
    issuer: certInfo.issuer,
    certPath,
    keyPath,
    fullchainPath,
    validFrom: certInfo.validFrom,
    validTo: certInfo.validTo,
    autoRenew: autoRenew ? 1 : 0
  });

  writeAudit({
    action: "ssl_issue",
    actor: "system",
    target: domain,
    status: "ok",
    detail: `issued via cloudflare dns-01`
  });

  return {
    domain,
    sans: finalSans,
    certPath,
    keyPath,
    fullchainPath,
    ...certInfo
  };
}

export async function renewCertificateById(id) {
  const cert = getCertById(id);
  const sans = safeJsonParse(cert.sans, []).filter((d) => d !== cert.domain);
  return issueCertificate({ domain: cert.domain, sans, autoRenew: cert.auto_renew === 1 });
}

export function bindCertificateRoutes(id, routes = []) {
  const cert = getCertById(id);
  const cleaned = Array.from(new Set((routes || []).map((r) => String(r).trim()).filter(Boolean)));
  db.prepare("UPDATE ssl_certs SET bound_routes = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(cleaned),
    new Date().toISOString(),
    cert.id
  );
  return { id: cert.id, boundRoutes: cleaned };
}

export function deleteCertificate(id) {
  const cert = getCertById(id);
  db.prepare("UPDATE ssl_certs SET status = 'deleted', updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id
  );
  return { ok: true };
}

export function readCertificateFile(id, type) {
  const cert = getCertById(id);
  const mapping = {
    cert: cert.cert_path,
    key: cert.key_path,
    fullchain: cert.fullchain_path
  };
  const filePath = mapping[type];
  if (!filePath || !fs.existsSync(filePath)) {
    throw new HttpError(404, "证书文件不存在");
  }
  return {
    filename: `${cert.domain}.${type}.pem`,
    content: fs.readFileSync(filePath, "utf8")
  };
}

async function runAutoRenew() {
  const certs = listCertificates().filter((c) => c.status === "active" && c.auto_renew === 1);
  const now = Date.now();

  for (const cert of certs) {
    try {
      if (!cert.valid_to) continue;
      const expiresInMs = new Date(cert.valid_to).getTime() - now;
      const days = expiresInMs / (1000 * 60 * 60 * 24);
      if (days > 20) continue;
      await renewCertificateById(cert.id);
      logInfo("ssl_auto_renew_success", { domain: cert.domain });
    } catch (err) {
      logError("ssl_auto_renew_failed", err, { domain: cert.domain });
      writeAudit({
        action: "ssl_auto_renew",
        actor: "system",
        target: cert.domain,
        status: "failed",
        detail: err.message
      });
    }
  }
}

export function startAutoRenewScheduler() {
  cron.schedule("0 3 * * *", runAutoRenew, { timezone: config.timezone });
}
