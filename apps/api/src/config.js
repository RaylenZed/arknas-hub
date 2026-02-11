import fs from "node:fs";
import path from "node:path";

function readSecretFromFile(filePath) {
  if (!filePath) return "";
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

const cloudflareTokenFromFile = readSecretFromFile(process.env.CLOUDFLARE_API_TOKEN_FILE);

export const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 8081),
  dbPath: process.env.ARKNAS_DB_PATH || path.resolve(process.cwd(), "data/sqlite/arknas.db"),
  jwtSecret: process.env.JWT_SECRET || "please-change-this-secret",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "12h",
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "admin123456",
  dockerHost: process.env.DOCKER_HOST || "tcp://docker-proxy:2375",
  jellyfinBaseUrl: process.env.JELLYFIN_BASE_URL || "",
  jellyfinApiKey: process.env.JELLYFIN_API_KEY || "",
  jellyfinUserId: process.env.JELLYFIN_USER_ID || "",
  qbBaseUrl: process.env.QBIT_BASE_URL || "",
  qbUsername: process.env.QBIT_USERNAME || "",
  qbPassword: process.env.QBIT_PASSWORD || "",
  certsDir: process.env.CERTS_DIR || path.resolve(process.cwd(), "data/certs"),
  acmeEmail: process.env.ACME_EMAIL || "",
  acmeDirectory:
    process.env.ACME_DIRECTORY ||
    "https://acme-v02.api.letsencrypt.org/directory",
  cloudflareApiToken:
    process.env.CLOUDFLARE_API_TOKEN || cloudflareTokenFromFile || "",
  proxyPublicPort: Number(process.env.PUBLIC_PORT || 24443),
  timezone: process.env.TZ || "Asia/Shanghai"
};

export function ensureDir(dirPath) {
  fs.mkdirSync(path.resolve(dirPath), { recursive: true });
}
