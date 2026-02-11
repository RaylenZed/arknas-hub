import fs from "node:fs";
import path from "node:path";
import { docker } from "./dockerService.js";
import { getRawIntegrationConfig, saveIntegrations } from "./settingsService.js";
import { HttpError } from "../lib/httpError.js";
import {
  appendTaskLog,
  cloneFailedTaskAsRetry,
  createAppTask,
  getAppTaskById,
  getTaskLogs,
  listAppTasks,
  markTaskFailed,
  markTaskRunning,
  markTaskSuccess,
  updateAppTask
} from "./appTaskService.js";
import { writeAudit } from "./auditService.js";
import { config } from "../config.js";
import { db } from "../db.js";

const APP_DEFINITIONS = {
  jellyfin: {
    id: "jellyfin",
    name: "Jellyfin",
    containerName: "arknas-jellyfin",
    image: "jellyfin/jellyfin:latest",
    category: "媒体",
    description: "媒体库管理与播放服务",
    openPortKey: "jellyfinHostPort",
    openPath: "/"
  },
  qbittorrent: {
    id: "qbittorrent",
    name: "qBittorrent",
    containerName: "arknas-qbittorrent",
    image: "lscr.io/linuxserver/qbittorrent:latest",
    category: "下载",
    description: "BT 下载与做种管理",
    openPortKey: "qbWebPort",
    openPath: "/"
  },
  portainer: {
    id: "portainer",
    name: "Portainer",
    containerName: "arknas-portainer",
    image: "portainer/portainer-ce:latest",
    category: "运维",
    description: "容器可视化管理",
    openPortKey: "portainerHostPort",
    openPath: "/"
  },
  watchtower: {
    id: "watchtower",
    name: "Watchtower",
    containerName: "arknas-watchtower",
    image: "containrrr/watchtower:latest",
    category: "运维",
    description: "自动更新容器镜像",
    openPortKey: null,
    openPath: ""
  }
};

const BUNDLE_DEFINITIONS = {
  "media-stack": {
    id: "media-stack",
    name: "影视套件",
    apps: ["jellyfin", "qbittorrent", "watchtower"]
  }
};

const runningTasks = new Set();
const DEFAULT_HTTP_READY_TIMEOUT_MS = 90000;
const DEFAULT_HTTP_READY_INTERVAL_MS = 1500;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeHostPath(p) {
  return path.resolve(String(p || "").trim());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function getAppDef(appId) {
  const appDef = APP_DEFINITIONS[appId];
  if (!appDef) throw new HttpError(400, "不支持的应用");
  return appDef;
}

function getBundleDef(bundleId) {
  const bundle = BUNDLE_DEFINITIONS[bundleId];
  if (!bundle) throw new HttpError(400, "不支持的应用套件");
  return bundle;
}

async function findContainerSummaryByName(name) {
  const list = await docker.listContainers({ all: true, filters: { name: [name] } });
  return list[0] || null;
}

async function findContainerByName(name) {
  const summary = await findContainerSummaryByName(name);
  if (!summary) return null;
  return docker.getContainer(summary.Id);
}

async function readContainerHealthInfo(name) {
  const container = await findContainerByName(name);
  if (!container) return { health: "not_installed", state: "missing" };
  try {
    const inspect = await container.inspect();
    const state = inspect?.State?.Status || "unknown";
    const dockerHealth = inspect?.State?.Health?.Status;
    const health = dockerHealth || (inspect?.State?.Running ? "running" : "stopped");
    return {
      health,
      state,
      startedAt: inspect?.State?.StartedAt || "",
      error: inspect?.State?.Error || ""
    };
  } catch {
    return { health: "unknown", state: "unknown" };
  }
}

async function pullImage(image, onProgress) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(
        stream,
        (progressErr) => {
          if (progressErr) reject(progressErr);
          else resolve(true);
        },
        (event) => {
          if (onProgress) onProgress(event);
        }
      );
    });
  });
}

async function ensureManagedNetwork(taskId) {
  const network = docker.getNetwork(config.internalNetwork);
  try {
    await network.inspect();
    appendTaskLog(taskId, `网络检查通过：${config.internalNetwork}`);
    return;
  } catch (err) {
    if (err?.statusCode && err.statusCode !== 404) {
      throw err;
    }
  }

  appendTaskLog(taskId, `未找到网络 ${config.internalNetwork}，正在创建`);
  try {
    await docker.createNetwork({
      Name: config.internalNetwork,
      Driver: "bridge",
      Labels: {
        "arknas.managed": "true"
      }
    });
    appendTaskLog(taskId, `网络已创建：${config.internalNetwork}`);
  } catch (err) {
    if (String(err?.message || "").includes("already exists")) {
      appendTaskLog(taskId, `网络已存在：${config.internalNetwork}`);
      return;
    }
    throw err;
  }
}

