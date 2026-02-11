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
  jellyfinBaseUrl: process.env.JELLYFIN_BASE_URL || "http://arknas-jellyfin:8096",
  jellyfinApiKey: process.env.JELLYFIN_API_KEY || "",
  jellyfinUserId: process.env.JELLYFIN_USER_ID || "",
  qbBaseUrl: process.env.QBIT_BASE_URL || "http://arknas-qbittorrent:18080",
  qbUsername: process.env.QBIT_USERNAME || "admin",
  qbPassword: process.env.QBIT_PASSWORD || "adminadmin",
  mediaPath: process.env.MEDIA_PATH || "/srv/media",
  downloadsPath: process.env.DOWNLOADS_PATH || "/srv/downloads",
  dockerDataPath: process.env.DOCKER_DATA_PATH || "/srv/docker",
  jellyfinHostPort: Number(process.env.JELLYFIN_HOST_PORT || 18096),
  qbWebPort: Number(process.env.QBIT_WEB_PORT || 18080),
  qbPeerPort: Number(process.env.QBIT_PEER_PORT || 16881),
  portainerHostPort: Number(process.env.PORTAINER_HOST_PORT || 19000),
  watchtowerInterval: Number(process.env.WATCHTOWER_INTERVAL || 86400),
  internalNetwork: process.env.ARKNAS_INTERNAL_NETWORK || "arknas-hub_arknas_internal",
  certsDir: process.env.CERTS_DIR || path.resolve(process.cwd(), "data/certs"),
  acmeEmail: process.env.ACME_EMAIL || "",
  acmeDirectory:
    process.env.ACME_DIRECTORY ||
    "https://acme-v02.api.letsencrypt.org/directory",
  cloudflareApiToken:
    process.env.CLOUDFLARE_API_TOKEN || cloudflareTokenFromFile || "",
  proxyPublicPort: Number(process.env.PUBLIC_PORT || 24443),
  forceHttpsAuth: String(process.env.FORCE_HTTPS_AUTH || "1") === "1",
  allowPlainLoginPayload: String(process.env.ALLOW_PLAINTEXT_LOGIN || "0") === "1",
  composeProjectsDir: process.env.COMPOSE_PROJECTS_DIR || path.resolve(process.cwd(), "data/compose-projects"),
  allowHostServiceControl: String(process.env.ARKNAS_ALLOW_HOST_SERVICE_CONTROL || "1") === "1",
  allowHostNetworkApply: String(process.env.ARKNAS_ALLOW_HOST_NETWORK_APPLY || "1") === "1",
  hostExecMode: process.env.ARKNAS_HOST_EXEC_MODE || "nsenter",
  timezone: process.env.TZ || "Asia/Shanghai"
};

export function ensureDir(dirPath) {
  fs.mkdirSync(path.resolve(dirPath), { recursive: true });
}
