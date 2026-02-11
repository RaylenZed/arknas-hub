import Docker from "dockerode";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { config } from "../config.js";
import { HttpError } from "../lib/httpError.js";
import {
  deleteComposeProjectConfig,
  getRegistrySettings,
  listComposeProjectsConfig,
  saveRegistrySettings,
  upsertComposeProjectConfig
} from "./systemService.js";

function createDockerClient() {
  if (config.dockerHost.startsWith("unix://")) {
    return new Docker({ socketPath: config.dockerHost.replace("unix://", "") });
  }

  const normalized = config.dockerHost.replace("tcp://", "http://");
  const parsed = new URL(normalized);
  return new Docker({
    host: parsed.hostname,
    port: Number(parsed.port || 2375),
    protocol: parsed.protocol.replace(":", "")
  });
}

export const docker = createDockerClient();

function classifyContainerState(raw) {
  const state = raw.State || raw.state || "unknown";
  const status = raw.Status || raw.status || "";
  if (state === "running") return "running";
  if (status.includes("Exited") || state === "exited") return "stopped";
  if (status.toLowerCase().includes("unhealthy") || status.toLowerCase().includes("dead")) return "error";
  return state;
}

function mapPorts(ports = []) {
  return ports.map((p) => ({
    ip: p.IP || "",
    privatePort: p.PrivatePort,
    publicPort: p.PublicPort || null,
    type: p.Type
  }));
}

function parseNanoCpu(stats) {
  if (!stats?.cpu_stats || !stats?.precpu_stats) return 0;
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const cores = stats.cpu_stats.online_cpus || 1;
  if (systemDelta <= 0 || cpuDelta <= 0) return 0;
  return Number(((cpuDelta / systemDelta) * cores * 100).toFixed(2));
}

function commandExists(cmd) {
  const checked = spawnSync("sh", ["-lc", `command -v ${cmd}`], {
    encoding: "utf8",
    timeout: 3000
  });
  return checked.status === 0;
}

function runComposeCommand({ project, composeFile, cwd, action }) {
  const hasDocker = commandExists("docker");
  const hasDockerCompose = commandExists("docker-compose");

  const run = (cmd, args) =>
    spawnSync(cmd, args, {
      cwd,
      encoding: "utf8",
      timeout: 120000
    });

  const argsByAction = {
    up: ["up", "-d"],
    down: ["down"],
    start: ["start"],
    stop: ["stop"],
    restart: ["restart"]
  };
  const actionArgs = argsByAction[action];
  if (!actionArgs) throw new HttpError(400, "不支持的 Compose 动作");

  if (hasDocker) {
    const args = ["compose", "-p", project, "-f", composeFile, ...actionArgs];
    const result = run("docker", args);
    if (result.status === 0) {
      return {
        ok: true,
        engine: "docker compose",
        command: `docker ${args.join(" ")}`,
        stdout: String(result.stdout || "").trim(),
        stderr: String(result.stderr || "").trim()
      };
    }
  }

  if (hasDockerCompose) {
    const args = ["-p", project, "-f", composeFile, ...actionArgs];
    const result = run("docker-compose", args);
    if (result.status === 0) {
      return {
        ok: true,
        engine: "docker-compose",
        command: `docker-compose ${args.join(" ")}`,
        stdout: String(result.stdout || "").trim(),
        stderr: String(result.stderr || "").trim()
      };
    }
  }

  throw new HttpError(500, "Compose 命令执行失败，请确认容器具备 docker compose 或 docker-compose");
}

export async function getDockerInfo() {
  try {
    return await docker.info();
  } catch (err) {
    throw new HttpError(503, `Docker 服务不可用: ${err.message}`);
  }
}

