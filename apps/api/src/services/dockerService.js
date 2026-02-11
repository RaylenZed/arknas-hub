import Docker from "dockerode";
import { config } from "../config.js";
import { HttpError } from "../lib/httpError.js";

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

const docker = createDockerClient();

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

function pullImage(image) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(
        stream,
        (progressErr) => {
          if (progressErr) reject(progressErr);
          else resolve(true);
        },
        () => {}
      );
    });
  });
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
