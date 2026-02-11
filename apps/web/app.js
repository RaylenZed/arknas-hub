const storedSessionToken = sessionStorage.getItem("arknas_token") || "";
const storedLocalToken = localStorage.getItem("arknas_token") || "";

const state = {
  token: storedSessionToken || storedLocalToken || "",
  user: null,
  page: "dashboard",
  refreshTimer: null,
  modalTimer: null,
  dockerTab: "overview",
  downloadsFilter: "all",
  downloadsDetailHash: "",
  systemMenu: "device",
  mediaFilterType: "",
  mediaSearchKeyword: "",
  appsCategory: "all"
};

let loginPublicKeyCache = null;

const PAGE_TITLES = {
  dashboard: "仪表盘",
  containers: "Docker 中心",
  media: "影视",
  downloads: "下载管理",
  apps: "应用中心",
  ssl: "SSL 证书",
  settings: "系统设置"
};

const appEl = document.getElementById("app");
const loginOverlayEl = document.getElementById("loginOverlay");
const pageContentEl = document.getElementById("pageContent");
const pageTitleEl = document.getElementById("pageTitle");
const toastEl = document.getElementById("toast");
const modalEl = document.getElementById("modal");
const modalTitleEl = document.getElementById("modalTitle");
const modalBodyEl = document.getElementById("modalBody");

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  setTimeout(() => toastEl.classList.add("hidden"), 2500);
}

function clearModalTimer() {
  if (state.modalTimer) {
    clearInterval(state.modalTimer);
    state.modalTimer = null;
  }
}

function openModal(title, html) {
  clearModalTimer();
  modalTitleEl.textContent = title;
  modalBodyEl.innerHTML = html;
  modalEl.classList.remove("hidden");
}

function closeModal() {
  clearModalTimer();
  modalEl.classList.add("hidden");
  modalBodyEl.innerHTML = "";
}

document.getElementById("modalClose").addEventListener("click", closeModal);
modalEl.addEventListener("click", (e) => {
  if (e.target === modalEl) closeModal();
});

function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes)) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

function formatSpeed(bytes = 0) {
  return `${formatBytes(bytes)}/s`;
}

function formatDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer.buffer;
}

async function getLoginPublicKey(forceRefresh = false) {
  if (!forceRefresh && loginPublicKeyCache) return loginPublicKeyCache;
  const data = await api("/api/auth/public-key", { skipAuthHandling: true });
  loginPublicKeyCache = data;
  return data;
}

async function encryptLoginPassword(password) {
  const plain = String(password || "");
  if (!plain) return { passwordEncrypted: "", keyId: "" };
  const keyPayload = await getLoginPublicKey();
  if (window.crypto?.subtle) {
    const imported = await window.crypto.subtle.importKey(
      "spki",
      pemToArrayBuffer(keyPayload.publicKey),
      {
        name: "RSA-OAEP",
        hash: "SHA-256"
      },
      false,
      ["encrypt"]
    );

    const encoded = new TextEncoder().encode(plain);
    const encrypted = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, imported, encoded);
    const bytes = new Uint8Array(encrypted);
    const chunk = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    return {
      passwordEncrypted: btoa(chunk),
      keyId: keyPayload.keyId,
      algorithm: "RSA-OAEP-256"
    };
  }

  if (window.JSEncrypt) {
    const jsEncrypt = new window.JSEncrypt();
    jsEncrypt.setPublicKey(keyPayload.publicKey);
    const encrypted = jsEncrypt.encrypt(plain);
    if (!encrypted) {
      throw new Error("登录加密失败，请刷新页面重试");
    }
    return {
      passwordEncrypted: encrypted,
      keyId: keyPayload.keyId,
      algorithm: "RSAES-PKCS1-v1_5"
    };
  }

  throw new Error("当前浏览器不支持安全登录加密，请更换浏览器或启用 HTTPS");
}

function statusClass(stateValue) {
  if (stateValue === "running") return "status-running";
  if (stateValue === "stopped") return "status-stopped";
  if (stateValue === "error") return "status-error";
  return "status-other";
}

async function api(path, options = {}) {
  const { skipAuthHandling = false, ...fetchOptions } = options;
  const headers = { ...(fetchOptions.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const res = await fetch(path, {
    ...fetchOptions,
    headers
  });

  let errorMessage = "";
  if (!res.ok) {
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      errorMessage = data.error || `HTTP ${res.status}`;
    } else {
      const text = await res.text().catch(() => "");
      errorMessage = text || `HTTP ${res.status}`;
    }
  }

  if (res.status === 401) {
    if (!skipAuthHandling) {
      forceLogout();
      throw new Error("登录已过期，请重新登录");
    }
    throw new Error(errorMessage || "认证失败");
  }

  if (!res.ok) {
    throw new Error(errorMessage || `HTTP ${res.status}`);
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

function setAuthedUI(authed) {
  appEl.classList.toggle("hidden", !authed);
  loginOverlayEl.classList.toggle("hidden", authed);
}

function forceLogout() {
  state.token = "";
  state.user = null;
  localStorage.removeItem("arknas_token");
  sessionStorage.removeItem("arknas_token");
  clearRefreshTimer();
  setAuthedUI(false);
}

function initLoginFormState() {
  const usernameInput = document.querySelector('input[name="username"]');
  const rememberInput = document.getElementById("rememberLogin");
  const lastUser = localStorage.getItem("arknas_last_user") || "";
  const remember = localStorage.getItem("arknas_remember") === "1";
  if (usernameInput && lastUser) usernameInput.value = lastUser;
  if (rememberInput) rememberInput.checked = remember;

  const nodeNameEl = document.getElementById("loginNodeName");
  if (nodeNameEl) {
    nodeNameEl.textContent = location.hostname || "管理节点";
  }
}

async function bootstrapAuth() {
  if (!state.token) {
    setAuthedUI(false);
    return;
  }

  try {
    const data = await api("/api/auth/me");
    state.user = data.user;
    setAuthedUI(true);
    await navigate("dashboard");
  } catch {
    forceLogout();
  }
}

function clearRefreshTimer() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function setPageTitle(page) {
  pageTitleEl.textContent = PAGE_TITLES[page] || page;
}

function setActiveNav(page) {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === page);
  });
}

async function navigate(page) {
  clearRefreshTimer();
  closeModal();
  state.page = page;
  setPageTitle(page);
  setActiveNav(page);

  if (page === "dashboard") {
    await renderDashboard();
    state.refreshTimer = setInterval(renderDashboard, 8000);
  } else if (page === "containers") {
    await renderContainers();
  } else if (page === "media") {
    await renderMedia();
  } else if (page === "downloads") {
    await renderDownloads();
  } else if (page === "apps") {
    await renderApps();
    state.refreshTimer = setInterval(renderApps, 5000);
  } else if (page === "ssl") {
    await renderSSL();
  } else if (page === "settings") {
    await renderSettings();
  }
}

async function renderDashboard() {
  try {
    const data = await api("/api/dashboard/overview");
    const containerSummary = data.containers.data?.summary || {
      total: 0,
      running: 0,
      stopped: 0,
      error: 0
    };

    const mediaSummary = data.media.data?.summary || {
      activeSessions: 0,
      continueCount: 0,
      latestCount: 0
    };

    const downloadSummary = data.downloads.data?.summary || {
      downloading: 0,
      seeding: 0,
      completed: 0,
      dlSpeed: 0,
      upSpeed: 0
    };

    const sys = data.system.data || {
      cpu: { usagePercent: 0 },
      memory: { usagePercent: 0 },
      disks: [],
      network: []
    };

    const latest = data.media.data?.latest || [];
    const completed = data.recentCompleted.data || [];
    const alerts = data.alerts || [];

    pageContentEl.innerHTML = `
      <section class="card">
        <h3>告警中心</h3>
        <div class="list">
          ${
            alerts.length
              ? alerts
                  .map(
                    (a) =>
                      `<div class="list-item"><div class="list-title">${a.code}</div><div class="text-muted">[${a.severity}] ${a.message}</div></div>`
                  )
                  .join("")
              : '<div class="text-muted">当前无告警</div>'
          }
        </div>
      </section>

      <section class="grid-4">
        <div class="card stat"><div class="stat-label">容器总数</div><div class="stat-value">${containerSummary.total}</div><div class="text-muted">运行 ${containerSummary.running} / 停止 ${containerSummary.stopped} / 异常 ${containerSummary.error}</div></div>
        <div class="card stat"><div class="stat-label">Jellyfin</div><div class="stat-value">${mediaSummary.activeSessions}</div><div class="text-muted">活跃播放会话</div></div>
        <div class="card stat"><div class="stat-label">qB 下载中</div><div class="stat-value">${downloadSummary.downloading}</div><div class="text-muted">下行 ${formatSpeed(downloadSummary.dlSpeed)}</div></div>
        <div class="card stat"><div class="stat-label">qB 上传</div><div class="stat-value">${formatSpeed(downloadSummary.upSpeed)}</div><div class="text-muted">做种 ${downloadSummary.seeding}</div></div>
      </section>

      <section class="grid-3">
        <div class="card">
          <h3>系统资源</h3>
          <div class="list">
            <div class="list-item"><div>CPU：${sys.cpu.usagePercent}%</div><div class="progress"><span style="width:${sys.cpu.usagePercent}%"></span></div></div>
            <div class="list-item"><div>内存：${sys.memory.usagePercent}%</div><div class="progress"><span style="width:${sys.memory.usagePercent}%"></span></div></div>
            <div class="list-item">磁盘：${(sys.disks || [])
              .map((d) => `${d.mount} ${d.usePercent}% (${formatBytes(d.available)} 可用)`)
              .join("<br />") || "-"}</div>
            <div class="list-item">网络：${(sys.network || [])
              .map((n) => `${n.iface} ↓${formatSpeed(n.rxSec)} ↑${formatSpeed(n.txSec)}`)
              .join("<br />") || "-"}</div>
          </div>
        </div>
        <div class="card">
          <h3>最近添加（影视）</h3>
          <div class="list">
            ${latest
              .slice(0, 8)
              .map(
                (it) => `<div class="list-item"><div class="list-title">${it.Name || "未命名"}</div><div class="text-muted">${it.Type || "-"} · ${formatDate(it.DateCreated)}</div></div>`
              )
              .join("") || '<div class="text-muted">暂无数据</div>'}
          </div>
        </div>
        <div class="card">
          <h3>最近完成下载</h3>
          <div class="list">
            ${completed
              .slice(0, 8)
              .map(
                (it) => `<div class="list-item"><div class="list-title">${it.name}</div><div class="text-muted">${formatBytes(it.size)} · 完成于 ${formatDate((it.completion_on || 0) * 1000)}</div></div>`
              )
              .join("") || '<div class="text-muted">暂无数据</div>'}
          </div>
        </div>
      </section>
    `;
  } catch (err) {
    pageContentEl.innerHTML = `<div class="card">加载失败：${err.message}</div>`;
  }
}