export async function listContainers() {
  try {
    const raw = await docker.listContainers({ all: true });
    const results = await Promise.all(
      raw.map(async (item) => {
        const container = docker.getContainer(item.Id);
        let cpuPercent = 0;
        let memoryUsed = 0;
        let netIn = 0;
        let netOut = 0;

        if ((item.State || "") === "running") {
          try {
            const stats = await container.stats({ stream: false });
            cpuPercent = parseNanoCpu(stats);
            memoryUsed = stats?.memory_stats?.usage || 0;
            const networks = stats?.networks || {};
            for (const net of Object.values(networks)) {
              netIn += net.rx_bytes || 0;
              netOut += net.tx_bytes || 0;
            }
          } catch {
            // ignore per-container metric failures
          }
        }

        return {
          id: item.Id,
          name: (item.Names?.[0] || "").replace(/^\//, ""),
          image: item.Image,
          project: item.Labels?.["com.docker.compose.project"] || "-",
          service: item.Labels?.["com.docker.compose.service"] || "-",
          state: classifyContainerState(item),
          status: item.Status,
          createdAt: new Date((item.Created || 0) * 1000).toISOString(),
          ports: mapPorts(item.Ports || []),
          metrics: {
            cpuPercent,
            memoryBytes: memoryUsed,
            netInBytes: netIn,
            netOutBytes: netOut
          }
        };
      })
    );

    return results;
  } catch (err) {
    throw new HttpError(503, `Docker 服务不可用: ${err.message}`);
  }
}

export async function getContainerSummary() {
  const containers = await listContainers();
  const summary = { total: containers.length, running: 0, stopped: 0, error: 0 };
  for (const c of containers) {
    if (c.state === "running") summary.running += 1;
    else if (c.state === "stopped") summary.stopped += 1;
    else summary.error += 1;
  }
  return { summary, containers };
}

export async function controlContainer(id, action) {
  try {
    const container = docker.getContainer(id);
    if (action === "start") await container.start();
    else if (action === "stop") await container.stop();
    else if (action === "restart") await container.restart();
    else throw new HttpError(400, "不支持的容器操作");
    return { id, action, ok: true };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, `Docker 服务不可用: ${err.message}`);
  }
}

export async function getContainerLogs(id, lines = 200) {
  try {
    const container = docker.getContainer(id);
    const buffer = await container.logs({
      stdout: true,
      stderr: true,
      tail: lines,
      timestamps: true
    });

    return buffer.toString("utf8");
  } catch (err) {
    throw new HttpError(503, `Docker 服务不可用: ${err.message}`);
  }
}

function pullImage(image, onProgress) {
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

function mapImage(img) {
  const tags = img.RepoTags || [];
  return {
    id: img.Id,
    shortId: (img.Id || "").replace("sha256:", "").slice(0, 12),
    createdAt: new Date((img.Created || 0) * 1000).toISOString(),
    size: img.Size || 0,
    sharedSize: img.SharedSize || 0,
    virtualSize: img.VirtualSize || 0,
    tags: tags.filter((t) => t && t !== "<none>:<none>"),
    digest: (img.RepoDigests || [])[0] || "",
    containers: img.Containers || 0
  };
}

export async function listLocalImages() {
  try {
    const list = await docker.listImages({ all: true });
    return list.map(mapImage);
  } catch (err) {
    throw new HttpError(503, `Docker 服务不可用: ${err.message}`);
  }
}

export async function pullImageByName(name) {
  const image = String(name || "").trim();
  if (!image) {
    throw new HttpError(400, "镜像名称不能为空");
  }
  try {
    await pullImage(image);
    return { ok: true, image };
  } catch (err) {
    throw new HttpError(500, `拉取镜像失败: ${err.message}`);
  }
}

export async function removeLocalImage(id, force = false) {
  try {
    const image = docker.getImage(id);
    await image.remove({ force: Boolean(force), noprune: false });
    return { ok: true, id, force: Boolean(force) };
  } catch (err) {
    throw new HttpError(500, `删除镜像失败: ${err.message}`);
  }
}

export async function searchRegistryRepositories(query = "", page = 1, limit = 20) {
  const q = String(query || "").trim();
  if (!q) return { count: 0, page, limit, results: [] };

  const url = new URL("https://hub.docker.com/v2/search/repositories/");
  url.searchParams.set("query", q);
  url.searchParams.set("page", String(Math.max(1, Number(page) || 1)));
  url.searchParams.set("page_size", String(Math.min(50, Math.max(1, Number(limit) || 20))));

  try {
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new HttpError(res.status, `镜像仓库查询失败: ${text || res.statusText}`);
    }
    const data = await res.json();
    return {
      count: data.count || 0,
      page: Number(page) || 1,
      limit: Number(limit) || 20,
      results: (data.results || []).map((item) => ({
        name: item.repo_name || item.name || "",
        shortDescription: item.short_description || "",
        starCount: item.star_count || 0,
        pullCount: item.pull_count || 0,
        isOfficial: Boolean(item.is_official),
        isAutomated: Boolean(item.is_automated)
      }))
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, `镜像仓库查询失败: ${err.message}`);
  }
}

