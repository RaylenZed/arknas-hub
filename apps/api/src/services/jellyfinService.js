import { getRawIntegrationConfig } from "./settingsService.js";
import { HttpError } from "../lib/httpError.js";

function getJellyfinConfig() {
  const cfg = getRawIntegrationConfig();
  return {
    baseUrl: (cfg.jellyfinBaseUrl || "").replace(/\/$/, ""),
    apiKey: cfg.jellyfinApiKey || "",
    userId: cfg.jellyfinUserId || ""
  };
}

function isConfigured(cfg) {
  return Boolean(cfg.baseUrl && cfg.apiKey && cfg.userId);
}

function ensureConfigured() {
  const cfg = getJellyfinConfig();
  if (!cfg.baseUrl || !cfg.apiKey) {
    throw new HttpError(400, "Jellyfin 未配置，请先在设置中填写地址和 API Key");
  }
  return cfg;
}

async function jellyfinFetch(path, { method = "GET", query = {}, body } = {}) {
  const cfg = ensureConfigured();
  const url = new URL(`${cfg.baseUrl}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (typeof v !== "undefined" && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }

  const resp = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Emby-Token": cfg.apiKey
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new HttpError(resp.status, `Jellyfin 请求失败: ${text || resp.statusText}`);
  }

  if (resp.status === 204) return null;
  return resp.json();
}

function withImageUrl(baseUrl, item) {
  const imageTag = item.ImageTags?.Primary || item.PrimaryImageTag || "";
  const imageUrl = imageTag
    ? `${baseUrl}/Items/${item.Id}/Images/Primary?quality=90&tag=${imageTag}`
    : "";
  return { ...item, imageUrl };
}

export async function getContinueWatching(limit = 12) {
  const cfg = ensureConfigured();
  const uid = cfg.userId;
  let items;

  try {
    items = await jellyfinFetch("/UserItems/Resume", {
      query: { UserId: uid, Limit: limit, Fields: "PrimaryImageAspectRatio,UserData" }
    });
  } catch {
    items = await jellyfinFetch(`/Users/${uid}/Items/Resume`, {
      query: { Limit: limit, Fields: "PrimaryImageAspectRatio,UserData" }
    });
  }

  const list = items.Items || items || [];
  return list.map((item) => withImageUrl(cfg.baseUrl, item));
}

export async function getLatestItems(limit = 20) {
  const cfg = ensureConfigured();
  const uid = cfg.userId;
  let items;

  try {
    items = await jellyfinFetch("/Items/Latest", {
      query: { UserId: uid, Limit: limit }
    });
  } catch {
    items = await jellyfinFetch(`/Users/${uid}/Items/Latest`, { query: { Limit: limit } });
  }

  const list = items.Items || items || [];
  return list.map((item) => withImageUrl(cfg.baseUrl, item));
}

export async function getActiveSessions() {
  return jellyfinFetch("/Sessions");
}

export async function refreshLibrary() {
  await jellyfinFetch("/Library/Refresh", { method: "POST" });
  return { ok: true };
}

export async function listMediaLibrary({ types = "", searchTerm = "", limit = 60, startIndex = 0 } = {}) {
  const cfg = getJellyfinConfig();
  if (!isConfigured(cfg)) {
    return {
      configured: false,
      items: [],
      total: 0,
      reason: "Jellyfin 未完成配置（需 baseUrl、API Key、User ID）"
    };
  }

  const includeItemTypes = String(types || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(",");

  try {
    const data = await jellyfinFetch("/Users/" + cfg.userId + "/Items", {
      query: {
        Recursive: true,
        IncludeItemTypes: includeItemTypes || undefined,
        SearchTerm: searchTerm || undefined,
        SortBy: "DateCreated,SortName",
        SortOrder: "Descending",
        Limit: Math.min(120, Math.max(1, Number(limit) || 60)),
        StartIndex: Math.max(0, Number(startIndex) || 0),
        Fields: "PrimaryImageAspectRatio,Overview,DateCreated"
      }
    });

    const items = (data.Items || []).map((item) => withImageUrl(cfg.baseUrl, item));
    return {
      configured: true,
      items,
      total: Number(data.TotalRecordCount || items.length)
    };
  } catch (err) {
    return {
      configured: false,
      items: [],
      total: 0,
      reason: `Jellyfin 连接失败：${err.message}`
    };
  }
}

export async function getMediaSummary() {
  const cfg = getJellyfinConfig();
  if (!isConfigured(cfg)) {
    return {
      configured: false,
      continueWatching: [],
      latest: [],
      sessions: [],
      summary: {
        activeSessions: 0,
        continueCount: 0,
        latestCount: 0
      },
      reason: "Jellyfin 未完成配置（需 baseUrl、API Key、User ID）"
    };
  }

  let continueWatching;
  let latest;
  let sessions;
  try {
    [continueWatching, latest, sessions] = await Promise.all([
      getContinueWatching(8),
      getLatestItems(12),
      getActiveSessions()
    ]);
  } catch (err) {
    return {
      configured: false,
      continueWatching: [],
      latest: [],
      sessions: [],
      summary: {
        activeSessions: 0,
        continueCount: 0,
        latestCount: 0
      },
      reason: `Jellyfin 连接失败：${err.message}`
    };
  }

  return {
    configured: true,
    continueWatching,
    latest,
    sessions,
    summary: {
      activeSessions: Array.isArray(sessions) ? sessions.length : 0,
      continueCount: continueWatching.length,
      latestCount: latest.length
    }
  };
}