async function renderContainers() {
  try {
    const tabs = [
      { id: "overview", label: "概览" },
      { id: "containers", label: "容器" },
      { id: "compose", label: "Compose 项目" },
      { id: "images", label: "本地镜像" },
      { id: "registry", label: "镜像仓库" },
      { id: "networks", label: "网络" }
    ];

    let bodyHtml = "";

    if (state.dockerTab === "overview") {
      const [summaryData, dockerInfo, sysStatus] = await Promise.all([
        api("/api/containers/summary"),
        api("/api/containers/info"),
        api("/api/system/status")
      ]);
      const s = summaryData.summary || { total: 0, running: 0, stopped: 0, error: 0 };
      const cpu = Number(sysStatus?.cpu?.usagePercent || 0);
      const mem = Number(sysStatus?.memory?.usagePercent || 0);
      const netText = (sysStatus?.network || [])
        .slice(0, 4)
        .map((n) => `${n.iface} ↓${formatSpeed(n.rxSec)} ↑${formatSpeed(n.txSec)}`)
        .join("<br />");

      bodyHtml = `
        <section class="grid-2">
          <div class="card">
            <h3>运行状态</h3>
            <div class="list">
              <div class="list-item"><div class="list-title">容器总数</div><div>${s.total}</div></div>
              <div class="list-item"><div class="list-title">运行中</div><div>${s.running}</div></div>
              <div class="list-item"><div class="list-title">已停止</div><div>${s.stopped}</div></div>
              <div class="list-item"><div class="list-title">异常</div><div>${s.error}</div></div>
              <div class="list-item"><div class="list-title">镜像数量</div><div>${dockerInfo.Images || 0}</div></div>
              <div class="list-item"><div class="list-title">网络数量</div><div>${dockerInfo.NContainers || 0}</div></div>
            </div>
          </div>
          <div class="card">
            <h3>资源监控</h3>
            <div class="list">
              <div class="list-item"><div class="list-title">CPU 使用率 ${cpu.toFixed(2)}%</div><div class="progress"><span style="width:${Math.min(100, cpu)}%"></span></div></div>
              <div class="list-item"><div class="list-title">内存使用率 ${mem.toFixed(2)}%</div><div class="progress"><span style="width:${Math.min(100, mem)}%"></span></div></div>
              <div class="list-item"><div class="list-title">网络实时流量</div><div class="text-muted">${netText || "-"}</div></div>
              <div class="list-item"><div class="list-title">Docker Root Dir</div><div class="text-muted">${dockerInfo.DockerRootDir || "-"}</div></div>
            </div>
          </div>
        </section>
      `;
    }

    if (state.dockerTab === "containers") {
      const data = await api("/api/containers/summary");
      const list = data.containers || [];
      bodyHtml = `
        <section class="card">
          <div class="actions" style="justify-content: space-between;">
            <div class="text-muted">总计 ${data.summary.total}，运行 ${data.summary.running}，停止 ${data.summary.stopped}，异常 ${data.summary.error}</div>
            <button id="reloadContainers" class="btn btn-secondary">刷新列表</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>容器</th><th>项目</th><th>状态</th><th>CPU</th><th>内存</th><th>网络</th><th>端口</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${list
                  .map(
                    (c) => `
                      <tr>
                        <td>${c.name}<div class="text-muted">${c.image}</div></td>
                        <td>${c.project}</td>
                        <td><span class="status-dot ${statusClass(c.state)}"></span>${c.status}</td>
                        <td>${c.metrics.cpuPercent}%</td>
                        <td>${formatBytes(c.metrics.memoryBytes)}</td>
                        <td>↓${formatSpeed(c.metrics.netInBytes)}<br />↑${formatSpeed(c.metrics.netOutBytes)}</td>
                        <td>${(c.ports || [])
                          .map((p) => `${p.publicPort || "-"}:${p.privatePort}/${p.type}`)
                          .join("<br />")}</td>
                        <td>
                          <div class="actions">
                            <button class="btn btn-secondary" data-action="start" data-id="${c.id}">启动</button>
                            <button class="btn btn-secondary" data-action="stop" data-id="${c.id}">停止</button>
                            <button class="btn btn-secondary" data-action="restart" data-id="${c.id}">重启</button>
                            <button class="btn btn-secondary" data-action="logs" data-id="${c.id}" data-name="${c.name}">日志</button>
                            <button class="btn btn-danger" data-action="update" data-id="${c.id}">更新</button>
                          </div>
                        </td>
                      </tr>
                    `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </section>
      `;
    }

    if (state.dockerTab === "compose") {
      const projects = await api("/api/containers/compose/projects");
      bodyHtml = `
        <section class="card">
          <div class="actions" style="justify-content: space-between;">
            <h3 style="margin:0;">Compose 项目管理</h3>
            <button id="createComposeBtn" class="btn btn-primary">新建项目</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>项目</th><th>服务数</th><th>容器</th><th>运行</th><th>停止</th><th>来源</th><th>路径</th><th>操作</th></tr></thead>
              <tbody>
                ${projects
                  .map(
                    (p) => `
                      <tr>
                        <td>${p.name}<div class="text-muted">${p.services.join(", ") || "-"}</div></td>
                        <td>${p.services.length}</td>
                        <td>${p.total}</td>
                        <td>${p.running}</td>
                        <td>${p.stopped}</td>
                        <td>${p.sourceType || "-"}</td>
                        <td><div class="text-muted">${p.projectPath || "-"}<br />${p.composeFile || ""}</div></td>
                        <td>
                          <div class="actions">
                            <button class="btn btn-secondary" data-compose-action="start" data-project="${p.name}">启动</button>
                            <button class="btn btn-secondary" data-compose-action="stop" data-project="${p.name}">停止</button>
                            <button class="btn btn-secondary" data-compose-action="restart" data-project="${p.name}">重启</button>
                            <button class="btn btn-danger" data-compose-delete="${p.name}">删除</button>
                          </div>
                        </td>
                      </tr>
                    `
                  )
                  .join("") || "<tr><td colspan='8'>未发现 Compose 项目</td></tr>"}
              </tbody>
            </table>
          </div>
        </section>
      `;
    }

    if (state.dockerTab === "images") {
      const images = await api("/api/containers/images");
      bodyHtml = `
        <section class="card">
          <div class="actions" style="justify-content: space-between;">
            <h3 style="margin:0;">本地镜像</h3>
            <div class="actions">
              <input id="pullImageInput" placeholder="例如: nginx:latest" />
              <button id="pullImageBtn" class="btn btn-primary">拉取镜像</button>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>标签</th><th>ID</th><th>大小</th><th>容器占用</th><th>创建时间</th><th>操作</th></tr></thead>
              <tbody>
                ${images
                  .map(
                    (img) => `
                      <tr>
                        <td>${(img.tags || []).join("<br />") || "<none>"}</td>
                        <td>${img.shortId}</td>
                        <td>${formatBytes(img.size)}</td>
                        <td>${img.containers}</td>
                        <td>${formatDate(img.createdAt)}</td>
                        <td><button class="btn btn-danger" data-image-remove="${img.id}">删除</button></td>
                      </tr>
                    `
                  )
                  .join("") || "<tr><td colspan='6'>暂无镜像</td></tr>"}
              </tbody>
            </table>
          </div>
        </section>
      `;
    }

    if (state.dockerTab === "registry") {
      const registry = await api("/api/containers/registry/settings");
      bodyHtml = `
        <section class="card">
          <h3>仓库设置</h3>
          <div class="grid-3">
            <label>镜像加速器<input id="registryMirrorInput" value="${registry.mirror || ""}" placeholder="https://mirror.example.com" /></label>
            <label>代理地址<input id="registryProxyInput" value="${registry.proxy || ""}" placeholder="http://127.0.0.1:7890" /></label>
            <label>Insecure Registry<input id="registryInsecureInput" value="${registry.insecureRegistry || ""}" placeholder="registry.local:5000" /></label>
          </div>
          <div class="actions" style="margin-top: 10px;">
            <button id="saveRegistrySettingsBtn" class="btn btn-secondary">保存仓库设置</button>
          </div>
        </section>
        <section class="card">
          <h3>镜像搜索</h3>
          <div class="actions">
            <input id="registrySearchInput" placeholder="搜索 Docker Hub 镜像，例如 jellyfin" />
            <button id="registrySearchBtn" class="btn btn-primary">搜索</button>
          </div>
          <div id="registrySearchResult" class="list" style="margin-top: 10px;"></div>
        </section>
      `;
    }

    if (state.dockerTab === "networks") {
      const [networks, containerSummary] = await Promise.all([
        api("/api/containers/networks"),
        api("/api/containers/summary")
      ]);

      const options = (containerSummary.containers || [])
        .map((c) => `<option value="${c.id}">${c.name}</option>`)
        .join("");

      bodyHtml = `
        <section class="card">
          <div class="actions" style="justify-content: space-between;">
            <h3 style="margin:0;">网络管理</h3>
            <div class="actions">
              <input id="networkNameInput" placeholder="新网络名称" />
              <button id="networkCreateBtn" class="btn btn-primary">新建网络</button>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>名称</th><th>驱动</th><th>容器数</th><th>容器管理</th><th>操作</th></tr></thead>
              <tbody>
                ${networks
                  .map(
                    (n) => `
                      <tr>
                        <td>${n.name}</td>
                        <td>${n.driver}</td>
                        <td>${n.containerCount}</td>
                        <td>
                          <div class="actions">
                            <select data-network-container="${n.id}">
                              <option value="">选择容器</option>
                              ${options}
                            </select>
                            <button class="btn btn-secondary" data-network-action="connect" data-network-id="${n.id}">加入</button>
                            <button class="btn btn-secondary" data-network-action="disconnect" data-network-id="${n.id}">移出</button>
                          </div>
                        </td>
                        <td>
                          <button class="btn btn-danger" data-network-remove="${n.id}">删除</button>
                        </td>
                      </tr>
                    `
                  )
                  .join("") || "<tr><td colspan='5'>暂无网络</td></tr>"}
              </tbody>
            </table>
          </div>
        </section>
      `;
    }

    pageContentEl.innerHTML = `
      <section class="card">
        <div class="pill-tabs">
          ${tabs
            .map(
              (t) =>
                `<button class="pill-tab ${state.dockerTab === t.id ? "active" : ""}" data-docker-tab="${t.id}">${t.label}</button>`
            )
            .join("")}
        </div>
      </section>
      ${bodyHtml}
    `;

    pageContentEl.querySelectorAll("[data-docker-tab]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        state.dockerTab = btn.dataset.dockerTab;
        await renderContainers();
      });
    });

    pageContentEl.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        try {
          if (action === "logs") {
            const name = btn.dataset.name || id;
            const logs = await api(`/api/containers/${id}/logs?lines=300`);
            openModal(`日志 - ${name}`, `<textarea readonly>${logs}</textarea>`);
            return;
          }

          if (action === "update") {
            const recreate = confirm("是否执行重建更新？\n确定=拉镜像并重建，取消=仅拉镜像");
            await api(`/api/containers/${id}/update`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ recreate })
            });
            showToast("更新请求已执行");
            await renderContainers();
            return;
          }

          await api(`/api/containers/${id}/${action}`, { method: "POST" });
          showToast(`容器${action}成功`);
          await renderContainers();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    pageContentEl.querySelectorAll("[data-compose-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const project = btn.dataset.project;
          const action = btn.dataset.composeAction;
          await api(`/api/containers/compose/projects/${encodeURIComponent(project)}/${action}`, {
            method: "POST"
          });
          showToast(`项目 ${action} 完成`);
          await renderContainers();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    const createComposeBtn = document.getElementById("createComposeBtn");
    if (createComposeBtn) {
      createComposeBtn.addEventListener("click", () => {
        openModal(
          "创建 Compose 项目",
          `
            <div class="list">
              <label>项目名称<input id="composeProjectName" placeholder="例如 media-stack" /></label>
              <label>来源
                <select id="composeSourceType">
                  <option value="inline">粘贴 compose 内容</option>
                  <option value="existing">使用已有 compose 文件路径</option>
                </select>
              </label>
              <label id="composeContentWrap">Compose 内容<textarea id="composeContentInput" placeholder="services:\\n  app:\\n    image: nginx:latest"></textarea></label>
              <label id="composePathWrap" class="hidden">Compose 文件路径<input id="composePathInput" placeholder="/srv/docker/projects/app/docker-compose.yml" /></label>
              <label class="remember"><input id="composeStartAfterCreate" type="checkbox" checked /><span>创建后立即启动</span></label>
              <button id="composeSubmitBtn" class="btn btn-primary">创建项目</button>
            </div>
          `
        );

        const sourceSelect = document.getElementById("composeSourceType");
        const contentWrap = document.getElementById("composeContentWrap");
        const pathWrap = document.getElementById("composePathWrap");
        sourceSelect.addEventListener("change", () => {
          const usingExisting = sourceSelect.value === "existing";
          contentWrap.classList.toggle("hidden", usingExisting);
          pathWrap.classList.toggle("hidden", !usingExisting);
        });

        document.getElementById("composeSubmitBtn").addEventListener("click", async () => {
          try {
            const name = document.getElementById("composeProjectName").value.trim();
            const sourceType = document.getElementById("composeSourceType").value;
            const composeContent = document.getElementById("composeContentInput").value;
            const composePath = document.getElementById("composePathInput").value.trim();
            const startAfterCreate = document.getElementById("composeStartAfterCreate").checked;
            await api("/api/containers/compose/projects", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name, sourceType, composeContent, composePath, startAfterCreate })
            });
            closeModal();
            showToast("Compose 项目已创建");
            await renderContainers();
          } catch (err) {
            showToast(err.message);
          }
        });
      });
    }

    pageContentEl.querySelectorAll("[data-compose-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const project = btn.dataset.composeDelete;
          const down = confirm("是否先执行 compose down？\n确定=执行 down");
          const removeFiles = confirm("是否同时删除项目目录（仅对面板创建项目生效）？");
          await api(`/api/containers/compose/projects/${encodeURIComponent(project)}?down=${down ? "1" : "0"}&removeFiles=${removeFiles ? "1" : "0"}`, {
            method: "DELETE"
          });
          showToast("Compose 项目已删除");
          await renderContainers();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    const pullBtn = document.getElementById("pullImageBtn");
    if (pullBtn) {
      pullBtn.addEventListener("click", async () => {
        try {
          const image = document.getElementById("pullImageInput").value.trim();
          await api("/api/containers/images/pull", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image })
          });
          showToast("镜像拉取成功");
          await renderContainers();
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    pageContentEl.querySelectorAll("[data-image-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const id = btn.dataset.imageRemove;
          await api(`/api/containers/images/${encodeURIComponent(id)}?force=1`, { method: "DELETE" });
          showToast("镜像删除成功");
          await renderContainers();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    const registryBtn = document.getElementById("registrySearchBtn");
    if (registryBtn) {
      registryBtn.addEventListener("click", async () => {
        try {
          const q = document.getElementById("registrySearchInput").value.trim();
          const result = await api(`/api/containers/registry/search?q=${encodeURIComponent(q)}&limit=20`);
          const box = document.getElementById("registrySearchResult");
          box.innerHTML =
            result.results
              .map(
                (r) => `<div class="list-item">
                  <div class="list-title">${r.name}</div>
                  <div class="text-muted">${r.shortDescription || "-"}</div>
                  <div class="text-muted">⭐ ${r.starCount} · Pulls ${r.pullCount}</div>
                  <button class="btn btn-secondary" data-registry-pull="${r.name}">拉取</button>
                </div>`
              )
              .join("") || '<div class="text-muted">无结果</div>';

          box.querySelectorAll("[data-registry-pull]").forEach((btn) => {
            btn.addEventListener("click", async () => {
              const image = btn.dataset.registryPull;
              try {
                await api("/api/containers/images/pull", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ image })
                });
                showToast(`已拉取 ${image}`);
              } catch (err) {
                showToast(err.message);
              }
            });
          });
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    const saveRegistrySettingsBtn = document.getElementById("saveRegistrySettingsBtn");
    if (saveRegistrySettingsBtn) {
      saveRegistrySettingsBtn.addEventListener("click", async () => {
        try {
          const payload = {
            mirror: document.getElementById("registryMirrorInput").value.trim(),
            proxy: document.getElementById("registryProxyInput").value.trim(),
            insecureRegistry: document.getElementById("registryInsecureInput").value.trim()
          };
          await api("/api/containers/registry/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          showToast("仓库设置已保存");
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    const createNetworkBtn = document.getElementById("networkCreateBtn");
    if (createNetworkBtn) {
      createNetworkBtn.addEventListener("click", async () => {
        try {
          const name = document.getElementById("networkNameInput").value.trim();
          await api("/api/containers/networks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, driver: "bridge", attachable: true })
          });
          showToast("网络已创建");
          await renderContainers();
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    pageContentEl.querySelectorAll("[data-network-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/containers/networks/${btn.dataset.networkRemove}`, { method: "DELETE" });
          showToast("网络已删除");
          await renderContainers();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    pageContentEl.querySelectorAll("[data-network-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const networkId = btn.dataset.networkId;
          const action = btn.dataset.networkAction;
          const select = pageContentEl.querySelector(`[data-network-container="${networkId}"]`);
          const containerId = select?.value || "";
          if (!containerId) {
            showToast("请先选择容器");
            return;
          }
          await api(`/api/containers/networks/${networkId}/${action}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ containerId, force: true })
          });
          showToast("网络操作成功");
          await renderContainers();
        } catch (err) {
          showToast(err.message);
        }
      });
    });
  } catch (err) {
    pageContentEl.innerHTML = `<div class="card">加载失败：${err.message}</div>`;
  }
}

async function renderMedia() {
  try {
    const [data, integrations, library] = await Promise.all([
      api("/api/media/summary"),
      api("/api/settings/integrations"),
      api(
        `/api/media/library?types=${encodeURIComponent(state.mediaFilterType)}&search=${encodeURIComponent(
          state.mediaSearchKeyword
        )}&limit=36`
      )
    ]);
    const cw = data.continueWatching || [];
    const latest = data.latest || [];
    const sessions = data.sessions || [];
    const notConfigured = data.configured === false;
    const baseUrl = String(integrations.jellyfinBaseUrl || "").replace(/\/$/, "");
    const latestCards = latest.map((item) => {
      const detailUrl = baseUrl ? `${baseUrl}/web/index.html#!/details?id=${item.Id}` : "#";
      return `
        <div class="list-item">
          ${
            item.imageUrl
              ? `<img src="${item.imageUrl}" alt="${item.Name || ""}" style="width:100%;height:120px;object-fit:cover;border-radius:10px;" />`
              : ""
          }
          <div class="list-title">${item.Name || "未命名"}</div>
          <div class="text-muted">${item.Type || "-"} · ${formatDate(item.DateCreated)}</div>
          ${baseUrl ? `<a class="btn btn-secondary" href="${detailUrl}" target="_blank">打开详情</a>` : ""}
        </div>
      `;
    });

    const mediaTypes = [
      { value: "", label: "全部" },
      { value: "Movie", label: "电影" },
      { value: "Series", label: "剧集" },
      { value: "Episode", label: "剧集单集" },
      { value: "MusicVideo", label: "MV" }
    ];

    const wallItems = (library.items || []).map((item) => {
      const detailUrl = baseUrl ? `${baseUrl}/web/index.html#!/details?id=${item.Id}` : "#";
      return `
        <div class="list-item media-wall-card">
          ${
            item.imageUrl
              ? `<img src="${item.imageUrl}" alt="${item.Name || ""}" class="media-poster" />`
              : `<div class="media-poster media-poster-empty">无封面</div>`
          }
          <div class="list-title">${item.Name || "未命名"}</div>
          <div class="text-muted">${item.Type || "-"} · ${formatDate(item.DateCreated)}</div>
          ${baseUrl ? `<a class="btn btn-secondary" href="${detailUrl}" target="_blank">播放 / 详情</a>` : ""}
        </div>
      `;
    });

    pageContentEl.innerHTML = `
      <section class="card">
        <div class="actions" style="justify-content: space-between;">
          <div class="text-muted">活跃会话 ${data.summary.activeSessions}</div>
          <div class="actions">
            <button id="mediaRefreshBtn" class="btn btn-secondary">刷新页面</button>
            <button id="libraryRefreshBtn" class="btn btn-primary">刷新媒体库</button>
          </div>
        </div>
        ${notConfigured ? `<div class="text-muted" style="margin-top:8px;">${data.reason || "影视模块未配置，当前展示空数据。请到“设置”补全 Jellyfin 配置。"}</div>` : ""}
      </section>

      <section class="grid-3">
        <div class="card">
          <h3>继续观看</h3>
          <div class="list">
            ${cw
              .map(
                (item) => `<div class="list-item">
                  <div class="list-title">${item.Name || "未命名"}</div>
                  <div class="text-muted">进度 ${(item.UserData?.PlayedPercentage || 0).toFixed(1)}%</div>
                  ${
                    baseUrl
                      ? `<a class="btn btn-secondary" href="${baseUrl}/web/index.html#!/details?id=${item.Id}" target="_blank">继续播放</a>`
                      : ""
                  }
                </div>`
              )
              .join("") || '<div class="text-muted">暂无数据</div>'}
          </div>
        </div>
        <div class="card">
          <h3>最近添加</h3>
          <div class="grid-2">
            ${latestCards.join("") || '<div class="text-muted">暂无数据</div>'}
          </div>
        </div>
        <div class="card">
          <h3>活跃会话</h3>
          <div class="list">
            ${sessions
              .map(
                (s) => `<div class="list-item"><div class="list-title">${s.NowPlayingItem?.Name || "空闲"}</div><div class="text-muted">${s.UserName || "-"} · ${s.DeviceName || "-"}</div></div>`
              )
              .join("") || '<div class="text-muted">暂无会话</div>'}
          </div>
        </div>
      </section>

      <section class="card">
        <div class="actions" style="justify-content: space-between;">
          <div class="pill-tabs">
            ${mediaTypes
              .map(
                (t) =>
                  `<button class="pill-tab ${state.mediaFilterType === t.value ? "active" : ""}" data-media-type="${t.value}">${t.label}</button>`
              )
              .join("")}
          </div>
          <div class="actions">
            <input id="mediaSearchInput" placeholder="搜索影视名称" value="${state.mediaSearchKeyword || ""}" />
            <button id="mediaSearchBtn" class="btn btn-secondary">筛选</button>
          </div>
        </div>
        <div class="text-muted" style="margin-top:8px;">媒体库总条目：${library.total || 0}${library.configured === false ? `（${library.reason || "未连接"}）` : ""}</div>
        <div class="grid-4 media-wall" style="margin-top: 12px;">
          ${wallItems.join("") || '<div class="text-muted">暂无媒体库数据</div>'}
        </div>
      </section>
    `;

    document.getElementById("mediaRefreshBtn").addEventListener("click", renderMedia);
    document.getElementById("libraryRefreshBtn").addEventListener("click", async () => {
      try {
        await api("/api/media/refresh", { method: "POST" });
        showToast("媒体库刷新已触发");
      } catch (err) {
        showToast(err.message);
      }
    });

    pageContentEl.querySelectorAll("[data-media-type]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        state.mediaFilterType = btn.dataset.mediaType || "";
        await renderMedia();
      });
    });

    const mediaSearchBtn = document.getElementById("mediaSearchBtn");
    mediaSearchBtn.addEventListener("click", async () => {
      state.mediaSearchKeyword = document.getElementById("mediaSearchInput").value.trim();
      await renderMedia();
    });
  } catch (err) {
    pageContentEl.innerHTML = `<div class="card">加载失败：${err.message}</div>`;
  }
}

async function renderDownloads() {
  try {
    const filters = [
      { id: "all", label: "全部" },
      { id: "downloading", label: "下载中" },
      { id: "completed", label: "完成" },
      { id: "uploading", label: "做种" },
      { id: "active", label: "活动" },
      { id: "inactive", label: "空闲" },
      { id: "paused", label: "暂停" },
      { id: "errored", label: "错误" }
    ];

    const [summaryData, allTasks, filteredTasks] = await Promise.all([
      api("/api/downloads/summary"),
      api("/api/downloads/tasks?filter=all"),
      state.downloadsFilter === "all"
        ? Promise.resolve([])
        : api(`/api/downloads/tasks?filter=${encodeURIComponent(state.downloadsFilter)}`)
    ]);
    const tasks = state.downloadsFilter === "all" ? allTasks : filteredTasks;
    const notConfigured = summaryData.configured === false;
    const selectedTask = tasks.find((t) => t.hash === state.downloadsDetailHash) || tasks[0] || null;
    state.downloadsDetailHash = selectedTask?.hash || "";

    const predicates = {
      all: () => true,
      downloading: (t) => String(t.state || "").includes("downloading"),
      completed: (t) => Number(t.progress || 0) >= 1,
      uploading: (t) => {
        const s = String(t.state || "");
        return s.includes("upload") || s.includes("seed");
      },
      active: (t) => Number(t.dlspeed || 0) > 0 || Number(t.upspeed || 0) > 0,
      inactive: (t) => Number(t.dlspeed || 0) === 0 && Number(t.upspeed || 0) === 0,
      paused: (t) => String(t.state || "").includes("paused"),
      errored: (t) => {
        const s = String(t.state || "");
        return s.includes("error") || s.includes("missing");
      }
    };

    pageContentEl.innerHTML = `
      <section class="split">
        <aside class="menu-list">
          <div class="nav-group-title" style="margin-top:0;">任务分类</div>
          ${filters
            .map(
              (f) =>
                `<button class="menu-item ${state.downloadsFilter === f.id ? "active" : ""}" data-download-filter="${f.id}">
                  ${f.label} (${allTasks.filter(predicates[f.id] || predicates.all).length})
                </button>`
            )
            .join("")}
        </aside>
        <div class="card">
          <div class="actions" style="justify-content: space-between; align-items: center;">
            <div class="text-muted">下载中 ${summaryData.summary.downloading} · 做种 ${summaryData.summary.seeding} · 完成 ${summaryData.summary.completed} · ↓${formatSpeed(summaryData.summary.dlSpeed)} ↑${formatSpeed(summaryData.summary.upSpeed)}</div>
            <div class="actions">
              <button id="downloadRefreshBtn" class="btn btn-secondary">刷新</button>
              <button id="addSourceBtn" class="btn btn-primary">添加任务</button>
              <button id="addTorrentBtn" class="btn btn-secondary">上传本地种子</button>
            </div>
          </div>
          ${notConfigured ? `<div class="text-muted" style="margin-top:8px;">${summaryData.reason || "下载模块未配置，当前展示空数据。请到“设置”补全 qBittorrent 配置。"}</div>` : ""}
          <div class="table-wrap" style="margin-top:10px;">
            <table>
              <thead>
                <tr>
                  <th>任务</th><th>状态</th><th>进度</th><th>速度</th><th>剩余</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${tasks
                  .map(
                    (t) => `
                    <tr data-download-row="${t.hash}" style="cursor:pointer;">
                      <td>${t.name}<div class="text-muted">${formatBytes(t.size)}</div></td>
                      <td>${t.state}</td>
                      <td><div>${(t.progress * 100).toFixed(2)}%</div><div class="progress"><span style="width:${Math.min(100, t.progress * 100)}%"></span></div></td>
                      <td>↓${formatSpeed(t.dlspeed)} ↑${formatSpeed(t.upspeed)}</td>
                      <td>${t.eta > 0 ? `${Math.round(t.eta / 60)} 分钟` : "-"}</td>
                      <td>
                        <div class="actions">
                          <button class="btn btn-secondary" data-qaction="pause" data-hash="${t.hash}">暂停</button>
                          <button class="btn btn-secondary" data-qaction="resume" data-hash="${t.hash}">继续</button>
                          <button class="btn btn-danger" data-qaction="delete" data-hash="${t.hash}">删除</button>
                        </div>
                      </td>
                    </tr>
                  `
                  )
                  .join("") || "<tr><td colspan='6'>暂无任务</td></tr>"}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      <section class="card table-wrap">
        <h3>任务详情</h3>
        ${
          selectedTask
            ? `<div class="grid-3">
                <div class="list-item"><div class="list-title">名称</div><div>${selectedTask.name}</div></div>
                <div class="list-item"><div class="list-title">Hash</div><div class="text-muted">${selectedTask.hash}</div></div>
                <div class="list-item"><div class="list-title">状态</div><div>${selectedTask.state}</div></div>
                <div class="list-item"><div class="list-title">下载路径</div><div class="text-muted">${selectedTask.save_path || "-"}</div></div>
                <div class="list-item"><div class="list-title">连接数</div><div>${selectedTask.num_seeds || 0}/${selectedTask.num_leechs || 0}</div></div>
                <div class="list-item"><div class="list-title">剩余</div><div>${selectedTask.amount_left ? formatBytes(selectedTask.amount_left) : "-"}</div></div>
              </div>`
            : '<div class="text-muted">请选择一个任务查看详情</div>'
        }
      </section>
    `;

    pageContentEl.querySelectorAll("[data-download-filter]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        state.downloadsFilter = btn.dataset.downloadFilter;
        await renderDownloads();
      });
    });

    pageContentEl.querySelectorAll("[data-download-row]").forEach((row) => {
      row.addEventListener("click", async () => {
        state.downloadsDetailHash = row.dataset.downloadRow;
        await renderDownloads();
      });
    });

    document.getElementById("downloadRefreshBtn").addEventListener("click", renderDownloads);

    document.getElementById("addSourceBtn").addEventListener("click", () => {
      openModal(
        "添加下载任务",
        `
        <div class="list">
          <label>来源类型
            <select id="downloadSourceType">
              <option value="link">下载链接 / 磁力</option>
              <option value="flyshare">飞牛分享链接</option>
              <option value="nas-torrent">NAS 种子文件路径</option>
            </select>
          </label>
          <label id="downloadSourceInputWrap">来源内容<textarea id="downloadSourceInput" placeholder="magnet:?xt=... 或 http(s)://...（可多行）"></textarea></label>
          <label id="downloadNasPathWrap" class="hidden">NAS 种子路径<input id="downloadNasPathInput" placeholder="/srv/downloads/seeds/demo.torrent" /></label>
          <label>保存路径（可选）<input id="downloadSavePath" placeholder="/srv/downloads" /></label>
          <button id="submitSource" class="btn btn-primary">提交</button>
        </div>
      `
      );

      const sourceTypeEl = document.getElementById("downloadSourceType");
      const sourceInputWrap = document.getElementById("downloadSourceInputWrap");
      const nasPathWrap = document.getElementById("downloadNasPathWrap");
      sourceTypeEl.addEventListener("change", () => {
        const isNas = sourceTypeEl.value === "nas-torrent";
        sourceInputWrap.classList.toggle("hidden", isNas);
        nasPathWrap.classList.toggle("hidden", !isNas);
      });

      document.getElementById("submitSource").addEventListener("click", async () => {
        try {
          const type = document.getElementById("downloadSourceType").value;
          const source =
            type === "nas-torrent"
              ? document.getElementById("downloadNasPathInput").value.trim()
              : document.getElementById("downloadSourceInput").value.trim();
          const savepath = document.getElementById("downloadSavePath").value.trim();
          await api("/api/downloads/add-source", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type, source, savepath })
          });
          closeModal();
          showToast("任务已添加");
          await renderDownloads();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    document.getElementById("addTorrentBtn").addEventListener("click", () => {
      openModal(
        "上传种子任务",
        `
        <div class="list">
          <label>种子文件<input id="torrentFile" type="file" accept=".torrent" /></label>
          <label>保存路径（可选）<input id="torrentSavePath" placeholder="/srv/downloads" /></label>
          <button id="submitTorrent" class="btn btn-primary">提交</button>
        </div>
      `
      );

      document.getElementById("submitTorrent").addEventListener("click", async () => {
        try {
          const fileInput = document.getElementById("torrentFile");
          if (!fileInput.files || !fileInput.files[0]) {
            showToast("请选择 .torrent 文件");
            return;
          }

          const form = new FormData();
          form.append("torrent", fileInput.files[0]);
          form.append("savepath", document.getElementById("torrentSavePath").value.trim());

          await api("/api/downloads/add-torrent", {
            method: "POST",
            body: form
          });

          closeModal();
          showToast("种子任务已添加");
          await renderDownloads();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    pageContentEl.querySelectorAll("button[data-qaction]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.qaction;
        const hash = btn.dataset.hash;
        try {
          if (action === "delete") {
            const deleteFiles = confirm("是否同时删除文件？\n确定=删除文件，取消=仅删除任务");
            await api("/api/downloads/delete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ hashes: hash, deleteFiles })
            });
          } else {
            await api(`/api/downloads/${action}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ hashes: hash })
            });
          }
          showToast("操作成功");
          await renderDownloads();
        } catch (err) {
          showToast(err.message);
        }
      });
    });
  } catch (err) {
    pageContentEl.innerHTML = `<div class="card">加载失败：${err.message}</div>`;
  }
}

async function renderApps() {
  try {
    const [apps, tasks, bundles] = await Promise.all([
      api("/api/apps"),
      api("/api/apps/tasks?limit=80"),
      api("/api/apps/bundles")
    ]);
    const integrations = await api("/api/settings/integrations");
    const mediaBundle = bundles.find((b) => b.id === "media-stack");
    const activeTasks = tasks.filter((t) => t.status === "queued" || t.status === "running");
    const taskByApp = new Map();
    for (const t of activeTasks) {
      if (!taskByApp.has(t.app_id)) taskByApp.set(t.app_id, t);
    }

    const categories = ["all", ...new Set(apps.map((a) => a.category || "其他"))];
    const filteredApps =
      state.appsCategory === "all"
        ? apps
        : apps.filter((a) => (a.category || "其他") === state.appsCategory);

    const appCards = filteredApps
      .map((app) => {
        const statusText = app.installed ? (app.running ? "运行中" : "已安装") : "未安装";
        const openUrl = app.openPortKey ? `http://${location.hostname}:${integrations[app.openPortKey]}` : "";
        const activeTask = taskByApp.get(app.id);
        const busy = Boolean(activeTask);
        const healthColor =
          app.health === "healthy" || app.health === "running"
            ? "status-running"
            : app.health === "unhealthy"
              ? "status-error"
              : "status-other";
        return `
          <div class="card app-store-card">
            <div class="actions" style="justify-content: space-between; align-items: flex-start;">
              <div class="actions" style="align-items:center;">
                <div class="app-avatar">${(app.name || "A").slice(0, 1)}</div>
                <div>
                  <div class="list-title">${app.name}</div>
                  <div class="text-muted">${app.category || "-"}</div>
                </div>
              </div>
              <span class="status-chip ${healthColor}">${statusText}</span>
            </div>
            <p class="text-muted">${app.description || ""}</p>
            <p class="text-muted">容器：${app.containerName}</p>
            ${
              activeTask
                ? `<div class="list-item"><div class="list-title">任务 #${activeTask.id} ${activeTask.action}</div><div class="text-muted">${activeTask.message || ""}</div><div class="progress"><span style="width:${activeTask.progress}%"></span></div></div>`
                : ""
            }
            <div class="actions">
              ${
                !app.installed
                  ? `<button class="btn btn-primary" data-app-action="install" data-app-id="${app.id}" ${busy ? "disabled" : ""}>安装</button>`
                  : `
                    <button class="btn btn-secondary" data-app-action="start" data-app-id="${app.id}" ${busy ? "disabled" : ""}>启动</button>
                    <button class="btn btn-secondary" data-app-action="stop" data-app-id="${app.id}" ${busy ? "disabled" : ""}>停止</button>
                    <button class="btn btn-secondary" data-app-action="restart" data-app-id="${app.id}" ${busy ? "disabled" : ""}>重启</button>
                    <button class="btn btn-danger" data-app-action="uninstall" data-app-id="${app.id}" ${busy ? "disabled" : ""}>卸载</button>
                    ${openUrl ? `<a class="btn btn-secondary" href="${openUrl}" target="_blank">打开</a>` : ""}
                  `
              }
              <button class="btn btn-secondary" data-app-perm="${app.id}">权限设置</button>
              <button class="btn btn-secondary" data-app-detail="${app.id}">详情</button>
            </div>
          </div>
        `;
      })
      .join("");

    pageContentEl.innerHTML = `
      <section class="card">
        <h3>应用中心</h3>
        <p class="text-muted">支持应用商店式安装、启动、卸载、权限配置与任务追踪。</p>
        <div class="banner-lite">
          <div>
            <div class="list-title">NAS 必备套件</div>
            <div class="text-muted">一键部署 Jellyfin + qBittorrent + Watchtower</div>
          </div>
          ${
            mediaBundle
              ? `<button class="btn btn-primary" data-bundle-install="${mediaBundle.id}">安装 ${mediaBundle.name}</button>`
              : ""
          }
        </div>
        <div class="pill-tabs" style="margin-top: 10px;">
          ${categories
            .map(
              (c) =>
                `<button class="pill-tab ${state.appsCategory === c ? "active" : ""}" data-app-category="${c}">${c === "all" ? "全部" : c}</button>`
            )
            .join("")}
        </div>
        ${
          filteredApps.length === 0
            ? '<div class="text-muted" style="margin-top:8px;">当前分类暂无应用</div>'
            : ""
        }
      </section>
      <section class="grid-2">${appCards}</section>
      <section class="card">
        <h3>任务中心</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>ID</th><th>应用</th><th>动作</th><th>状态</th><th>进度</th><th>信息</th><th>错误</th><th>来源</th><th>时间</th><th>操作</th></tr></thead>
            <tbody>
              ${
                tasks
                  .map(
                    (t) => `<tr>
                      <td>#${t.id}</td>
                      <td>${t.app_id}</td>
                      <td>${t.action}</td>
                      <td>${t.status}</td>
                      <td>${t.progress}%</td>
                      <td>${t.message || "-"}</td>
                      <td>${t.error_detail || "-"}</td>
                      <td>${t.retried_from ? `重试 #${t.retried_from}` : "-"}</td>
                      <td>${formatDate(t.created_at)}</td>
                      <td>
                        <div class="actions">
                          <button class="btn btn-secondary" data-task-action="logs" data-task-id="${t.id}">日志</button>
                          ${
                            t.status === "failed"
                              ? `<button class="btn btn-danger" data-task-action="retry" data-task-id="${t.id}">重试</button>`
                              : ""
                          }
                        </div>
                      </td>
                    </tr>`
                  )
                  .join("") || "<tr><td colspan='10'>暂无任务</td></tr>"
              }
            </tbody>
          </table>
        </div>
      </section>
    `;

    pageContentEl.querySelectorAll("[data-app-category]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        state.appsCategory = btn.dataset.appCategory;
        await renderApps();
      });
    });

    pageContentEl.querySelectorAll("[data-app-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.appAction;
        const appId = btn.dataset.appId;
        try {
          if (action === "install") {
            const task = await api(`/api/apps/${appId}/install`, { method: "POST" });
            showToast(`任务已创建 #${task.id}`);
          } else if (action === "uninstall") {
            const removeData = confirm("是否同时删除应用数据目录？");
            const task = await api(`/api/apps/${appId}?removeData=${removeData ? "1" : "0"}`, {
              method: "DELETE"
            });
            showToast(`任务已创建 #${task.id}`);
          } else {
            const task = await api(`/api/apps/${appId}/${action}`, { method: "POST" });
            showToast(`任务已创建 #${task.id}`);
          }
          await renderApps();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    pageContentEl.querySelectorAll("[data-app-detail]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const app = apps.find((a) => a.id === btn.dataset.appDetail);
        if (!app) return;
        const openUrl = app.openPortKey ? `http://${location.hostname}:${integrations[app.openPortKey]}` : "";
        openModal(
          `应用详情 - ${app.name}`,
          `
            <div class="list">
              <div class="list-item"><div class="list-title">分类</div><div>${app.category || "-"}</div></div>
              <div class="list-item"><div class="list-title">镜像</div><div class="text-muted">${app.image || "-"}</div></div>
              <div class="list-item"><div class="list-title">容器名</div><div>${app.containerName || "-"}</div></div>
              <div class="list-item"><div class="list-title">状态</div><div>${app.status || "-"}</div></div>
              <div class="list-item"><div class="list-title">说明</div><div>${app.description || "-"}</div></div>
              ${openUrl ? `<a class="btn btn-primary" href="${openUrl}" target="_blank">打开应用</a>` : ""}
            </div>
          `
        );
      });
    });

    pageContentEl.querySelectorAll("[data-app-perm]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const appId = btn.dataset.appPerm;
        const app = apps.find((a) => a.id === appId);
        if (!app) return;
        try {
          const permissions = await api(`/api/apps/${appId}/permissions`);
          const rowsHtml = (permissions.length
            ? permissions
            : [{ path: "/srv/media", permission: "ro", visibility: "all-users" }]
          )
            .map(
              (p, idx) => `
                <div class="actions app-perm-row" data-perm-row="${idx}">
                  <input data-perm-path value="${p.path || ""}" placeholder="/srv/media" />
                  <select data-perm-right><option value="ro" ${p.permission === "ro" ? "selected" : ""}>只读</option><option value="rw" ${p.permission === "rw" ? "selected" : ""}>读写</option></select>
                  <select data-perm-visibility><option value="admin-only" ${p.visibility === "admin-only" ? "selected" : ""}>仅管理员</option><option value="all-users" ${p.visibility === "all-users" ? "selected" : ""}>设备所有用户</option></select>
                  <button class="btn btn-danger" data-remove-perm-row>删除</button>
                </div>
              `
            )
            .join("");

          openModal(
            `权限设置 - ${app.name}`,
            `
              <div class="list">
                <div id="permRows">${rowsHtml}</div>
                <button id="addPermRowBtn" class="btn btn-secondary">新增目录权限</button>
                <button id="savePermBtn" class="btn btn-primary">保存权限</button>
              </div>
            `
          );

          const bindRemoveRow = () => {
            document.querySelectorAll("[data-remove-perm-row]").forEach((removeBtn) => {
              removeBtn.onclick = () => {
                removeBtn.closest(".app-perm-row")?.remove();
              };
            });
          };
          bindRemoveRow();

          document.getElementById("addPermRowBtn").addEventListener("click", () => {
            const wrap = document.getElementById("permRows");
            const row = document.createElement("div");
            row.className = "actions app-perm-row";
            row.innerHTML = `
              <input data-perm-path placeholder="/srv/downloads" />
              <select data-perm-right><option value="ro">只读</option><option value="rw" selected>读写</option></select>
              <select data-perm-visibility><option value="admin-only">仅管理员</option><option value="all-users" selected>设备所有用户</option></select>
              <button class="btn btn-danger" data-remove-perm-row>删除</button>
            `;
            wrap.appendChild(row);
            bindRemoveRow();
          });

          document.getElementById("savePermBtn").addEventListener("click", async () => {
            try {
              const permissionsPayload = [];
              document.querySelectorAll(".app-perm-row").forEach((rowEl) => {
                const pathValue = rowEl.querySelector("[data-perm-path]")?.value?.trim();
                if (!pathValue) return;
                permissionsPayload.push({
                  path: pathValue,
                  permission: rowEl.querySelector("[data-perm-right]")?.value || "rw",
                  visibility: rowEl.querySelector("[data-perm-visibility]")?.value || "all-users"
                });
              });

              await api(`/api/apps/${appId}/permissions`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ permissions: permissionsPayload })
              });
              showToast("应用权限已保存");
              closeModal();
            } catch (err) {
              showToast(err.message);
            }
          });
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    pageContentEl.querySelectorAll("[data-bundle-install]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const bundleId = btn.dataset.bundleInstall;
          const task = await api(`/api/apps/bundles/${bundleId}/install`, {
            method: "POST"
          });
          showToast(`套件任务已创建 #${task.id}`);
          await renderApps();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    pageContentEl.querySelectorAll("[data-task-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.taskAction;
        const taskId = btn.dataset.taskId;
        try {
          if (action === "retry") {
            const task = await api(`/api/apps/tasks/${taskId}/retry`, { method: "POST" });
            showToast(`重试任务已创建 #${task.id}`);
            await renderApps();
            return;
          }

          openModal(
            `任务日志 #${taskId}`,
            `<p class="text-muted">每 2 秒自动刷新，关闭弹窗后自动停止。</p><textarea id="taskLogBox" readonly></textarea>`
          );

          const textarea = document.getElementById("taskLogBox");
          let lastLen = 0;
          const loadLogs = async () => {
            const logs = await api(`/api/apps/tasks/${taskId}/logs`);
            const text = logs.logText || "";
            const shouldStickBottom =
              !textarea.value ||
              textarea.scrollTop + textarea.clientHeight + 24 >= textarea.scrollHeight ||
              text.length < lastLen;
            textarea.value = text;
            lastLen = text.length;
            if (shouldStickBottom) {
              textarea.scrollTop = textarea.scrollHeight;
            }
          };

          await loadLogs();
          state.modalTimer = setInterval(() => {
            loadLogs().catch((err) => {
              showToast(err.message);
              clearModalTimer();
            });
          }, 2000);
        } catch (err) {
          showToast(err.message);
        }
      });
    });
  } catch (err) {
    pageContentEl.innerHTML = `<div class="card">加载失败：${err.message}</div>`;
  }
}

async function renderSSL() {
  try {
    const certs = await api("/api/ssl/certs");

    pageContentEl.innerHTML = `
      <section class="card">
        <h3>签发新证书（Cloudflare DNS）</h3>
        <div class="grid-3">
          <label>主域名<input id="sslDomain" placeholder="nas.example.com" /></label>
          <label>SAN（逗号分隔）<input id="sslSans" placeholder="media.example.com,download.example.com" /></label>
          <label>通知邮箱（可选）<input id="sslEmail" placeholder="admin@example.com" /></label>
        </div>
        <div class="actions" style="margin-top: 10px;">
          <button id="issueCertBtn" class="btn btn-primary">签发证书</button>
        </div>
      </section>

      <section class="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>域名</th><th>有效期</th><th>状态</th><th>绑定路由</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${certs
              .map(
                (c) => `
                <tr>
                  <td>${c.domain}<div class="text-muted">${(c.sans || []).join(", ")}</div></td>
                  <td>${formatDate(c.valid_from)} ~ ${formatDate(c.valid_to)}</td>
                  <td>${c.status}</td>
                  <td>${(c.bound_routes || []).join("<br />") || "-"}</td>
                  <td>
                    <div class="actions">
                      <button class="btn btn-secondary" data-ssl-action="renew" data-id="${c.id}">续期</button>
                      <button class="btn btn-secondary" data-ssl-action="bind" data-id="${c.id}">绑定</button>
                      <a class="btn btn-secondary" href="/api/ssl/certs/${c.id}/download?type=fullchain" target="_blank">下载</a>
                      <button class="btn btn-danger" data-ssl-action="delete" data-id="${c.id}">删除</button>
                    </div>
                  </td>
                </tr>
              `
              )
              .join("")}
          </tbody>
        </table>
      </section>
    `;

    document.getElementById("issueCertBtn").addEventListener("click", async () => {
      try {
        const domain = document.getElementById("sslDomain").value.trim();
        const sans = document
          .getElementById("sslSans")
          .value.split(",")
          .map((v) => v.trim())
          .filter(Boolean);
        const email = document.getElementById("sslEmail").value.trim();

        await api("/api/ssl/certs/issue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain, sans, email, autoRenew: true })
        });

        showToast("签发请求完成");
        await renderSSL();
      } catch (err) {
        showToast(err.message);
      }
    });

    pageContentEl.querySelectorAll("button[data-ssl-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.sslAction;
        const id = btn.dataset.id;
        try {
          if (action === "renew") {
            await api(`/api/ssl/certs/${id}/renew`, { method: "POST" });
          } else if (action === "bind") {
            const routes = prompt("请输入绑定路由，逗号分隔", "/,/media,/downloads") || "";
            await api(`/api/ssl/certs/${id}/bind`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ routes: routes.split(",").map((v) => v.trim()).filter(Boolean) })
            });
          } else if (action === "delete") {
            if (!confirm("确认删除该证书记录？")) return;
            await api(`/api/ssl/certs/${id}`, { method: "DELETE" });
          }

          showToast("操作成功");
          await renderSSL();
        } catch (err) {
          showToast(err.message);
        }
      });
    });
  } catch (err) {
    pageContentEl.innerHTML = `<div class="card">加载失败：${err.message}</div>`;
  }
}

async function renderSettings() {
  try {
    const menus = [
      { id: "device", label: "设备信息" },
      { id: "users", label: "用户管理" },
      { id: "groups", label: "用户组" },
      { id: "storage", label: "存储空间" },
      { id: "network", label: "网络设置" },
      { id: "remote", label: "远程访问" },
      { id: "security", label: "安全性" },
      { id: "share", label: "文件共享协议" },
      { id: "integrations", label: "集成配置" },
      { id: "audit", label: "审计日志" }
    ];

    let body = "";

    if (state.systemMenu === "device") {
      const [overview, capabilities] = await Promise.all([
        api("/api/system/device-overview"),
        api("/api/system/capabilities")
      ]);

      body = `
        <section class="card">
          <h3>设备概览</h3>
          <div class="grid-3">
            <div class="list-item"><div class="list-title">主机名</div><div>${overview.device.hostname || "-"}</div></div>
            <div class="list-item"><div class="list-title">系统</div><div>${overview.device.distro} ${overview.device.release}</div></div>
            <div class="list-item"><div class="list-title">内核</div><div>${overview.device.kernel}</div></div>
            <div class="list-item"><div class="list-title">CPU</div><div>${overview.hardware.cpuBrand}</div></div>
            <div class="list-item"><div class="list-title">核心</div><div>${overview.hardware.physicalCores}C / ${overview.hardware.cores}T</div></div>
            <div class="list-item"><div class="list-title">内存</div><div>${formatBytes(overview.hardware.memoryTotal)}</div></div>
          </div>
          <div class="list" style="margin-top:10px;">
            <div class="list-item"><div class="list-title">宿主控制能力</div><div class="text-muted">服务控制：${capabilities.allowHostServiceControl ? "已启用" : "未启用"}；网络写入：${capabilities.allowHostNetworkApply ? "已启用" : "未启用"}</div></div>
          </div>
        </section>
      `;
    }

    if (state.systemMenu === "users") {
      const users = await api("/api/system/users");
      body = `
        <section class="card">
          <div class="actions" style="justify-content: space-between;">
            <h3 style="margin:0;">用户管理</h3>
            <div class="actions">
              <input id="newUserName" placeholder="用户名" />
              <input id="newUserPass" placeholder="初始密码(>=8位)" />
              <select id="newUserRole"><option value="user">user</option><option value="admin">admin</option></select>
              <button id="createUserBtn" class="btn btn-primary">新建用户</button>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>ID</th><th>用户名</th><th>角色</th><th>用户组</th><th>配额</th><th>操作</th></tr></thead>
              <tbody>
                ${users
                  .map(
                    (u) => `<tr>
                      <td>${u.id}</td>
                      <td>${u.username}</td>
                      <td>${u.role}</td>
                      <td>${(u.groups || []).join(", ") || "-"}</td>
                      <td>${(u.quotas || []).map((q) => `${q.mountPath}: ${formatBytes(q.quotaBytes)}`).join("<br />") || "-"}</td>
                      <td>
                        <div class="actions">
                          <button class="btn btn-secondary" data-user-role="${u.id}" data-next-role="${u.role === "admin" ? "user" : "admin"}">切换角色</button>
                          <button class="btn btn-secondary" data-user-reset="${u.id}">重置密码</button>
                          <button class="btn btn-secondary" data-user-quota="${u.id}" data-user-name="${u.username}">配额</button>
                          <button class="btn btn-danger" data-user-delete="${u.id}">删除</button>
                        </div>
                      </td>
                    </tr>`
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </section>
      `;
    }

    if (state.systemMenu === "groups") {
      const [groups, users] = await Promise.all([api("/api/system/groups"), api("/api/system/users")]);
      const userOptions = users.map((u) => `<option value="${u.id}">${u.username}</option>`).join("");
      body = `
        <section class="card">
          <div class="actions" style="justify-content: space-between;">
            <h3 style="margin:0;">用户组管理</h3>
            <div class="actions">
              <input id="newGroupName" placeholder="新用户组名称" />
              <input id="newGroupDesc" placeholder="描述" />
              <button id="createGroupBtn" class="btn btn-primary">新建用户组</button>
            </div>
          </div>
          <div class="list">
            ${groups
              .map(
                (g) => `<div class="list-item">
                  <div class="actions" style="justify-content: space-between;">
                    <div><div class="list-title">${g.name}</div><div class="text-muted">${g.description || "-"}</div></div>
                    <button class="btn btn-danger" data-group-delete="${g.id}">删除</button>
                  </div>
                  <div class="text-muted">成员：${(g.members || []).map((m) => m.username).join(", ") || "无"}</div>
                  <div class="actions" style="margin-top:8px;">
                    <select data-group-user="${g.id}">
                      <option value="">选择用户</option>
                      ${userOptions}
                    </select>
                    <button class="btn btn-secondary" data-group-add="${g.id}">添加成员</button>
                    <select data-group-member="${g.id}">
                      <option value="">移除成员</option>
                      ${(g.members || []).map((m) => `<option value="${m.id}">${m.username}</option>`).join("")}
                    </select>
                    <button class="btn btn-secondary" data-group-remove="${g.id}">移除</button>
                  </div>
                </div>`
              )
              .join("") || '<div class="text-muted">暂无用户组</div>'}
          </div>
        </section>
      `;
    }

    if (state.systemMenu === "storage") {
      const spaces = await api("/api/system/storage/spaces");
      body = `
        <section class="card">
          <div class="actions" style="justify-content: space-between;">
            <h3 style="margin:0;">存储空间管理</h3>
            <div class="actions">
              <input id="newSpaceName" placeholder="存储空间名称" />
              <input id="newSpacePath" placeholder="/srv/storage-space" />
              <select id="newSpaceFsType"><option value="bind">bind</option><option value="btrfs">btrfs</option><option value="ext4">ext4</option></select>
              <button id="createSpaceBtn" class="btn btn-primary">创建存储空间</button>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>名称</th><th>挂载路径</th><th>文件系统</th><th>已用/总量</th><th>缓存加速</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                ${spaces
                  .map(
                    (s) => `<tr>
                      <td>${s.name}</td>
                      <td>${s.mount_path}</td>
                      <td>${s.fs_type}</td>
                      <td>${formatBytes(s.used_bytes)} / ${formatBytes(s.total_bytes)} (${Number(s.use_percent || 0).toFixed(2)}%)</td>
                      <td>
                        <select data-space-cache="${s.id}">
                          <option value="off" ${s.cache_mode === "off" ? "selected" : ""}>关闭</option>
                          <option value="ssd" ${s.cache_mode === "ssd" ? "selected" : ""}>SSD 缓存</option>
                        </select>
                      </td>
                      <td>
                        <select data-space-status="${s.id}">
                          <option value="normal" ${s.status === "normal" ? "selected" : ""}>正常</option>
                          <option value="readonly" ${s.status === "readonly" ? "selected" : ""}>只读</option>
                          <option value="maintenance" ${s.status === "maintenance" ? "selected" : ""}>维护</option>
                        </select>
                      </td>
                      <td>
                        <div class="actions">
                          <button class="btn btn-secondary" data-space-save="${s.id}">保存</button>
                          <button class="btn btn-danger" data-space-delete="${s.id}">删除</button>
                        </div>
                      </td>
                    </tr>`
                  )
                  .join("") || "<tr><td colspan='7'>暂无存储空间</td></tr>"}
              </tbody>
            </table>
          </div>
        </section>
      `;
    }

    if (state.systemMenu === "network") {
      const interfaces = await api("/api/system/network/interfaces");
      body = `
        <section class="card">
          <h3>网卡配置</h3>
          <div class="table-wrap">
            <table>
              <thead><tr><th>接口</th><th>IPv4</th><th>IPv6</th><th>实时速率</th><th>状态</th><th>MTU</th><th>应用结果</th><th>操作</th></tr></thead>
              <tbody>
                ${interfaces
                  .map(
                    (n) => `<tr>
                      <td>${n.iface}</td>
                      <td>${n.ipv4_mode === "manual" ? `${n.ipv4_address} / ${n.ipv4_netmask}` : "DHCP"}</td>
                      <td>${n.ipv6_mode === "manual" ? `${n.ipv6_address}/${n.ipv6_prefix}` : n.ipv6_mode}</td>
                      <td>↓${formatSpeed(n.rx_sec)} ↑${formatSpeed(n.tx_sec)}</td>
                      <td>${n.operstate || "-"}</td>
                      <td>${n.mtu || "-"}</td>
                      <td>${n.apply_last_status || "-"}<div class="text-muted">${n.apply_last_error || "-"}</div></td>
                      <td><button class="btn btn-secondary" data-network-edit="${n.iface}">编辑</button></td>
                    </tr>`
                  )
                  .join("") || "<tr><td colspan='8'>暂无网卡信息</td></tr>"}
              </tbody>
            </table>
          </div>
        </section>
      `;
    }

    if (state.systemMenu === "remote") {
      const [remote, ddns, externalShares] = await Promise.all([
        api("/api/system/remote"),
        api("/api/system/ddns"),
        api("/api/system/external-shares")
      ]);
      body = `
        <section class="card">
          <h3>远程访问配置</h3>
          <div class="grid-2">
            <label>启用远程访问<select id="remoteEnabled"><option value="1" ${remote.enabled ? "selected" : ""}>启用</option><option value="0" ${!remote.enabled ? "selected" : ""}>禁用</option></select></label>
            <label>服务商<input id="remoteProvider" value="${remote.provider || "cloudflare"}" /></label>
            <label>域名<input id="remoteDomain" value="${remote.domain || ""}" /></label>
            <label>Token<input id="remoteToken" placeholder="${remote.tokenMasked || "可留空"}" /></label>
            <label>FN Connect<select id="remoteFnConnect"><option value="1" ${remote.fnConnectEnabled ? "selected" : ""}>启用</option><option value="0" ${!remote.fnConnectEnabled ? "selected" : ""}>禁用</option></select></label>
            <label>外链分享<select id="remoteExternalShare"><option value="1" ${remote.externalSharingEnabled ? "selected" : ""}>启用</option><option value="0" ${!remote.externalSharingEnabled ? "selected" : ""}>禁用</option></select></label>
            <label>外链 Base URL<input id="remoteExternalBaseUrl" value="${remote.externalBaseUrl || ""}" placeholder="https://nas.example.com:24443" /></label>
          </div>
          <div class="actions" style="margin-top:10px;"><button id="saveRemoteBtn" class="btn btn-primary">保存远程配置</button></div>
        </section>
        <section class="card">
          <h3>DDNS 记录</h3>
          <div class="actions">
            <input id="ddnsDomain" placeholder="域名，例如 nas.example.com" />
            <input id="ddnsIP" placeholder="IP，可留空" />
            <button id="addDdnsBtn" class="btn btn-primary">新增记录</button>
          </div>
          <div class="table-wrap" style="margin-top:10px;">
            <table>
              <thead><tr><th>ID</th><th>服务商</th><th>域名</th><th>IP</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead>
              <tbody>
                ${ddns
                  .map(
                    (r) => `<tr><td>${r.id}</td><td>${r.provider}</td><td>${r.domain}</td><td>${r.ip_address || "-"}</td><td>${r.status}</td><td>${formatDate(r.updated_at)}</td><td><button class="btn btn-danger" data-ddns-delete="${r.id}">删除</button></td></tr>`
                  )
                  .join("") || "<tr><td colspan='7'>暂无记录</td></tr>"}
              </tbody>
            </table>
          </div>
        </section>
        <section class="card">
          <h3>外链分享</h3>
          <div class="actions">
            <input id="shareName" placeholder="分享名称" />
            <input id="sharePath" placeholder="/srv/media/movies" />
            <input id="shareExpireAt" placeholder="过期时间(可选)" />
            <button id="addExternalShareBtn" class="btn btn-primary">生成外链</button>
          </div>
          <div class="table-wrap" style="margin-top:10px;">
            <table>
              <thead><tr><th>ID</th><th>名称</th><th>路径</th><th>访问地址</th><th>过期时间</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                ${externalShares
                  .map(
                    (row) => `<tr>
                      <td>${row.id}</td>
                      <td>${row.name}</td>
                      <td>${row.source_path}</td>
                      <td><a href="${row.access_url}" target="_blank">${row.access_url}</a></td>
                      <td>${row.expires_at || "-"}</td>
                      <td>${row.status}</td>
                      <td><button class="btn btn-danger" data-share-delete="${row.id}">删除</button></td>
                    </tr>`
                  )
                  .join("") || "<tr><td colspan='7'>暂无外链记录</td></tr>"}
              </tbody>
            </table>
          </div>
        </section>
      `;
    }

    if (state.systemMenu === "security") {
      const [services, accessPorts] = await Promise.all([api("/api/system/services"), api("/api/system/access-ports")]);
      body = `
        <section class="card">
          <h3>访问端口与登录策略</h3>
          <div class="grid-2">
            <label>HTTP 端口<input id="accessHttpPort" type="number" min="1" max="65535" value="${accessPorts.httpPort || 24443}" /></label>
            <label>HTTPS 端口<input id="accessHttpsPort" type="number" min="1" max="65535" value="${accessPorts.httpsPort || 24443}" /></label>
            <label>强制 HTTPS 登录
              <select id="accessForceHttpsAuth">
                <option value="1" ${accessPorts.forceHttpsAuth ? "selected" : ""}>启用</option>
                <option value="0" ${!accessPorts.forceHttpsAuth ? "selected" : ""}>禁用</option>
              </select>
            </label>
          </div>
          <div class="actions" style="margin-top:10px;"><button id="saveAccessPortsBtn" class="btn btn-primary">保存端口策略</button></div>
        </section>
        <section class="card">
          <h3>系统安全服务</h3>
          <div class="grid-2">
            ${[
              ["sshEnabled", "SSH"],
              ["firewallEnabled", "防火墙"],
              ["notifyEnabled", "通知"],
              ["autoUpdateEnabled", "自动更新"]
            ]
              .map(
                ([key, label]) => `<label>${label}<select data-service-key="${key}"><option value="1" ${services[key] ? "selected" : ""}>启用</option><option value="0" ${!services[key] ? "selected" : ""}>禁用</option></select></label>`
              )
              .join("")}
          </div>
          <div class="actions" style="margin-top:10px;"><button id="saveServiceSwitchBtn" class="btn btn-primary">保存安全服务</button></div>
        </section>
      `;
    }

    if (state.systemMenu === "share") {
      const [services, protocols] = await Promise.all([api("/api/system/services"), api("/api/system/share/protocols")]);
      body = `
        <section class="card">
          <h3>文件共享协议</h3>
          <div class="grid-2">
            ${[
              ["smbEnabled", "SMB"],
              ["webdavEnabled", "WebDAV"],
              ["ftpEnabled", "FTP"],
              ["nfsEnabled", "NFS"],
              ["dlnaEnabled", "DLNA"]
            ]
              .map(
                ([key, label]) => `<label>${label}<select data-share-service-key="${key}"><option value="1" ${services[key] ? "selected" : ""}>启用</option><option value="0" ${!services[key] ? "selected" : ""}>禁用</option></select></label>`
              )
              .join("")}
          </div>
        </section>
        <section class="card">
          <h3>协议端口与连接信息</h3>
          <div class="grid-2">
            <label>共享主机<input id="shareHostInput" value="${protocols.smb.host || location.hostname}" /></label>
            <label>SMB 端口<input id="shareSmbPort" type="number" value="${protocols.smb.port || 445}" /></label>
            <label>WebDAV HTTP<input id="shareWebdavHttpPort" type="number" value="${protocols.webdav.httpPort || 5005}" /></label>
            <label>WebDAV HTTPS<input id="shareWebdavHttpsPort" type="number" value="${protocols.webdav.httpsPort || 5006}" /></label>
            <label>FTP 端口<input id="shareFtpPort" type="number" value="${protocols.ftp.port || 21}" /></label>
            <label>NFS 根路径<input id="shareNfsRoot" value="${protocols.nfs.mountRoot || "/"}" /></label>
            <label>DLNA 媒体目录<input id="shareDlnaPath" value="${protocols.dlna.mediaPath || "/srv/media"}" /></label>
          </div>
          <div class="actions" style="margin-top:10px;"><button id="saveShareSettingsBtn" class="btn btn-primary">保存共享配置</button></div>
        </section>
      `;
    }

    if (state.systemMenu === "integrations") {
      const integrations = await api("/api/settings/integrations");
      body = `
        <section class="card">
          <h3>集成配置</h3>
          <div class="grid-2">
            <label>Jellyfin 地址<input id="s_jellyfinBaseUrl" value="${integrations.jellyfinBaseUrl || "http://arknas-jellyfin:8096"}" /></label>
            <label>Jellyfin API Key<input id="s_jellyfinApiKey" value="${integrations.jellyfinApiKey || ""}" /></label>
            <label>Jellyfin User ID<input id="s_jellyfinUserId" value="${integrations.jellyfinUserId || ""}" /></label>
            <label>qB 地址<input id="s_qbBaseUrl" value="${integrations.qbBaseUrl || "http://arknas-qbittorrent:18080"}" /></label>
            <label>qB 用户名<input id="s_qbUsername" value="${integrations.qbUsername || "admin"}" /></label>
            <label>qB 密码<input id="s_qbPassword" value="${integrations.qbPassword || "adminadmin"}" /></label>
            <label>媒体目录<input id="s_mediaPath" value="${integrations.mediaPath || "/srv/media"}" /></label>
            <label>下载目录<input id="s_downloadsPath" value="${integrations.downloadsPath || "/srv/downloads"}" /></label>
            <label>Docker 数据目录<input id="s_dockerDataPath" value="${integrations.dockerDataPath || "/srv/docker"}" /></label>
            <label>Jellyfin 对外端口<input id="s_jellyfinHostPort" type="number" value="${integrations.jellyfinHostPort || 18096}" /></label>
            <label>qB Web 端口<input id="s_qbWebPort" type="number" value="${integrations.qbWebPort || 18080}" /></label>
            <label>qB Peer 端口<input id="s_qbPeerPort" type="number" value="${integrations.qbPeerPort || 16881}" /></label>
            <label>Portainer 端口<input id="s_portainerHostPort" type="number" value="${integrations.portainerHostPort || 19000}" /></label>
            <label>Watchtower 间隔(秒)<input id="s_watchtowerInterval" type="number" value="${integrations.watchtowerInterval || 86400}" /></label>
          </div>
          <div class="actions" style="margin-top:10px;"><button id="saveSettingsBtn" class="btn btn-primary">保存设置</button></div>
        </section>
      `;
    }

    if (state.systemMenu === "audit") {
      const auditLogs = await api("/api/settings/audit-logs?limit=200");
      body = `
        <section class="card">
          <h3>审计日志</h3>
          <div class="table-wrap">
            <table>
              <thead><tr><th>时间</th><th>操作</th><th>执行人</th><th>目标</th><th>状态</th><th>详情</th></tr></thead>
              <tbody>
                ${auditLogs
                  .map(
                    (l) => `<tr><td>${formatDate(l.created_at)}</td><td>${l.action}</td><td>${l.actor}</td><td>${l.target || "-"}</td><td>${l.status}</td><td>${l.detail || "-"}</td></tr>`
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </section>
      `;
    }

    pageContentEl.innerHTML = `
      <section class="split">
        <aside class="menu-list">
          ${menus
            .map(
              (m) => `<button class="menu-item ${state.systemMenu === m.id ? "active" : ""}" data-system-menu="${m.id}">${m.label}</button>`
            )
            .join("")}
        </aside>
        <div class="list">${body}</div>
      </section>
    `;

    pageContentEl.querySelectorAll("[data-system-menu]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        state.systemMenu = btn.dataset.systemMenu;
        await renderSettings();
      });
    });

    const saveIntegrationBtn = document.getElementById("saveSettingsBtn");
    if (saveIntegrationBtn) {
      saveIntegrationBtn.addEventListener("click", async () => {
        try {
          const payload = {
            jellyfinBaseUrl: document.getElementById("s_jellyfinBaseUrl").value.trim(),
            jellyfinApiKey: document.getElementById("s_jellyfinApiKey").value.trim(),
            jellyfinUserId: document.getElementById("s_jellyfinUserId").value.trim(),
            qbBaseUrl: document.getElementById("s_qbBaseUrl").value.trim(),
            qbUsername: document.getElementById("s_qbUsername").value.trim(),
            qbPassword: document.getElementById("s_qbPassword").value.trim(),
            mediaPath: document.getElementById("s_mediaPath").value.trim(),
            downloadsPath: document.getElementById("s_downloadsPath").value.trim(),
            dockerDataPath: document.getElementById("s_dockerDataPath").value.trim(),
            jellyfinHostPort: Number(document.getElementById("s_jellyfinHostPort").value || 18096),
            qbWebPort: Number(document.getElementById("s_qbWebPort").value || 18080),
            qbPeerPort: Number(document.getElementById("s_qbPeerPort").value || 16881),
            portainerHostPort: Number(document.getElementById("s_portainerHostPort").value || 19000),
            watchtowerInterval: Number(document.getElementById("s_watchtowerInterval").value || 86400)
          };
          await api("/api/settings/integrations", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          showToast("集成配置已保存");
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    const createUserBtn = document.getElementById("createUserBtn");
    if (createUserBtn) {
      createUserBtn.addEventListener("click", async () => {
        try {
          await api("/api/system/users", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username: document.getElementById("newUserName").value.trim(),
              password: document.getElementById("newUserPass").value.trim(),
              role: document.getElementById("newUserRole").value
            })
          });
          showToast("用户已创建");
          await renderSettings();
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    pageContentEl.querySelectorAll("[data-user-role]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/system/users/${btn.dataset.userRole}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ role: btn.dataset.nextRole })
          });
          showToast("角色已更新");
          await renderSettings();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    pageContentEl.querySelectorAll("[data-user-reset]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const password = prompt("请输入新密码（至少8位）", "");
        if (!password) return;
        try {
          await api(`/api/system/users/${btn.dataset.userReset}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password })
          });
          showToast("密码已重置");
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    pageContentEl.querySelectorAll("[data-user-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/system/users/${btn.dataset.userDelete}`, { method: "DELETE" });
          showToast("用户已删除");
          await renderSettings();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    pageContentEl.querySelectorAll("[data-user-quota]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const userId = btn.dataset.userQuota;
        const username = btn.dataset.userName || userId;
        try {
          const quotas = await api(`/api/system/users/${userId}/quotas`);
          openModal(
            `用户配额 - ${username}`,
            `
            <div class="list">
              <div>
                ${(quotas || [])
                  .map(
                    (q) => `<div class="actions" style="margin-bottom:8px;"><input disabled value="${q.mount_path}" /><input disabled value="${q.quota_bytes}" /><button class="btn btn-danger" data-delete-quota="${q.id}">删除</button></div>`
                  )
                  .join("") || '<div class="text-muted">暂无配额</div>'}
              </div>
              <div class="actions">
                <input id="newQuotaPath" placeholder="/srv/media" />
                <input id="newQuotaBytes" type="number" placeholder="字节，例如 107374182400" />
                <button id="addQuotaBtn" class="btn btn-primary">新增/更新配额</button>
              </div>
            </div>
            `
          );

          document.querySelectorAll("[data-delete-quota]").forEach((qBtn) => {
            qBtn.addEventListener("click", async () => {
              try {
                await api(`/api/system/user-quotas/${qBtn.dataset.deleteQuota}`, { method: "DELETE" });
                closeModal();
                showToast("配额已删除");
                await renderSettings();
              } catch (err) {
                showToast(err.message);
              }
            });
          });

          document.getElementById("addQuotaBtn").addEventListener("click", async () => {
            try {
              await api(`/api/system/users/${userId}/quotas`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  mountPath: document.getElementById("newQuotaPath").value.trim(),
                  quotaBytes: Number(document.getElementById("newQuotaBytes").value || 0)
                })
              });
              closeModal();
              showToast("配额已保存");
              await renderSettings();
            } catch (err) {
              showToast(err.message);
            }
          });
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    const createGroupBtn = document.getElementById("createGroupBtn");
    if (createGroupBtn) {
      createGroupBtn.addEventListener("click", async () => {
        try {
          await api("/api/system/groups", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: document.getElementById("newGroupName").value.trim(),
              description: document.getElementById("newGroupDesc").value.trim()
            })
          });
          showToast("用户组已创建");
          await renderSettings();
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    pageContentEl.querySelectorAll("[data-group-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/system/groups/${btn.dataset.groupDelete}`, { method: "DELETE" });
          showToast("用户组已删除");
          await renderSettings();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    pageContentEl.querySelectorAll("[data-group-add]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const groupId = btn.dataset.groupAdd;
          const select = pageContentEl.querySelector(`[data-group-user="${groupId}"]`);
          const userId = select?.value || "";
          if (!userId) {
            showToast("请选择用户");
            return;
          }
          await api(`/api/system/groups/${groupId}/members`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId })
          });
          showToast("成员已添加");
          await renderSettings();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    pageContentEl.querySelectorAll("[data-group-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const groupId = btn.dataset.groupRemove;
          const select = pageContentEl.querySelector(`[data-group-member="${groupId}"]`);
          const userId = select?.value || "";
          if (!userId) {
            showToast("请选择成员");
            return;
          }
          await api(`/api/system/groups/${groupId}/members/${userId}`, { method: "DELETE" });
          showToast("成员已移除");
          await renderSettings();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    const createSpaceBtn = document.getElementById("createSpaceBtn");
    if (createSpaceBtn) {
      createSpaceBtn.addEventListener("click", async () => {
        try {
          await api("/api/system/storage/spaces", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: document.getElementById("newSpaceName").value.trim(),
              mountPath: document.getElementById("newSpacePath").value.trim(),
              fsType: document.getElementById("newSpaceFsType").value
            })
          });
          showToast("存储空间已创建");
          await renderSettings();
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    pageContentEl.querySelectorAll("[data-space-save]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const id = btn.dataset.spaceSave;
          await api(`/api/system/storage/spaces/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              cacheMode: pageContentEl.querySelector(`[data-space-cache="${id}"]`)?.value || "off",
              status: pageContentEl.querySelector(`[data-space-status="${id}"]`)?.value || "normal"
            })
          });
          showToast("存储空间已更新");
          await renderSettings();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    pageContentEl.querySelectorAll("[data-space-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/system/storage/spaces/${btn.dataset.spaceDelete}`, { method: "DELETE" });
          showToast("存储空间已删除");
          await renderSettings();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    pageContentEl.querySelectorAll("[data-network-edit]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const iface = btn.dataset.networkEdit;
          const interfaces = await api("/api/system/network/interfaces");
          const row = interfaces.find((n) => n.iface === iface);
          if (!row) return;

          openModal(
            `网卡设置 - ${iface}`,
            `
              <div class="list">
                <label>IPv4 模式<select id="netIpv4Mode"><option value="dhcp" ${row.ipv4_mode === "dhcp" ? "selected" : ""}>自动(DHCP)</option><option value="manual" ${row.ipv4_mode === "manual" ? "selected" : ""}>手动</option></select></label>
                <div class="grid-2">
                  <label>IPv4 地址<input id="netIpv4Address" value="${row.ipv4_address || ""}" /></label>
                  <label>子网掩码<input id="netIpv4Netmask" value="${row.ipv4_netmask || ""}" /></label>
                  <label>网关<input id="netIpv4Gateway" value="${row.ipv4_gateway || ""}" /></label>
                  <label>DNS<input id="netIpv4Dns" value="${row.ipv4_dns || ""}" /></label>
                </div>
                <label>IPv6 模式<select id="netIpv6Mode"><option value="disabled" ${row.ipv6_mode === "disabled" ? "selected" : ""}>禁用</option><option value="manual" ${row.ipv6_mode === "manual" ? "selected" : ""}>手动</option></select></label>
                <div class="grid-2">
                  <label>IPv6 地址<input id="netIpv6Address" value="${row.ipv6_address || ""}" /></label>
                  <label>IPv6 前缀<input id="netIpv6Prefix" type="number" value="${row.ipv6_prefix || 64}" /></label>
                  <label>IPv6 网关<input id="netIpv6Gateway" value="${row.ipv6_gateway || ""}" /></label>
                  <label>MTU<input id="netMtu" type="number" value="${row.mtu || 1500}" /></label>
                </div>
                <button id="saveNetworkProfileBtn" class="btn btn-primary">保存网络配置</button>
              </div>
            `
          );

          document.getElementById("saveNetworkProfileBtn").addEventListener("click", async () => {
            try {
              await api(`/api/system/network/interfaces/${encodeURIComponent(iface)}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  ipv4Mode: document.getElementById("netIpv4Mode").value,
                  ipv4Address: document.getElementById("netIpv4Address").value.trim(),
                  ipv4Netmask: document.getElementById("netIpv4Netmask").value.trim(),
                  ipv4Gateway: document.getElementById("netIpv4Gateway").value.trim(),
                  ipv4Dns: document.getElementById("netIpv4Dns").value.trim(),
                  ipv6Mode: document.getElementById("netIpv6Mode").value,
                  ipv6Address: document.getElementById("netIpv6Address").value.trim(),
                  ipv6Prefix: Number(document.getElementById("netIpv6Prefix").value || 64),
                  ipv6Gateway: document.getElementById("netIpv6Gateway").value.trim(),
                  mtu: Number(document.getElementById("netMtu").value || 1500)
                })
              });
              closeModal();
              showToast("网卡配置已保存");
              await renderSettings();
            } catch (err) {
              showToast(err.message);
            }
          });
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    const saveRemoteBtn = document.getElementById("saveRemoteBtn");
    if (saveRemoteBtn) {
      saveRemoteBtn.addEventListener("click", async () => {
        try {
          await api("/api/system/remote", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              enabled: document.getElementById("remoteEnabled").value === "1",
              provider: document.getElementById("remoteProvider").value.trim(),
              domain: document.getElementById("remoteDomain").value.trim(),
              token: document.getElementById("remoteToken").value.trim(),
              fnConnectEnabled: document.getElementById("remoteFnConnect").value === "1",
              externalSharingEnabled: document.getElementById("remoteExternalShare").value === "1",
              externalBaseUrl: document.getElementById("remoteExternalBaseUrl").value.trim()
            })
          });
          showToast("远程访问配置已保存");
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    const addDdnsBtn = document.getElementById("addDdnsBtn");
    if (addDdnsBtn) {
      addDdnsBtn.addEventListener("click", async () => {
        try {
          await api("/api/system/ddns", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider: "cloudflare",
              domain: document.getElementById("ddnsDomain").value.trim(),
              ipAddress: document.getElementById("ddnsIP").value.trim(),
              status: "success"
            })
          });
          showToast("DDNS 记录已添加");
          await renderSettings();
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    pageContentEl.querySelectorAll("[data-ddns-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/system/ddns/${btn.dataset.ddnsDelete}`, { method: "DELETE" });
          showToast("DDNS 记录已删除");
          await renderSettings();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    const addExternalShareBtn = document.getElementById("addExternalShareBtn");
    if (addExternalShareBtn) {
      addExternalShareBtn.addEventListener("click", async () => {
        try {
          await api("/api/system/external-shares", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: document.getElementById("shareName").value.trim(),
              sourcePath: document.getElementById("sharePath").value.trim(),
              expiresAt: document.getElementById("shareExpireAt").value.trim()
            })
          });
          showToast("外链已创建");
          await renderSettings();
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    pageContentEl.querySelectorAll("[data-share-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/system/external-shares/${btn.dataset.shareDelete}`, { method: "DELETE" });
          showToast("外链已删除");
          await renderSettings();
        } catch (err) {
          showToast(err.message);
        }
      });
    });

    const saveAccessPortsBtn = document.getElementById("saveAccessPortsBtn");
    if (saveAccessPortsBtn) {
      saveAccessPortsBtn.addEventListener("click", async () => {
        try {
          await api("/api/system/access-ports", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              httpPort: Number(document.getElementById("accessHttpPort").value || 24443),
              httpsPort: Number(document.getElementById("accessHttpsPort").value || 24443),
              forceHttpsAuth: document.getElementById("accessForceHttpsAuth").value === "1"
            })
          });
          showToast("端口策略已保存");
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    const saveServiceSwitchBtn = document.getElementById("saveServiceSwitchBtn");
    if (saveServiceSwitchBtn) {
      saveServiceSwitchBtn.addEventListener("click", async () => {
        try {
          const payload = {};
          pageContentEl.querySelectorAll("[data-service-key]").forEach((el) => {
            payload[el.dataset.serviceKey] = el.value === "1";
          });
          const result = await api("/api/system/services", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          const applyText = (result.apply || []).map((row) => `${row.key}:${row.status}`).join(" ");
          showToast(`服务开关已保存 ${applyText}`.trim());
          await renderSettings();
        } catch (err) {
          showToast(err.message);
        }
      });
    }

    const saveShareSettingsBtn = document.getElementById("saveShareSettingsBtn");
    if (saveShareSettingsBtn) {
      saveShareSettingsBtn.addEventListener("click", async () => {
        try {
          const servicePayload = {};
          pageContentEl.querySelectorAll("[data-share-service-key]").forEach((el) => {
            servicePayload[el.dataset.shareServiceKey] = el.value === "1";
          });
          await api("/api/system/services", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(servicePayload)
          });

          await api("/api/system/share/protocols", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              host: document.getElementById("shareHostInput").value.trim(),
              smbPort: Number(document.getElementById("shareSmbPort").value || 445),
              webdavHttpPort: Number(document.getElementById("shareWebdavHttpPort").value || 5005),
              webdavHttpsPort: Number(document.getElementById("shareWebdavHttpsPort").value || 5006),
              ftpPort: Number(document.getElementById("shareFtpPort").value || 21),
              nfsRoot: document.getElementById("shareNfsRoot").value.trim(),
              dlnaMediaPath: document.getElementById("shareDlnaPath").value.trim()
            })
          });

          showToast("共享配置已保存");
        } catch (err) {
          showToast(err.message);
        }
      });
    }
  } catch (err) {
    pageContentEl.innerHTML = `<div class="card">加载失败：${err.message}</div>`;
  }
}
document.getElementById("navMenu").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-page]");
  if (!btn) return;
  await navigate(btn.dataset.page);
});

document.getElementById("refreshBtn").addEventListener("click", async () => {
  await navigate(state.page);
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // noop
  }
  forceLogout();
});

document.getElementById("logoutBtnSide").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // noop
  }
  forceLogout();
});