function mapNetwork(net) {
  const containers = Object.values(net.Containers || {}).map((c) => ({
    id: c.Name || c.EndpointID || "",
    name: c.Name || "",
    ipv4: c.IPv4Address || "",
    ipv6: c.IPv6Address || ""
  }));

  return {
    id: net.Id,
    name: net.Name,
    driver: net.Driver,
    scope: net.Scope,
    internal: Boolean(net.Internal),
    attachable: Boolean(net.Attachable),
    ingress: Boolean(net.Ingress),
    createdAt: net.Created ? new Date(net.Created).toISOString() : "",
    containerCount: containers.length,
    containers
  };
}

export async function listDockerNetworks() {
  try {
    const raw = await docker.listNetworks();
    const details = await Promise.all(
      raw.map(async (n) => {
        const net = docker.getNetwork(n.Id);
        const inspect = await net.inspect();
        return mapNetwork(inspect);
      })
    );
    return details.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    throw new HttpError(503, `Docker 服务不可用: ${err.message}`);
  }
}

export async function createDockerNetwork({ name, driver = "bridge", attachable = true, internal = false } = {}) {
  const netName = String(name || "").trim();
  if (!netName) {
    throw new HttpError(400, "网络名称不能为空");
  }
  try {
    const result = await docker.createNetwork({
      Name: netName,
      Driver: driver,
      Attachable: Boolean(attachable),
      Internal: Boolean(internal)
    });
    return { ok: true, id: result.id, name: netName };
  } catch (err) {
    throw new HttpError(500, `创建网络失败: ${err.message}`);
  }
}

export async function removeDockerNetwork(id) {
  try {
    const net = docker.getNetwork(id);
    await net.remove();
    return { ok: true, id };
  } catch (err) {
    throw new HttpError(500, `删除网络失败: ${err.message}`);
  }
}

export async function connectContainerToNetwork(networkId, containerId) {
  try {
    const net = docker.getNetwork(networkId);
    await net.connect({ Container: containerId });
    return { ok: true, networkId, containerId };
  } catch (err) {
    throw new HttpError(500, `容器加入网络失败: ${err.message}`);
  }
}

export async function disconnectContainerFromNetwork(networkId, containerId, force = false) {
  try {
    const net = docker.getNetwork(networkId);
    await net.disconnect({ Container: containerId, Force: Boolean(force) });
    return { ok: true, networkId, containerId, force: Boolean(force) };
  } catch (err) {
    throw new HttpError(500, `容器移出网络失败: ${err.message}`);
  }
}