async function ensureContainerRunning(appId, taskId, timeoutMs = 30000) {
  const appDef = getAppDef(appId);
  const deadline = Date.now() + timeoutMs;
  let lastState = "unknown";

  while (Date.now() < deadline) {
    const container = await findContainerByName(appDef.containerName);
    if (container) {
      const inspect = await container.inspect();
      const state = inspect?.State?.Status || "unknown";
      lastState = state;
      if (inspect?.State?.Running) {
        appendTaskLog(taskId, `${appDef.name} 容器运行状态正常`);
        return true;
      }
    }
    await sleep(900);
  }

  throw new HttpError(502, `${appDef.name} 启动超时，容器状态：${lastState}`);
}

async function ensureHttpReady({
  appName,
  taskId,
  host,
  port,
  paths = ["/"],
  timeoutMs = DEFAULT_HTTP_READY_TIMEOUT_MS,
  intervalMs = DEFAULT_HTTP_READY_INTERVAL_MS
}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastError = "unknown";

  while (Date.now() < deadline) {
    attempt += 1;
    for (const p of paths) {
      const url = `http://${host}:${port}${p}`;
      try {
        const res = await fetchWithTimeout(url, 3000);
        if (res.status >= 200 && res.status < 500) {
          appendTaskLog(taskId, `${appName} 就绪检查通过：${p} -> HTTP ${res.status}（第 ${attempt} 次）`);
          return true;
        }
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = err?.name === "AbortError" ? "timeout" : String(err?.message || err);
      }
    }

    if (attempt === 1 || attempt % 5 === 0) {
      appendTaskLog(taskId, `${appName} 就绪检查中（第 ${attempt} 次），最近错误：${lastError}`);
    }
    await sleep(intervalMs);
  }

  throw new HttpError(502, `${appName} 就绪检查失败：${lastError}`);
}

async function ensureDockerProxyReady(taskId) {
  try {
    const res = await fetchWithTimeout("http://docker-proxy:2375/_ping", 3000);
    const text = await res.text();
    if (!res.ok || text.trim() !== "OK") {
      throw new Error(`status=${res.status}, body=${text.slice(0, 50)}`);
    }
    appendTaskLog(taskId, "docker-proxy 连通性检查通过");
  } catch (err) {
    throw new HttpError(502, `docker-proxy 不可用：${err?.message || err}`);
  }
}

async function runPostInstallValidation(appId, taskId, cfg) {
  const appDef = getAppDef(appId);
  appendTaskLog(taskId, `${appDef.name} 启动后验收中`);
  await ensureContainerRunning(appId, taskId, 30000);

  if (appId === "watchtower") {
    await ensureDockerProxyReady(taskId);
    return { ok: true, type: "runtime" };
  }

  if (appId === "jellyfin") {
    await ensureHttpReady({
      appName: appDef.name,
      taskId,
      host: appDef.containerName,
      port: 8096,
      paths: ["/health", "/web/index.html", "/"],
      timeoutMs: 120000
    });
    return { ok: true, type: "http" };
  }

  if (appId === "qbittorrent") {
    await ensureHttpReady({
      appName: appDef.name,
      taskId,
      host: appDef.containerName,
      port: Number(cfg.qbWebPort),
      paths: ["/api/v2/app/version", "/"],
      timeoutMs: 90000
    });
    return { ok: true, type: "http" };
  }

  if (appId === "portainer") {
    await ensureHttpReady({
      appName: appDef.name,
      taskId,
      host: appDef.containerName,
      port: 9000,
      paths: ["/api/status", "/"],
      timeoutMs: 90000
    });
    return { ok: true, type: "http" };
  }

  return { ok: true, type: "runtime" };
}