document.getElementById("globalSearch").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  const keyword = String(e.target.value || "").toLowerCase().trim();
  if (!keyword) return;
  const map = {
    dashboard: ["总览", "dashboard", "仪表盘"],
    containers: ["docker", "容器", "compose", "镜像", "网络"],
    downloads: ["下载", "qb", "torrent"],
    media: ["影视", "jellyfin", "媒体"],
    apps: ["应用", "app"],
    ssl: ["ssl", "证书", "https"],
    settings: ["设置", "系统", "用户", "存储", "网络", "安全"]
  };
  const found = Object.entries(map).find(([, arr]) => arr.some((k) => keyword.includes(k.toLowerCase())));
  if (found) {
    await navigate(found[0]);
  } else {
    showToast("未匹配到模块");
  }
});

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const username = String(form.get("username") || "").trim();
  const password = String(form.get("password") || "").trim();
  const remember = Boolean(form.get("remember"));

  try {
    const encryptedPayload = await encryptLoginPassword(password);
    const data = await api("/api/auth/login", {
      skipAuthHandling: true,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, ...encryptedPayload })
    });

    state.token = data.token;
    state.user = data.user;
    localStorage.setItem("arknas_last_user", username);
    localStorage.setItem("arknas_remember", remember ? "1" : "0");
    if (remember) {
      localStorage.setItem("arknas_token", state.token);
      sessionStorage.removeItem("arknas_token");
    } else {
      sessionStorage.setItem("arknas_token", state.token);
      localStorage.removeItem("arknas_token");
    }
    setAuthedUI(true);
    showToast(`欢迎，${state.user.username}`);
    await navigate("dashboard");
  } catch (err) {
    if (String(err.message || "").includes("密钥已失效")) {
      loginPublicKeyCache = null;
    }
    showToast(err.message);
  }
});

document.getElementById("togglePasswordBtn").addEventListener("click", () => {
  const input = document.getElementById("loginPassword");
  if (!input) return;
  const toText = input.type === "password";
  input.type = toText ? "text" : "password";
  document.getElementById("togglePasswordBtn").textContent = toText ? "隐藏" : "显示";
});

document.getElementById("forgotPasswordBtn").addEventListener("click", () => {
  openModal(
    "重置管理员密码",
    `<div class="list">
      <div class="list-item">
        <div class="list-title">服务器执行以下命令：</div>
        <textarea readonly>cd ~/arknas-hub
./scripts/manage.sh reset-admin-password 'NewStrongPassword123' admin
./scripts/manage.sh restart</textarea>
      </div>
      <div class="text-muted">密码至少 8 位。该操作会更新数据库中的管理员密码。</div>
    </div>`
  );
});

initLoginFormState();
bootstrapAuth();