export async function listComposeProjects() {
  try {
    const list = await docker.listContainers({ all: true });
    const map = new Map();
    for (const item of list) {
      const project = item.Labels?.["com.docker.compose.project"];
      if (!project) continue;
      if (!map.has(project)) {
        map.set(project, {
          name: project,
          total: 0,
          running: 0,
          stopped: 0,
          services: new Set(),
          containers: []
        });
      }
      const row = map.get(project);
      row.total += 1;
      if ((item.State || "") === "running") row.running += 1;
      else row.stopped += 1;
      const service = item.Labels?.["com.docker.compose.service"];
      if (service) row.services.add(service);
      row.containers.push({
        id: item.Id,
        name: (item.Names?.[0] || "").replace(/^\//, ""),
        service: service || "-",
        state: item.State || "unknown",
        status: item.Status || ""
      });
    }

    const active = [...map.values()].map((v) => ({
      name: v.name,
      total: v.total,
      running: v.running,
      stopped: v.stopped,
      services: [...v.services],
      containers: v.containers,
      sourceType: "docker-labels",
      projectPath: "",
      composeFile: ""
    }));

    const configured = listComposeProjectsConfig();
    for (const cfg of configured) {
      if (map.has(cfg.name)) continue;
      active.push({
        name: cfg.name,
        total: 0,
        running: 0,
        stopped: 0,
        services: [],
        containers: [],
        sourceType: cfg.source_type || "config",
        projectPath: cfg.project_path || "",
        composeFile: cfg.compose_file || ""
      });
    }

    return active.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    throw new HttpError(503, `Docker 服务不可用: ${err.message}`);
  }
}

export async function controlComposeProject(projectName, action) {
  const supported = new Set(["start", "stop", "restart"]);
  if (!supported.has(action)) {
    throw new HttpError(400, "不支持的项目操作");
  }
  const project = String(projectName || "").trim();
  if (!project) {
    throw new HttpError(400, "项目名不能为空");
  }

  try {
    const list = await docker.listContainers({
      all: true,
      filters: {
        label: [`com.docker.compose.project=${project}`]
      }
    });
    if (list.length === 0) {
      const configured = listComposeProjectsConfig().find((item) => item.name === project);
      if (!configured) throw new HttpError(404, "未找到 Compose 项目");

      const composeFile = configured.compose_file || path.join(configured.project_path, "docker-compose.yml");
      if (!fs.existsSync(composeFile)) {
        throw new HttpError(404, `Compose 文件不存在: ${composeFile}`);
      }
      const cmd = runComposeCommand({
        project,
        composeFile,
        cwd: configured.project_path,
        action
      });
      return {
        ok: true,
        project,
        action,
        count: 0,
        mode: "compose-cli",
        command: cmd.command
      };
    }

    for (const item of list) {
      const container = docker.getContainer(item.Id);
      if (action === "start") await container.start();
      if (action === "stop") await container.stop();
      if (action === "restart") await container.restart();
    }

    return {
      ok: true,
      project,
      action,
      count: list.length
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, `项目操作失败: ${err.message}`);
  }
}

function normalizeProjectName(name) {
  const project = String(name || "").trim();
  if (!project) throw new HttpError(400, "项目名不能为空");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,63}$/.test(project)) {
    throw new HttpError(400, "项目名仅支持字母、数字、下划线、点、短横线");
  }
  return project;
}

function ensureComposeFile(content) {
  const text = String(content || "").trim();
  if (!text) throw new HttpError(400, "Compose 内容不能为空");
  if (!/services\\s*:/i.test(text)) {
    throw new HttpError(400, "Compose 文件缺少 services 定义");
  }
  return `${text}\n`;
}

export async function createComposeProject({
  name,
  sourceType = "inline",
  composeContent = "",
  composePath = "",
  startAfterCreate = false
} = {}) {
  const project = normalizeProjectName(name);
  const resolvedBaseDir = path.resolve(config.composeProjectsDir, project);
  fs.mkdirSync(resolvedBaseDir, { recursive: true });

  let finalComposeFile = "";
  let finalProjectPath = resolvedBaseDir;

  if (sourceType === "existing") {
    const existingPath = path.resolve(String(composePath || "").trim());
    if (!existingPath || !fs.existsSync(existingPath)) {
      throw new HttpError(400, "指定的 Compose 文件不存在");
    }
    finalComposeFile = existingPath;
    finalProjectPath = path.dirname(existingPath);
  } else {
    const fileContent = ensureComposeFile(composeContent);
    finalComposeFile = path.join(resolvedBaseDir, "docker-compose.yml");
    fs.writeFileSync(finalComposeFile, fileContent, "utf8");
  }

  const row = upsertComposeProjectConfig({
    name: project,
    projectPath: finalProjectPath,
    composeFile: finalComposeFile,
    sourceType
  });

  let startup = {
    started: false,
    command: ""
  };
  if (startAfterCreate) {
    const result = runComposeCommand({
      project,
      composeFile: finalComposeFile,
      cwd: finalProjectPath,
      action: "up"
    });
    startup = {
      started: true,
      command: result.command
    };
  }

  return {
    ok: true,
    project,
    sourceType,
    projectPath: finalProjectPath,
    composeFile: finalComposeFile,
    startup,
    config: row
  };
}