function buildStatus(appDef, containerInfo, cfg) {
  if (!containerInfo) {
    return {
      ...appDef,
      installed: false,
      running: false,
      status: "not_installed",
      openUrl: appDef.openPortKey ? `http://127.0.0.1:${cfg[appDef.openPortKey]}${appDef.openPath}` : ""
    };
  }

  const state = containerInfo.State || "unknown";
  const running = state === "running";

  return {
    ...appDef,
    installed: true,
    running,
    status: running ? "running" : "stopped",
    containerId: containerInfo.Id,
    containerStatusText: containerInfo.Status,
    openUrl: appDef.openPortKey ? `http://127.0.0.1:${cfg[appDef.openPortKey]}${appDef.openPath}` : ""
  };
}

function buildCommonContainerOptions(appDef) {
  return {
    name: appDef.containerName,
    Image: appDef.image,
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: config.internalNetwork
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [config.internalNetwork]: {}
      }
    },
    Labels: {
      "arknas.managed": "true",
      "arknas.app": appDef.id
    }
  };
}

function buildJellyfinOptions(cfg) {
  const appDef = APP_DEFINITIONS.jellyfin;
  const mediaPath = normalizeHostPath(cfg.mediaPath);
  const dockerDataPath = normalizeHostPath(cfg.dockerDataPath);
  const configDir = path.join(dockerDataPath, "jellyfin", "config");
  const cacheDir = path.join(dockerDataPath, "jellyfin", "cache");

  ensureDir(mediaPath);
  ensureDir(configDir);
  ensureDir(cacheDir);

  const base = buildCommonContainerOptions(appDef);

  return {
    ...base,
    ExposedPorts: {
      "8096/tcp": {}
    },
    HostConfig: {
      ...base.HostConfig,
      Binds: [`${configDir}:/config`, `${cacheDir}:/cache`, `${mediaPath}:/media`],
      PortBindings: {
        "8096/tcp": [{ HostPort: String(cfg.jellyfinHostPort) }]
      }
    }
  };
}

function buildQBOptions(cfg) {
  const appDef = APP_DEFINITIONS.qbittorrent;
  const downloadsPath = normalizeHostPath(cfg.downloadsPath);
  const dockerDataPath = normalizeHostPath(cfg.dockerDataPath);
  const configDir = path.join(dockerDataPath, "qbittorrent", "config");
  const webPort = String(cfg.qbWebPort);
  const peerPort = String(cfg.qbPeerPort);

  ensureDir(downloadsPath);
  ensureDir(configDir);

  const base = buildCommonContainerOptions(appDef);

  return {
    ...base,
    Env: [
      `TZ=${process.env.TZ || "Asia/Shanghai"}`,
      "PUID=0",
      "PGID=0",
      `WEBUI_PORT=${webPort}`,
      `TORRENTING_PORT=${peerPort}`
    ],
    ExposedPorts: {
      [`${webPort}/tcp`]: {},
      [`${peerPort}/tcp`]: {},
      [`${peerPort}/udp`]: {}
    },
    HostConfig: {
      ...base.HostConfig,
      Binds: [`${configDir}:/config`, `${downloadsPath}:/downloads`],
      PortBindings: {
        [`${webPort}/tcp`]: [{ HostPort: webPort }],
        [`${peerPort}/tcp`]: [{ HostPort: peerPort }],
        [`${peerPort}/udp`]: [{ HostPort: peerPort }]
      }
    }
  };
}

function buildPortainerOptions(cfg) {
  const appDef = APP_DEFINITIONS.portainer;
  const dockerDataPath = normalizeHostPath(cfg.dockerDataPath);
  const dataDir = path.join(dockerDataPath, "portainer", "data");

  ensureDir(dataDir);

  const base = buildCommonContainerOptions(appDef);

  return {
    ...base,
    ExposedPorts: {
      "9000/tcp": {}
    },
    HostConfig: {
      ...base.HostConfig,
      Binds: ["/var/run/docker.sock:/var/run/docker.sock", `${dataDir}:/data`],
      PortBindings: {
        "9000/tcp": [{ HostPort: String(cfg.portainerHostPort) }]
      }
    }
  };
}

function buildWatchtowerOptions(cfg) {
  const appDef = APP_DEFINITIONS.watchtower;
  const base = buildCommonContainerOptions(appDef);

  return {
    ...base,
    Env: [
      `TZ=${process.env.TZ || "Asia/Shanghai"}`,
      `WATCHTOWER_POLL_INTERVAL=${cfg.watchtowerInterval}`,
      "WATCHTOWER_CLEANUP=true",
      "WATCHTOWER_LABEL_ENABLE=false",
      "DOCKER_HOST=tcp://docker-proxy:2375"
    ],
    Cmd: ["--cleanup", "--interval", String(cfg.watchtowerInterval)],
    HostConfig: {
      ...base.HostConfig
    }
  };
}

