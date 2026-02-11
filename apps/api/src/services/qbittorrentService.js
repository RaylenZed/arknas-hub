import { HttpError } from "../lib/httpError.js";
import { getRawIntegrationConfig } from "./settingsService.js";

class QBClient {
  constructor() {
    this.cookie = "";
    this.lastLoginAt = 0;
  }

  getConfig() {
    const cfg = getRawIntegrationConfig();
    return {
      baseUrl: (cfg.qbBaseUrl || "").replace(/\/$/, ""),
      username: cfg.qbUsername || "",
      password: cfg.qbPassword || ""
    };
  }

  ensureConfigured() {
    const cfg = this.getConfig();
    if (!cfg.baseUrl || !cfg.username || !cfg.password) {
      throw new HttpError(400, "qBittorrent 未配置，请先在设置中填写地址、用户名和密码");
    }
    return cfg;
  }

  async login(force = false) {
    const cfg = this.ensureConfigured();
    const now = Date.now();

    if (!force && this.cookie && now - this.lastLoginAt < 10 * 60 * 1000) {
      return;
    }

    const resp = await fetch(`${cfg.baseUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: cfg.username, password: cfg.password }).toString()
    });

    if (!resp.ok) {
      throw new HttpError(resp.status, "qBittorrent 登录失败");
    }

    const setCookie = resp.headers.get("set-cookie") || "";
    if (!setCookie.includes("SID=")) {
      throw new HttpError(401, "qBittorrent 登录失败，未获取到会话 Cookie");
    }

    this.cookie = setCookie.split(";")[0];
    this.lastLoginAt = now;
  }

  async request(path, { method = "GET", form, query } = {}) {
    await this.login();
    const cfg = this.ensureConfigured();

    const url = new URL(`${cfg.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }

    const options = {
      method,
      headers: {
        Cookie: this.cookie
      }
    };

    if (form instanceof FormData) {
      options.body = form;
    } else if (form) {
      options.headers["Content-Type"] = "application/x-www-form-urlencoded";
      options.body = new URLSearchParams(form).toString();
    }

    let resp = await fetch(url, options);

    if (resp.status === 403 || resp.status === 401) {
      await this.login(true);
      options.headers.Cookie = this.cookie;
      resp = await fetch(url, options);
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new HttpError(resp.status, `qBittorrent 请求失败: ${text || resp.statusText}`);
    }

    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      return resp.json();
    }
    return resp.text();
  }
}

const qb = new QBClient();

export async function getDownloadSummary() {
  const [transfer, maindata] = await Promise.all([
    qb.request("/api/v2/transfer/info"),
    qb.request("/api/v2/sync/maindata")
  ]);

  const torrents = maindata?.torrents ? Object.values(maindata.torrents) : [];
  const downloading = torrents.filter((t) => String(t.state).includes("downloading")).length;
  const seeding = torrents.filter((t) => String(t.state).includes("upload") || String(t.state).includes("seed")).length;
  const completed = torrents.filter((t) => t.progress >= 1).length;

  return {
    transfer,
    summary: {
      downloading,
      seeding,
      completed,
      dlSpeed: transfer?.dl_info_speed || 0,
      upSpeed: transfer?.up_info_speed || 0
    }
  };
}

export async function listTasks(filter = "all") {
  return qb.request("/api/v2/torrents/info", { query: { filter } });
}

export async function addMagnet(urls, savepath = "") {
  return qb.request("/api/v2/torrents/add", {
    method: "POST",
    form: { urls, savepath }
  });
}

export async function addTorrentFile(file, savepath = "") {
  const form = new FormData();
  form.append("savepath", savepath);
  form.append("torrents", new Blob([file.buffer]), file.originalname);
  return qb.request("/api/v2/torrents/add", {
    method: "POST",
    form
  });
}

export async function pauseTasks(hashes) {
  return qb.request("/api/v2/torrents/pause", {
    method: "POST",
    form: { hashes }
  });
}

export async function resumeTasks(hashes) {
  return qb.request("/api/v2/torrents/resume", {
    method: "POST",
    form: { hashes }
  });
}

export async function deleteTasks(hashes, deleteFiles = false) {
  return qb.request("/api/v2/torrents/delete", {
    method: "POST",
    form: {
      hashes,
      deleteFiles: deleteFiles ? "true" : "false"
    }
  });
}

export async function listRecentCompleted(limit = 20) {
  const tasks = await listTasks("completed");
  return tasks
    .slice()
    .sort((a, b) => (b.completion_on || 0) - (a.completion_on || 0))
    .slice(0, limit);
}