export async function removeComposeProject(projectName, { down = false, removeFiles = false } = {}) {
  const project = normalizeProjectName(projectName);
  const configured = listComposeProjectsConfig().find((item) => item.name === project);
  if (!configured) throw new HttpError(404, "Compose 项目配置不存在");

  let command = "";
  if (down && configured.compose_file && fs.existsSync(configured.compose_file)) {
    const result = runComposeCommand({
      project,
      composeFile: configured.compose_file,
      cwd: configured.project_path,
      action: "down"
    });
    command = result.command;
  }

  deleteComposeProjectConfig(project);

  if (removeFiles && configured.source_type !== "existing") {
    try {
      fs.rmSync(configured.project_path, { recursive: true, force: true });
    } catch {
      // ignore remove failures
    }
  }

  return {
    ok: true,
    project,
    removedFiles: Boolean(removeFiles && configured.source_type !== "existing"),
    command
  };
}

export function getDockerRegistrySettings() {
  return getRegistrySettings();
}

export function updateDockerRegistrySettings(input = {}) {
  return saveRegistrySettings(input);
}

function buildCreateOptions(inspect) {
  const cfg = inspect.Config || {};
  const hostCfg = inspect.HostConfig || {};

  return {
    name: inspect.Name?.replace(/^\//, ""),
    Image: cfg.Image,
    Cmd: cfg.Cmd,
    Env: cfg.Env,
    Entrypoint: cfg.Entrypoint,
    ExposedPorts: cfg.ExposedPorts,
    Labels: cfg.Labels,
    WorkingDir: cfg.WorkingDir,
    User: cfg.User,
    HostConfig: {
      Binds: hostCfg.Binds,
      PortBindings: hostCfg.PortBindings,
      RestartPolicy: hostCfg.RestartPolicy,
      NetworkMode: hostCfg.NetworkMode,
      Privileged: hostCfg.Privileged,
      Devices: hostCfg.Devices,
      CapAdd: hostCfg.CapAdd,
      CapDrop: hostCfg.CapDrop,
      LogConfig: hostCfg.LogConfig,
      Memory: hostCfg.Memory,
      MemorySwap: hostCfg.MemorySwap,
      CpuShares: hostCfg.CpuShares,
      NanoCpus: hostCfg.NanoCpus,
      ExtraHosts: hostCfg.ExtraHosts
    },
    NetworkingConfig: {
      EndpointsConfig: inspect.NetworkSettings?.Networks || {}
    }
  };
}

export async function updateContainer(id, { recreate = false } = {}) {
  let container;
  let inspect;
  try {
    container = docker.getContainer(id);
    inspect = await container.inspect();
    await pullImage(inspect.Config?.Image);
  } catch (err) {
    throw new HttpError(503, `Docker 服务不可用: ${err.message}`);
  }

  if (!recreate) {
    return {
      ok: true,
      mode: "pull-only",
      message: "镜像已拉取。若容器由 Compose 管理，请执行重建以应用新镜像。"
    };
  }

  const wasRunning = inspect.State?.Running;
  const originalName = inspect.Name?.replace(/^\//, "") || id.slice(0, 12);
  const createOptions = buildCreateOptions(inspect);

  try {
    if (wasRunning) {
      await container.stop({ t: 10 });
    }
    await container.remove({ force: false, v: false });
    const newContainer = await docker.createContainer(createOptions);
    await newContainer.start();

    return {
      ok: true,
      mode: "recreate",
      containerName: originalName,
      message: "容器已按最新镜像重建并启动。"
    };
  } catch (err) {
    throw new HttpError(500, `容器重建失败: ${err.message}`);
  }
}