function buildAppCreateOptions(appId, cfg) {
  if (appId === "jellyfin") return buildJellyfinOptions(cfg);
  if (appId === "qbittorrent") return buildQBOptions(cfg);
  if (appId === "portainer") return buildPortainerOptions(cfg);
  if (appId === "watchtower") return buildWatchtowerOptions(cfg);
  throw new HttpError(400, "不支持的应用");
}

function getAppDataDir(appId, cfg) {
  const dockerDataPath = normalizeHostPath(cfg.dockerDataPath);
  if (appId === "jellyfin") return path.join(dockerDataPath, "jellyfin");
  if (appId === "qbittorrent") return path.join(dockerDataPath, "qbittorrent");
  if (appId === "portainer") return path.join(dockerDataPath, "portainer");
  return "";
}

async function runInstall(appId, taskId, options = {}) {
  const appDef = getAppDef(appId);
  const existing = await findContainerByName(appDef.containerName);
  if (existing) {
    if (options.skipIfInstalled) {
      appendTaskLog(taskId, `${appDef.name} 已安装，跳过`);
      return { ok: true, appId, skipped: true, message: `${appDef.name} 已安装` };
    }
    throw new HttpError(409, `${appDef.name} 已安装`);
  }

  const cfg = getRawIntegrationConfig();
  updateAppTask(taskId, { progress: 12, message: "检查安装环境" });
  await ensureManagedNetwork(taskId);

  updateAppTask(taskId, { progress: 24, message: "拉取镜像" });
  appendTaskLog(taskId, `开始拉取镜像 ${appDef.image}`);
  await pullImage(appDef.image, (event) => {
    if (!event) return;
    if (event.status && (event.status.includes("Pulling") || event.status.includes("Downloading") || event.status.includes("Extracting"))) {
      appendTaskLog(taskId, `${event.status}${event.progress ? ` ${event.progress}` : ""}`);
    }
  });

  updateAppTask(taskId, { progress: 50, message: "创建容器" });
  const createOptions = buildAppCreateOptions(appId, cfg);
  const container = await docker.createContainer(createOptions);
  appendTaskLog(taskId, `容器已创建 ${container.id.slice(0, 12)}`);

  updateAppTask(taskId, { progress: 70, message: "启动容器" });
  await container.start();
  appendTaskLog(taskId, `${appDef.name} 已启动`);

  updateAppTask(taskId, { progress: 84, message: "安装后验收" });
  await runPostInstallValidation(appId, taskId, cfg);
  appendTaskLog(taskId, `${appDef.name} 验收通过`);

  const updates = {};
  if (appId === "jellyfin" && !cfg.jellyfinBaseUrl) {
    updates.jellyfinBaseUrl = "http://arknas-jellyfin:8096";
  }
  if (appId === "qbittorrent" && !cfg.qbBaseUrl) {
    updates.qbBaseUrl = `http://arknas-qbittorrent:${cfg.qbWebPort}`;
  }
  if (Object.keys(updates).length > 0) {
    updateAppTask(taskId, { progress: 92, message: "同步集成配置" });
    saveIntegrations(updates);
  }

  return {
    ok: true,
    appId,
    containerId: container.id,
    message: `${appDef.name} 已安装并启动`
  };
}

async function runControl(appId, action, taskId) {
  const appDef = getAppDef(appId);
  const cfg = getRawIntegrationConfig();
  const container = await findContainerByName(appDef.containerName);
  if (!container) throw new HttpError(404, `${appDef.name} 未安装`);

  appendTaskLog(taskId, `${appDef.name} 执行 ${action}`);
  if (action === "start") {
    updateAppTask(taskId, { progress: 45, message: "启动容器" });
    await container.start();
    updateAppTask(taskId, { progress: 78, message: "启动后验收" });
    await runPostInstallValidation(appId, taskId, cfg);
  } else if (action === "stop") {
    updateAppTask(taskId, { progress: 45, message: "停止容器" });
    await container.stop();
  } else if (action === "restart") {
    updateAppTask(taskId, { progress: 45, message: "重启容器" });
    await container.restart();
    updateAppTask(taskId, { progress: 78, message: "重启后验收" });
    await runPostInstallValidation(appId, taskId, cfg);
  }
  else throw new HttpError(400, "不支持的操作");

  appendTaskLog(taskId, `${appDef.name} ${action} 完成`);
  return { ok: true, appId, action };
}

