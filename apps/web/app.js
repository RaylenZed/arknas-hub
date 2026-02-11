const state = {
  token: localStorage.getItem("arknas_token") || "",
  user: null,
  page: "dashboard",
  refreshTimer: null
};

const PAGE_TITLES = {
  dashboard: "总览",
  containers: "容器管理",
  media: "影视管理",
  downloads: "下载管理",
  ssl: "SSL 管理",
  settings: "设置"
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

function openModal(title, html) {
  modalTitleEl.textContent = title;
  modalBodyEl.innerHTML = html;
  modalEl.classList.remove("hidden");
}

function closeModal() {
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

function statusClass(stateValue) {
  if (stateValue === "running") return "status-running";
  if (stateValue === "stopped") return "status-stopped";
  if (stateValue === "error") return "status-error";
  return "status-other";
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const res = await fetch(path, {
    ...options,
    headers
  });

  if (res.status === 401) {
    forceLogout();
    throw new Error("登录已过期，请重新登录");
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(data.error || `HTTP ${res.status}`);
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
  clearRefreshTimer();
  setAuthedUI(false);
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

    pageContentEl.innerHTML = `
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
    const data = await api("/api/containers/summary");
    const list = data.containers || [];

    pageContentEl.innerHTML = `
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

    document.getElementById("reloadContainers").addEventListener("click", renderContainers);

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
  } catch (err) {
    pageContentEl.innerHTML = `<div class="card">加载失败：${err.message}</div>`;
  }
}

async function renderMedia() {
  try {
    const data = await api("/api/media/summary");
    const cw = data.continueWatching || [];
    const latest = data.latest || [];
    const sessions = data.sessions || [];

    pageContentEl.innerHTML = `
      <section class="card">
        <div class="actions" style="justify-content: space-between;">
          <div class="text-muted">活跃会话 ${data.summary.activeSessions}</div>
          <div class="actions">
            <button id="mediaRefreshBtn" class="btn btn-secondary">刷新页面</button>
            <button id="libraryRefreshBtn" class="btn btn-primary">刷新媒体库</button>
          </div>
        </div>
      </section>

      <section class="grid-3">
        <div class="card">
          <h3>继续观看</h3>
          <div class="list">
            ${cw
              .map(
                (item) => `<div class="list-item"><div class="list-title">${item.Name || "未命名"}</div><div class="text-muted">进度 ${(item.UserData?.PlayedPercentage || 0).toFixed(1)}%</div></div>`
              )
              .join("") || '<div class="text-muted">暂无数据</div>'}
          </div>
        </div>
        <div class="card">
          <h3>最近添加</h3>
          <div class="list">
            ${latest
              .map(
                (item) => `<div class="list-item"><div class="list-title">${item.Name || "未命名"}</div><div class="text-muted">${item.Type || "-"} · ${formatDate(item.DateCreated)}</div></div>`
              )
              .join("") || '<div class="text-muted">暂无数据</div>'}
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
  } catch (err) {
    pageContentEl.innerHTML = `<div class="card">加载失败：${err.message}</div>`;
  }
}

async function renderDownloads() {
  try {
    const [summaryData, tasks] = await Promise.all([
      api("/api/downloads/summary"),
      api("/api/downloads/tasks?filter=all")
    ]);

    pageContentEl.innerHTML = `
      <section class="card">
        <div class="actions" style="justify-content: space-between; align-items: center;">
          <div class="text-muted">下载中 ${summaryData.summary.downloading} · 做种 ${summaryData.summary.seeding} · 完成 ${summaryData.summary.completed} · ↓${formatSpeed(summaryData.summary.dlSpeed)} ↑${formatSpeed(summaryData.summary.upSpeed)}</div>
          <div class="actions">
            <button id="downloadRefreshBtn" class="btn btn-secondary">刷新</button>
            <button id="addMagnetBtn" class="btn btn-primary">添加磁力</button>
            <button id="addTorrentBtn" class="btn btn-secondary">上传种子</button>
          </div>
        </div>
      </section>

      <section class="card table-wrap">
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
                <tr>
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
              .join("")}
          </tbody>
        </table>
      </section>
    `;

    document.getElementById("downloadRefreshBtn").addEventListener("click", renderDownloads);

    document.getElementById("addMagnetBtn").addEventListener("click", () => {
      openModal(
        "添加磁力任务",
        `
        <div class="list">
          <label>磁力/链接（可多行）<textarea id="magnetUrls" placeholder="magnet:?xt=..."></textarea></label>
          <label>保存路径（可选）<input id="magnetSavePath" placeholder="/srv/downloads" /></label>
          <button id="submitMagnet" class="btn btn-primary">提交</button>
        </div>
      `
      );

      document.getElementById("submitMagnet").addEventListener("click", async () => {
        try {
          const urls = document.getElementById("magnetUrls").value.trim();
          const savepath = document.getElementById("magnetSavePath").value.trim();
          await api("/api/downloads/add-magnet", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ urls, savepath })
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
    const [integrations, auditLogs] = await Promise.all([
      api("/api/settings/integrations"),
      api("/api/settings/audit-logs?limit=100")
    ]);

    pageContentEl.innerHTML = `
      <section class="card">
        <h3>集成配置</h3>
        <div class="grid-2">
          <label>Jellyfin 地址<input id="s_jellyfinBaseUrl" value="${integrations.jellyfinBaseUrl || ""}" placeholder="http://jellyfin:8096" /></label>
          <label>Jellyfin API Key<input id="s_jellyfinApiKey" value="${integrations.jellyfinApiKey || ""}" /></label>
          <label>Jellyfin User ID<input id="s_jellyfinUserId" value="${integrations.jellyfinUserId || ""}" /></label>
          <label>qB 地址<input id="s_qbBaseUrl" value="${integrations.qbBaseUrl || ""}" placeholder="http://qbittorrent:8080" /></label>
          <label>qB 用户名<input id="s_qbUsername" value="${integrations.qbUsername || ""}" /></label>
          <label>qB 密码<input id="s_qbPassword" value="${integrations.qbPassword || ""}" /></label>
        </div>
        <div class="actions" style="margin-top: 10px;">
          <button id="saveSettingsBtn" class="btn btn-primary">保存设置</button>
        </div>
      </section>

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

    document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
      try {
        const payload = {
          jellyfinBaseUrl: document.getElementById("s_jellyfinBaseUrl").value.trim(),
          jellyfinApiKey: document.getElementById("s_jellyfinApiKey").value.trim(),
          jellyfinUserId: document.getElementById("s_jellyfinUserId").value.trim(),
          qbBaseUrl: document.getElementById("s_qbBaseUrl").value.trim(),
          qbUsername: document.getElementById("s_qbUsername").value.trim(),
          qbPassword: document.getElementById("s_qbPassword").value.trim()
        };

        await api("/api/settings/integrations", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        showToast("设置已保存");
      } catch (err) {
        showToast(err.message);
      }
    });
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

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const username = String(form.get("username") || "").trim();
  const password = String(form.get("password") || "").trim();

  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });

    state.token = data.token;
    state.user = data.user;
    localStorage.setItem("arknas_token", state.token);
    setAuthedUI(true);
    showToast(`欢迎，${state.user.username}`);
    await navigate("dashboard");
  } catch (err) {
    showToast(err.message);
  }
});

bootstrapAuth();