async function runUninstall(appId, options = {}, taskId) {
  const appDef = getAppDef(appId);
  const container = await findContainerByName(appDef.containerName);
  if (!container) throw new HttpError(404, `${appDef.name} 未安装`);

  const inspect = await container.inspect();
  if (inspect.State?.Running) {
    appendTaskLog(taskId, "停止容器");
    await container.stop({ t: 10 });
  }
  appendTaskLog(taskId, "删除容器");
  await container.remove({ force: true });

  if (options.removeData) {
    const cfg = getRawIntegrationConfig();
    const dir = getAppDataDir(appId, cfg);
    if (dir) {
      appendTaskLog(taskId, `删除数据目录 ${dir}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  return { ok: true, appId, removedData: Boolean(options.removeData) };
}

async function runActionWithProgress(taskId, appId, action, options = {}) {
  if (action === "install") {
    markTaskRunning(taskId, 8, "检查安装状态");
    const result = await runInstall(appId, taskId, options);
    updateAppTask(taskId, { progress: 96, message: "安装验收完成" });
    return result;
  }

  if (action === "uninstall") {
    markTaskRunning(taskId, 10, "正在卸载应用");
    const result = await runUninstall(appId, options, taskId);
    updateAppTask(taskId, { progress: 95, message: "清理完成" });
    return result;
  }

  markTaskRunning(taskId, 20, `执行 ${action}`);
  const result = await runControl(appId, action, taskId);
  updateAppTask(taskId, { progress: 96, message: "操作完成" });
  return result;
}

async function runBundleInstall(taskId, bundleId) {
  const bundle = getBundleDef(bundleId);
  markTaskRunning(taskId, 5, `开始安装套件：${bundle.name}`);
  appendTaskLog(taskId, `套件包含：${bundle.apps.join(", ")}`);
  const installed = [];
  const skipped = [];

  for (let i = 0; i < bundle.apps.length; i += 1) {
    const appId = bundle.apps[i];
    const percentBase = 10 + Math.floor((i / bundle.apps.length) * 80);
    const percentDone = 10 + Math.floor(((i + 1) / bundle.apps.length) * 80);
    updateAppTask(taskId, { progress: percentBase, message: `安装 ${appId}（${i + 1}/${bundle.apps.length}）` });
    appendTaskLog(taskId, `安装子应用 ${appId}`);
    const result = await runInstall(appId, taskId, { skipIfInstalled: true });
    if (result.skipped) skipped.push(appId);
    else installed.push(appId);
    updateAppTask(taskId, { progress: percentDone, message: `${appId} 已处理` });
  }

  updateAppTask(taskId, { progress: 96, message: "套件安装完成" });
  appendTaskLog(taskId, `套件安装完成，新增：${installed.join(", ") || "无"}；跳过：${skipped.join(", ") || "无"}`);
  return { ok: true, bundleId, installed, skipped, message: `${bundle.name} 安装完成` };
}

function scheduleTask(taskId, appId, action, actor, options = {}) {
  if (runningTasks.has(taskId)) return;
  runningTasks.add(taskId);

  setTimeout(async () => {
    try {
      const result = await runActionWithProgress(taskId, appId, action, options);
      markTaskSuccess(taskId, result.message || `${action} 成功`);
      appendTaskLog(taskId, "任务完成");
      writeAudit({
        action: `app_${action}`,
        actor,
        target: appId,
        status: "ok",
        detail: JSON.stringify(result)
      });
    } catch (err) {
      const message = err?.message || String(err);
      markTaskFailed(taskId, message);
      appendTaskLog(taskId, `失败：${message}`);
      writeAudit({
        action: `app_${action}`,
        actor,
        target: appId,
        status: "failed",
        detail: message
      });
    } finally {
      runningTasks.delete(taskId);
    }
  }, 20);
}

function scheduleBundleTask(taskId, bundleId, actor) {
  if (runningTasks.has(taskId)) return;
  runningTasks.add(taskId);

  setTimeout(async () => {
    try {
      const result = await runBundleInstall(taskId, bundleId);
      markTaskSuccess(taskId, result.message || "套件安装成功");
      appendTaskLog(taskId, "套件任务完成");
      writeAudit({
        action: "app_bundle_install",
        actor,
        target: bundleId,
        status: "ok",
        detail: JSON.stringify(result)
      });
    } catch (err) {
      const message = err?.message || String(err);
      markTaskFailed(taskId, message);
      appendTaskLog(taskId, `失败：${message}`);
      writeAudit({
        action: "app_bundle_install",
        actor,
        target: bundleId,
        status: "failed",
        detail: message
      });
    } finally {
      runningTasks.delete(taskId);
    }
  }, 20);
}

export async function listManagedApps() {
  const cfg = getRawIntegrationConfig();
  const keys = Object.keys(APP_DEFINITIONS);
  const statuses = await Promise.all(
    keys.map(async (key) => {
      const app = APP_DEFINITIONS[key];
      const container = await findContainerSummaryByName(app.containerName);
      const base = buildStatus(app, container, cfg);
      if (!base.installed) {
        return {
          ...base,
          health: "not_installed",
          health_state: "missing"
        };
      }
      const health = await readContainerHealthInfo(app.containerName);
      return {
        ...base,
        health: health.health,
        health_state: health.state,
        health_error: health.error || "",
        started_at: health.startedAt || ""
      };
    })
  );

  return statuses;
}

export function listManagedBundles() {
  return Object.values(BUNDLE_DEFINITIONS);
}

export function listAppPermissions(appId) {
  getAppDef(appId);
  return db
    .prepare(
      `SELECT id, app_id, path, permission, visibility, created_at, updated_at
       FROM app_permissions
       WHERE app_id = ?
       ORDER BY id ASC`
    )
    .all(appId);
}

export function saveAppPermissions(appId, rows = []) {
  getAppDef(appId);
  const list = Array.isArray(rows) ? rows : [];
  const now = new Date().toISOString();
  const del = db.prepare("DELETE FROM app_permissions WHERE app_id = ?");
  const ins = db.prepare(
    `INSERT INTO app_permissions (app_id, path, permission, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    del.run(appId);
    for (const row of list) {
      const permission = String(row.permission || "rw");
      const visibility = String(row.visibility || "all-users");
      const p = String(row.path || "").trim();
      if (!p) continue;
      ins.run(appId, p, permission, visibility, now, now);
    }
  });
  tx();
  return listAppPermissions(appId);
}

export function listManagedAppTasks(limit = 60) {
  return listAppTasks(limit);
}

export function getManagedAppTask(taskId) {
  return getAppTaskById(taskId);
}

export function getManagedAppTaskLogs(taskId) {
  return getTaskLogs(taskId);
}

export function createAppActionTask({ appId, action, actor = "system", options = {} }) {
  getAppDef(appId);
  const supported = ["install", "start", "stop", "restart", "uninstall"];
  if (!supported.includes(action)) {
    throw new HttpError(400, "不支持的任务动作");
  }

  const task = createAppTask({
    appId,
    action,
    actor,
    message: `已加入队列：${action}`,
    options
  });

  appendTaskLog(task.id, `任务创建：${appId} ${action}`);
  scheduleTask(task.id, appId, action, actor, options);
  return task;
}

export function createBundleInstallTask({ bundleId = "media-stack", actor = "system" }) {
  const bundle = getBundleDef(bundleId);
  const task = createAppTask({
    appId: bundle.id,
    action: "install_bundle",
    actor,
    message: `已加入队列：安装 ${bundle.name}`,
    options: { bundleId, apps: bundle.apps }
  });

  appendTaskLog(task.id, `任务创建：bundle ${bundleId}`);
  scheduleBundleTask(task.id, bundleId, actor);
  return task;
}

export function retryManagedAppTask(taskId, actor = "system") {
  const retryTask = cloneFailedTaskAsRetry(taskId, actor);
  if (!retryTask) {
    throw new HttpError(400, "仅失败任务允许重试");
  }

  appendTaskLog(retryTask.id, `重试来源任务 #${taskId}`);

  if (retryTask.app_id in BUNDLE_DEFINITIONS || retryTask.action === "install_bundle") {
    const bundleId = retryTask.options?.bundleId || retryTask.app_id;
    scheduleBundleTask(retryTask.id, bundleId, actor);
  } else {
    scheduleTask(retryTask.id, retryTask.app_id, retryTask.action, actor, retryTask.options || {});
  }

  return retryTask;
}
