import si from "systeminformation";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db.js";
import { HttpError } from "../lib/httpError.js";
import { config } from "../config.js";
import { getHostExecStatus, hostCommandExists, runHostCommand } from "./hostService.js";

const SERVICE_KEYS = [
  "sshEnabled",
  "smbEnabled",
  "webdavEnabled",
  "ftpEnabled",
  "nfsEnabled",
  "dlnaEnabled",
  "firewallEnabled",
  "notifyEnabled",
  "autoUpdateEnabled"
];

const SERVICE_UNIT_MAP = {
  sshEnabled: ["ssh", "sshd"],
  smbEnabled: ["smbd", "samba"],
  webdavEnabled: ["apache2", "nginx"],
  ftpEnabled: ["vsftpd", "proftpd"],
  nfsEnabled: ["nfs-server", "nfs-kernel-server"],
  dlnaEnabled: ["minidlna", "readymedia"],
  firewallEnabled: ["ufw", "firewalld"],
  notifyEnabled: ["cron"],
  autoUpdateEnabled: ["unattended-upgrades", "cron"]
};

function getSetting(key, fallback = "") {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, String(value ?? ""), now);
}

function parseBool(value, fallback = false) {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return fallback;
}

function parseIntSafe(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function netmaskToPrefix(netmask) {
  if (!netmask) return 24;
  const parts = String(netmask).split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 24;
  let bits = 0;
  for (const p of parts) {
    bits += p.toString(2).split("1").length - 1;
  }
  return bits;
}

function ensureAbsoluteDir(inputPath) {
  const normalized = path.resolve(String(inputPath || "").trim());
  if (!normalized.startsWith("/")) {
    throw new HttpError(400, "路径必须为绝对路径");
  }
  fs.mkdirSync(normalized, { recursive: true });
  return normalized;
}

function applyServiceState(key, enabled) {
  if (!config.allowHostServiceControl) {
    return {
      key,
      applied: false,
      status: "skipped",
      message: "未启用宿主服务控制（ARKNAS_ALLOW_HOST_SERVICE_CONTROL=1）"
    };
  }

  const units = SERVICE_UNIT_MAP[key] || [];
  if (units.length === 0) {
    return {
      key,
      applied: false,
      status: "skipped",
      message: "无系统服务映射"
    };
  }

  if (hostCommandExists("systemctl")) {
    for (const unit of units) {
      const args = enabled ? ["enable", "--now", unit] : ["disable", "--now", unit];
      const result = runHostCommand("systemctl", args);
      if (result.ok) {
        return {
          key,
          unit,
          applied: true,
          status: "ok",
          message: `${enabled ? "启用" : "禁用"} ${unit} 成功`
        };
      }
    }

    return {
      key,
      applied: false,
      status: "failed",
      message: `systemctl ${enabled ? "enable" : "disable"} 失败`
    };
  }

  if (hostCommandExists("service")) {
    for (const unit of units) {
      const args = [unit, enabled ? "start" : "stop"];
      const result = runHostCommand("service", args);
      if (result.ok) {
        return {
          key,
          unit,
          applied: true,
          status: "ok",
          message: `${enabled ? "启动" : "停止"} ${unit} 成功`
        };
      }
    }

    return {
      key,
      applied: false,
      status: "failed",
      message: "service 命令执行失败"
    };
  }

  return {
    key,
    applied: false,
    status: "skipped",
    message: "系统不支持 systemctl/service"
  };
}

function buildExternalAccessUrl(token) {
  const baseUrl =
    getSetting("remote.externalBaseUrl", "") ||
    getSetting("remote.domain", "") ||
    "";

  if (!baseUrl) return `/api/system/external-shares/${token}`;
  const normalized = String(baseUrl).replace(/\/$/, "");
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return `${normalized}/share/${token}`;
  }
  return `https://${normalized}/share/${token}`;
}

function getProfileByIface(iface) {
  const row = db.prepare("SELECT * FROM network_profiles WHERE iface = ?").get(iface);
  return row || null;
}

function tryApplyNetworkProfile(profile) {
  if (!config.allowHostNetworkApply) {
    return {
      applied: false,
      status: "skipped",
      message: "未启用宿主网卡写入（ARKNAS_ALLOW_HOST_NETWORK_APPLY=1）"
    };
  }

  if (!hostCommandExists("ip")) {
    return {
      applied: false,
      status: "failed",
      message: "宿主缺少 ip 命令"
    };
  }

  const iface = profile.iface;
  const mtu = parseIntSafe(profile.mtu, 1500);

  const mtuResult = runHostCommand("ip", ["link", "set", "dev", iface, "mtu", String(mtu)]);
  if (!mtuResult.ok) {
    return {
      applied: false,
      status: "failed",
      message: mtuResult.stderr || mtuResult.error || "设置 MTU 失败"
    };
  }

  if (profile.ipv4_mode === "manual") {
    const prefix = netmaskToPrefix(profile.ipv4_netmask);
    runHostCommand("ip", ["addr", "flush", "dev", iface]);

    const addrResult = runHostCommand("ip", ["addr", "add", `${profile.ipv4_address}/${prefix}`, "dev", iface]);
    if (!addrResult.ok) {
      return {
        applied: false,
        status: "failed",
        message: addrResult.stderr || addrResult.error || "设置 IPv4 失败"
      };
    }

    if (profile.ipv4_gateway) {
      const gwResult = runHostCommand("ip", ["route", "replace", "default", "via", profile.ipv4_gateway, "dev", iface]);
      if (!gwResult.ok) {
        return {
          applied: false,
          status: "failed",
          message: gwResult.stderr || gwResult.error || "设置默认网关失败"
        };
      }
    }
  }

  return {
    applied: true,
    status: "ok",
    message: "网络配置已尝试写入"
  };
}

export async function getSystemStatus() {
  const [load, mem, fsSizes, networkStats] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.networkStats()
  ]);

  const disks = (fsSizes || []).map((d) => ({
    fs: d.fs,
    mount: d.mount,
    size: d.size,
    used: d.used,
    available: Math.max(0, d.size - d.used),
    usePercent: d.use
  }));

  const net = (networkStats || []).map((n) => ({
    iface: n.iface,
    rxBytes: n.rx_bytes,
    txBytes: n.tx_bytes,
    rxSec: n.rx_sec,
    txSec: n.tx_sec
  }));

  return {
    cpu: {
      usagePercent: Number(load.currentLoad.toFixed(2)),
      cores: load.cpus?.length || 0
    },
    memory: {
      total: mem.total,
      used: mem.used,
      free: mem.free,
      usagePercent: Number(((mem.used / mem.total) * 100).toFixed(2))
    },
    disks,
    network: net,
    updatedAt: new Date().toISOString()
  };
}

export async function getDeviceOverview() {
  const [osInfo, cpu, mem, time, fsSizes, netIfs, netStats] = await Promise.all([
    si.osInfo(),
    si.cpu(),
    si.mem(),
    si.time(),
    si.fsSize(),
    si.networkInterfaces(),
    si.networkStats()
  ]);

  const spaces = await listStorageSpaces();

  return {
    device: {
      hostname: osInfo.hostname || "",
      distro: osInfo.distro || "",
      release: osInfo.release || "",
      kernel: osInfo.kernel || "",
      arch: osInfo.arch || "",
      uptime: time.uptime || 0
    },
    hardware: {
      cpuBrand: cpu.brand || "",
      physicalCores: cpu.physicalCores || 0,
      cores: cpu.cores || 0,
      speed: cpu.speed || "",
      memoryTotal: mem.total || 0,
      memoryFree: mem.free || 0
    },
    storage: (fsSizes || []).map((d) => ({
      fs: d.fs,
      mount: d.mount,
      type: d.type,
      size: d.size,
      used: d.used,
      available: Math.max(0, d.size - d.used),
      usePercent: d.use
    })),
    storageSpaces: spaces,
    network: {
      interfaces: (netIfs || []).map((n) => ({
        iface: n.iface,
        ip4: n.ip4 || "",
        ip4subnet: n.ip4subnet || "",
        ip6: n.ip6 || "",
        mac: n.mac || "",
        operstate: n.operstate || "",
        speed: n.speed || 0,
        mtu: n.mtu || 0
      })),
      realtime: (netStats || []).map((n) => ({
        iface: n.iface,
        rxSec: n.rx_sec || 0,
        txSec: n.tx_sec || 0
      }))
    }
  };
}

export function listUsers() {
  const users = db
    .prepare("SELECT id, username, role, created_at, updated_at FROM users ORDER BY id ASC")
    .all();

  const groupRows = db
    .prepare(
      `SELECT ugm.user_id, ug.name
       FROM user_group_members ugm
       JOIN user_groups ug ON ug.id = ugm.group_id`
    )
    .all();

  const quotaRows = db
    .prepare(
      `SELECT user_id, mount_path, quota_bytes
       FROM user_quotas`
    )
    .all();

  const groupsByUser = new Map();
  for (const row of groupRows) {
    if (!groupsByUser.has(row.user_id)) groupsByUser.set(row.user_id, []);
    groupsByUser.get(row.user_id).push(row.name);
  }

  const quotasByUser = new Map();
  for (const row of quotaRows) {
    if (!quotasByUser.has(row.user_id)) quotasByUser.set(row.user_id, []);
    quotasByUser.get(row.user_id).push({
      mountPath: row.mount_path,
      quotaBytes: Number(row.quota_bytes || 0)
    });
  }

  return users.map((u) => ({
    ...u,
    groups: groupsByUser.get(u.id) || [],
    quotas: quotasByUser.get(u.id) || []
  }));
}

export function createUser({ username, password, role = "user" }) {
  const name = String(username || "").trim();
  const pwd = String(password || "");
  if (!name) throw new HttpError(400, "用户名不能为空");
  if (pwd.length < 8) throw new HttpError(400, "密码至少 8 位");
  if (!["admin", "user"].includes(role)) throw new HttpError(400, "角色不合法");

  const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(name);
  if (exists) throw new HttpError(409, "用户名已存在");

  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(pwd, 10);
  const info = db
    .prepare("INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(name, hash, role, now, now);

  return db
    .prepare("SELECT id, username, role, created_at, updated_at FROM users WHERE id = ?")
    .get(info.lastInsertRowid);
}

export function updateUser(userId, { role, password }) {
  const id = Number(userId);
  const current = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!current) throw new HttpError(404, "用户不存在");

  const nextRole = typeof role === "string" ? role : null;
  if (nextRole && !["admin", "user"].includes(nextRole)) {
    throw new HttpError(400, "角色不合法");
  }
  const nextPwd = typeof password === "string" ? password : "";
  if (nextPwd && nextPwd.length < 8) {
    throw new HttpError(400, "密码至少 8 位");
  }

  const now = new Date().toISOString();
  if (nextRole) {
    db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").run(nextRole, now, id);
  }
  if (nextPwd) {
    const hash = bcrypt.hashSync(nextPwd, 10);
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(hash, now, id);
  }

  return db
    .prepare("SELECT id, username, role, created_at, updated_at FROM users WHERE id = ?")
    .get(id);
}

export function deleteUser(userId) {
  const id = Number(userId);
  const current = db.prepare("SELECT id, username FROM users WHERE id = ?").get(id);
  if (!current) throw new HttpError(404, "用户不存在");
  db.prepare("DELETE FROM user_group_members WHERE user_id = ?").run(id);
  db.prepare("DELETE FROM user_quotas WHERE user_id = ?").run(id);
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  return { ok: true, id, username: current.username };
}

export function listUserQuotas(userId) {
  if (userId) {
    return db
      .prepare("SELECT id, user_id, mount_path, quota_bytes, created_at, updated_at FROM user_quotas WHERE user_id = ? ORDER BY id DESC")
      .all(Number(userId));
  }

  return db
    .prepare("SELECT id, user_id, mount_path, quota_bytes, created_at, updated_at FROM user_quotas ORDER BY id DESC")
    .all();
}

export function upsertUserQuota(userId, { mountPath, quotaBytes }) {
  const uid = Number(userId);
  if (!uid) throw new HttpError(400, "用户 ID 非法");
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(uid);
  if (!user) throw new HttpError(404, "用户不存在");

  const mp = ensureAbsoluteDir(mountPath);
  const quota = Math.max(0, Number(quotaBytes || 0));
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO user_quotas (user_id, mount_path, quota_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, mount_path) DO UPDATE SET quota_bytes = excluded.quota_bytes, updated_at = excluded.updated_at`
  ).run(uid, mp, quota, now, now);

  return db
    .prepare("SELECT id, user_id, mount_path, quota_bytes, created_at, updated_at FROM user_quotas WHERE user_id = ? AND mount_path = ?")
    .get(uid, mp);
}

export function deleteUserQuota(quotaId) {
  const id = Number(quotaId);
  const row = db.prepare("SELECT id FROM user_quotas WHERE id = ?").get(id);
  if (!row) throw new HttpError(404, "配额记录不存在");
  db.prepare("DELETE FROM user_quotas WHERE id = ?").run(id);
  return { ok: true, id };
}

export async function listStorageSpaces() {
  const rows = db
    .prepare(
      `SELECT id, name, mount_path, fs_type, total_bytes, used_bytes, cache_mode, status, created_at, updated_at
       FROM storage_spaces
       ORDER BY id ASC`
    )
    .all();

  const fsSizes = await si.fsSize();
  return rows.map((row) => {
    const fsRow = fsSizes.find((item) => item.mount === row.mount_path || item.fs === row.mount_path);
    const total = fsRow ? Number(fsRow.size || 0) : Number(row.total_bytes || 0);
    const used = fsRow ? Number(fsRow.used || 0) : Number(row.used_bytes || 0);

    return {
      ...row,
      total_bytes: total,
      used_bytes: used,
      available_bytes: Math.max(0, total - used),
      use_percent: total > 0 ? Number(((used / total) * 100).toFixed(2)) : 0,
      source: fsRow ? "system" : "custom"
    };
  });
}

export function createStorageSpace({ name, mountPath, fsType = "bind", cacheMode = "off", status = "normal" }) {
  const spaceName = String(name || "").trim();
  if (!spaceName) throw new HttpError(400, "存储空间名称不能为空");
  const mp = ensureAbsoluteDir(mountPath);
  const now = new Date().toISOString();

  const info = db
    .prepare(
      `INSERT INTO storage_spaces (name, mount_path, fs_type, total_bytes, used_bytes, cache_mode, status, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?)`
    )
    .run(spaceName, mp, String(fsType || "bind"), String(cacheMode || "off"), String(status || "normal"), now, now);

  return db
    .prepare(
      `SELECT id, name, mount_path, fs_type, total_bytes, used_bytes, cache_mode, status, created_at, updated_at
       FROM storage_spaces WHERE id = ?`
    )
    .get(info.lastInsertRowid);
}

export function updateStorageSpace(spaceId, input = {}) {
  const id = Number(spaceId);
  const current = db.prepare("SELECT * FROM storage_spaces WHERE id = ?").get(id);
  if (!current) throw new HttpError(404, "存储空间不存在");

  const nextName = typeof input.name === "string" && input.name.trim() ? input.name.trim() : current.name;
  const nextMount =
    typeof input.mountPath === "string" && input.mountPath.trim()
      ? ensureAbsoluteDir(input.mountPath)
      : current.mount_path;
  const nextType = typeof input.fsType === "string" && input.fsType.trim() ? input.fsType.trim() : current.fs_type;
  const nextCache = typeof input.cacheMode === "string" && input.cacheMode.trim() ? input.cacheMode.trim() : current.cache_mode;
  const nextStatus = typeof input.status === "string" && input.status.trim() ? input.status.trim() : current.status;
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE storage_spaces
     SET name = ?, mount_path = ?, fs_type = ?, cache_mode = ?, status = ?, updated_at = ?
     WHERE id = ?`
  ).run(nextName, nextMount, nextType, nextCache, nextStatus, now, id);

  return db.prepare("SELECT * FROM storage_spaces WHERE id = ?").get(id);
}

export function deleteStorageSpace(spaceId) {
  const id = Number(spaceId);
  const row = db.prepare("SELECT id, name FROM storage_spaces WHERE id = ?").get(id);
  if (!row) throw new HttpError(404, "存储空间不存在");
  db.prepare("DELETE FROM storage_spaces WHERE id = ?").run(id);
  return { ok: true, id, name: row.name };
}

export async function listNetworkProfiles() {
  const [ifs, stats, profiles] = await Promise.all([
    si.networkInterfaces(),
    si.networkStats(),
    Promise.resolve(db.prepare("SELECT * FROM network_profiles ORDER BY iface ASC").all())
  ]);

  const profileMap = new Map();
  for (const p of profiles) profileMap.set(p.iface, p);

  return (ifs || []).map((iface) => {
    const p = profileMap.get(iface.iface);
    const realtime = (stats || []).find((n) => n.iface === iface.iface);

    return {
      iface: iface.iface,
      ipv4_mode: p?.ipv4_mode || "dhcp",
      ipv4_address: p?.ipv4_address || iface.ip4 || "",
      ipv4_netmask: p?.ipv4_netmask || iface.ip4subnet || "",
      ipv4_gateway: p?.ipv4_gateway || "",
      ipv4_dns: p?.ipv4_dns || "",
      ipv6_mode: p?.ipv6_mode || "disabled",
      ipv6_address: p?.ipv6_address || iface.ip6 || "",
      ipv6_prefix: parseIntSafe(p?.ipv6_prefix, 64),
      ipv6_gateway: p?.ipv6_gateway || "",
      mtu: parseIntSafe(p?.mtu, iface.mtu || 1500),
      apply_last_status: p?.apply_last_status || "unknown",
      apply_last_error: p?.apply_last_error || "",
      operstate: iface.operstate || "",
      speed: iface.speed || 0,
      mac: iface.mac || "",
      rx_sec: realtime?.rx_sec || 0,
      tx_sec: realtime?.tx_sec || 0
    };
  });
}

export function upsertNetworkProfile(iface, input = {}) {
  const ifName = String(iface || "").trim();
  if (!ifName) throw new HttpError(400, "网卡名称不能为空");

  const current = getProfileByIface(ifName) || {
    iface: ifName,
    ipv4_mode: "dhcp",
    ipv4_address: "",
    ipv4_netmask: "",
    ipv4_gateway: "",
    ipv4_dns: "",
    ipv6_mode: "disabled",
    ipv6_address: "",
    ipv6_prefix: 64,
    ipv6_gateway: "",
    mtu: 1500
  };

  const next = {
    iface: ifName,
    ipv4_mode: String(input.ipv4Mode || current.ipv4_mode || "dhcp"),
    ipv4_address: String(input.ipv4Address || current.ipv4_address || ""),
    ipv4_netmask: String(input.ipv4Netmask || current.ipv4_netmask || ""),
    ipv4_gateway: String(input.ipv4Gateway || current.ipv4_gateway || ""),
    ipv4_dns: String(input.ipv4Dns || current.ipv4_dns || ""),
    ipv6_mode: String(input.ipv6Mode || current.ipv6_mode || "disabled"),
    ipv6_address: String(input.ipv6Address || current.ipv6_address || ""),
    ipv6_prefix: parseIntSafe(input.ipv6Prefix ?? current.ipv6_prefix, 64),
    ipv6_gateway: String(input.ipv6Gateway || current.ipv6_gateway || ""),
    mtu: parseIntSafe(input.mtu ?? current.mtu, 1500)
  };

  if (next.ipv4_mode === "manual" && (!next.ipv4_address || !next.ipv4_netmask)) {
    throw new HttpError(400, "IPv4 手动模式需填写地址与掩码");
  }

  const applied = tryApplyNetworkProfile(next);
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO network_profiles (
      iface, ipv4_mode, ipv4_address, ipv4_netmask, ipv4_gateway, ipv4_dns,
      ipv6_mode, ipv6_address, ipv6_prefix, ipv6_gateway, mtu,
      apply_last_status, apply_last_error, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(iface) DO UPDATE SET
      ipv4_mode = excluded.ipv4_mode,
      ipv4_address = excluded.ipv4_address,
      ipv4_netmask = excluded.ipv4_netmask,
      ipv4_gateway = excluded.ipv4_gateway,
      ipv4_dns = excluded.ipv4_dns,
      ipv6_mode = excluded.ipv6_mode,
      ipv6_address = excluded.ipv6_address,
      ipv6_prefix = excluded.ipv6_prefix,
      ipv6_gateway = excluded.ipv6_gateway,
      mtu = excluded.mtu,
      apply_last_status = excluded.apply_last_status,
      apply_last_error = excluded.apply_last_error,
      updated_at = excluded.updated_at`
  ).run(
    ifName,
    next.ipv4_mode,
    next.ipv4_address,
    next.ipv4_netmask,
    next.ipv4_gateway,
    next.ipv4_dns,
    next.ipv6_mode,
    next.ipv6_address,
    next.ipv6_prefix,
    next.ipv6_gateway,
    next.mtu,
    applied.status,
    applied.message || "",
    now
  );

  return {
    iface: ifName,
    profile: next,
    apply: applied
  };
}

export function listGroups() {
  const groups = db
    .prepare("SELECT id, name, description, created_at, updated_at FROM user_groups ORDER BY id ASC")
    .all();

  const members = db
    .prepare(
      `SELECT ugm.group_id, u.id as user_id, u.username
       FROM user_group_members ugm
       JOIN users u ON u.id = ugm.user_id
       ORDER BY u.username`
    )
    .all();

  const map = new Map();
  for (const row of members) {
    if (!map.has(row.group_id)) map.set(row.group_id, []);
    map.get(row.group_id).push({
      id: row.user_id,
      username: row.username
    });
  }

  return groups.map((g) => ({
    ...g,
    members: map.get(g.id) || []
  }));
}

export function createGroup({ name, description = "" }) {
  const groupName = String(name || "").trim();
  if (!groupName) throw new HttpError(400, "用户组名称不能为空");
  const exists = db.prepare("SELECT id FROM user_groups WHERE name = ?").get(groupName);
  if (exists) throw new HttpError(409, "用户组已存在");

  const now = new Date().toISOString();
  const info = db
    .prepare("INSERT INTO user_groups (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(groupName, String(description || ""), now, now);

  return db.prepare("SELECT * FROM user_groups WHERE id = ?").get(info.lastInsertRowid);
}

export function updateGroup(groupId, { name, description }) {
  const id = Number(groupId);
  const current = db.prepare("SELECT id FROM user_groups WHERE id = ?").get(id);
  if (!current) throw new HttpError(404, "用户组不存在");
  const now = new Date().toISOString();

  if (typeof name === "string" && name.trim()) {
    db.prepare("UPDATE user_groups SET name = ?, updated_at = ? WHERE id = ?").run(name.trim(), now, id);
  }
  if (typeof description === "string") {
    db.prepare("UPDATE user_groups SET description = ?, updated_at = ? WHERE id = ?").run(description, now, id);
  }

  return db.prepare("SELECT * FROM user_groups WHERE id = ?").get(id);
}

export function deleteGroup(groupId) {
  const id = Number(groupId);
  const current = db.prepare("SELECT id, name FROM user_groups WHERE id = ?").get(id);
  if (!current) throw new HttpError(404, "用户组不存在");
  db.prepare("DELETE FROM user_group_members WHERE group_id = ?").run(id);
  db.prepare("DELETE FROM user_groups WHERE id = ?").run(id);
  return { ok: true, id, name: current.name };
}

export function addGroupMember(groupId, userId) {
  const gid = Number(groupId);
  const uid = Number(userId);
  const group = db.prepare("SELECT id FROM user_groups WHERE id = ?").get(gid);
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(uid);
  if (!group || !user) throw new HttpError(404, "用户或用户组不存在");
  db.prepare("INSERT OR IGNORE INTO user_group_members (user_id, group_id, created_at) VALUES (?, ?, ?)")
    .run(uid, gid, new Date().toISOString());
  return { ok: true, groupId: gid, userId: uid };
}

export function removeGroupMember(groupId, userId) {
  const gid = Number(groupId);
  const uid = Number(userId);
  db.prepare("DELETE FROM user_group_members WHERE group_id = ? AND user_id = ?").run(gid, uid);
  return { ok: true, groupId: gid, userId: uid };
}

export function getServiceSwitches() {
  const result = {};
  for (const key of SERVICE_KEYS) {
    result[key] = parseBool(getSetting(`service.${key}`, "0"), false);
  }
  return result;
}

export function saveServiceSwitches(input = {}) {
  const before = getServiceSwitches();
  const apply = [];
  for (const key of SERVICE_KEYS) {
    if (typeof input[key] === "undefined") continue;
    const nextValue = Boolean(input[key]);
    setSetting(`service.${key}`, nextValue ? "1" : "0");
    if (before[key] !== nextValue) {
      apply.push(applyServiceState(key, nextValue));
    }
  }
  return {
    switches: getServiceSwitches(),
    apply
  };
}

export function getAccessPorts() {
  return {
    httpPort: parseIntSafe(getSetting("access.httpPort", String(config.proxyPublicPort)), config.proxyPublicPort),
    httpsPort: parseIntSafe(getSetting("access.httpsPort", String(config.proxyPublicPort)), config.proxyPublicPort),
    forceHttpsAuth: parseBool(getSetting("security.forceHttpsAuth", config.forceHttpsAuth ? "1" : "0"), config.forceHttpsAuth)
  };
}

export function saveAccessPorts(input = {}) {
  const httpPort = parseIntSafe(input.httpPort, getAccessPorts().httpPort);
  const httpsPort = parseIntSafe(input.httpsPort, getAccessPorts().httpsPort);
  if (httpPort < 1 || httpPort > 65535 || httpsPort < 1 || httpsPort > 65535) {
    throw new HttpError(400, "端口范围应为 1-65535");
  }

  setSetting("access.httpPort", String(httpPort));
  setSetting("access.httpsPort", String(httpsPort));
  if (typeof input.forceHttpsAuth !== "undefined") {
    setSetting("security.forceHttpsAuth", input.forceHttpsAuth ? "1" : "0");
  }
  return getAccessPorts();
}

export function getRemoteAccessConfig() {
  return {
    enabled: parseBool(getSetting("remote.enabled", "0"), false),
    provider: getSetting("remote.provider", "cloudflare"),
    domain: getSetting("remote.domain", ""),
    tokenMasked: getSetting("remote.token", "") ? "******" : "",
    fnConnectEnabled: parseBool(getSetting("remote.fnConnectEnabled", "0"), false),
    externalSharingEnabled: parseBool(getSetting("remote.externalSharingEnabled", "0"), false),
    externalBaseUrl: getSetting("remote.externalBaseUrl", "")
  };
}

export function saveRemoteAccessConfig(input = {}) {
  if (typeof input.enabled !== "undefined") {
    setSetting("remote.enabled", input.enabled ? "1" : "0");
  }
  if (typeof input.provider === "string") {
    setSetting("remote.provider", input.provider.trim() || "cloudflare");
  }
  if (typeof input.domain === "string") {
    setSetting("remote.domain", input.domain.trim());
  }
  if (typeof input.token === "string" && input.token.trim() && input.token.trim() !== "******") {
    setSetting("remote.token", input.token.trim());
  }
  if (typeof input.fnConnectEnabled !== "undefined") {
    setSetting("remote.fnConnectEnabled", input.fnConnectEnabled ? "1" : "0");
  }
  if (typeof input.externalSharingEnabled !== "undefined") {
    setSetting("remote.externalSharingEnabled", input.externalSharingEnabled ? "1" : "0");
  }
  if (typeof input.externalBaseUrl === "string") {
    setSetting("remote.externalBaseUrl", input.externalBaseUrl.trim());
  }
  return getRemoteAccessConfig();
}

export function listDDNSRecords() {
  const rows = db
    .prepare(
      `SELECT id, provider, domain, ip_address, status, config_json, last_synced_at, created_at, updated_at
       FROM ddns_records
       ORDER BY id DESC`
    )
    .all();

  return rows.map((r) => {
    let configJson = {};
    try {
      configJson = JSON.parse(r.config_json || "{}");
    } catch {
      configJson = {};
    }
    return {
      ...r,
      config: configJson
    };
  });
}

export function createDDNSRecord({ provider = "cloudflare", domain, ipAddress = "", status = "unknown", config: cfg = {} }) {
  const d = String(domain || "").trim();
  if (!d) throw new HttpError(400, "domain 必填");
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO ddns_records (provider, domain, ip_address, status, config_json, last_synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(provider || "cloudflare"),
      d,
      String(ipAddress || ""),
      String(status || "unknown"),
      JSON.stringify(cfg || {}),
      now,
      now,
      now
    );
  return db.prepare("SELECT * FROM ddns_records WHERE id = ?").get(info.lastInsertRowid);
}

export function deleteDDNSRecord(id) {
  const row = db.prepare("SELECT id FROM ddns_records WHERE id = ?").get(Number(id));
  if (!row) throw new HttpError(404, "DDNS 记录不存在");
  db.prepare("DELETE FROM ddns_records WHERE id = ?").run(Number(id));
  return { ok: true, id: Number(id) };
}

export function listExternalShares() {
  return db
    .prepare(
      `SELECT id, name, provider, source_path, token, access_url, expires_at, status, created_at, updated_at
       FROM external_shares
       ORDER BY id DESC`
    )
    .all();
}

export function createExternalShare({ name, sourcePath, provider = "link", expiresAt = "" }) {
  const displayName = String(name || "").trim() || "未命名共享";
  const sp = ensureAbsoluteDir(sourcePath);
  const token = crypto.randomBytes(12).toString("hex");
  const accessUrl = buildExternalAccessUrl(token);
  const now = new Date().toISOString();

  const info = db
    .prepare(
      `INSERT INTO external_shares (name, provider, source_path, token, access_url, expires_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    )
    .run(displayName, String(provider || "link"), sp, token, accessUrl, String(expiresAt || ""), now, now);

  return db
    .prepare(
      `SELECT id, name, provider, source_path, token, access_url, expires_at, status, created_at, updated_at
       FROM external_shares WHERE id = ?`
    )
    .get(info.lastInsertRowid);
}

export function deleteExternalShare(id) {
  const row = db.prepare("SELECT id FROM external_shares WHERE id = ?").get(Number(id));
  if (!row) throw new HttpError(404, "外链记录不存在");
  db.prepare("DELETE FROM external_shares WHERE id = ?").run(Number(id));
  return { ok: true, id: Number(id) };
}

export function getFileShareProtocols() {
  return {
    smb: {
      enabled: parseBool(getSetting("service.smbEnabled", "0"), false),
      host: getSetting("share.host", ""),
      port: parseIntSafe(getSetting("share.smb.port", "445"), 445)
    },
    webdav: {
      enabled: parseBool(getSetting("service.webdavEnabled", "0"), false),
      httpPort: parseIntSafe(getSetting("share.webdav.httpPort", "5005"), 5005),
      httpsPort: parseIntSafe(getSetting("share.webdav.httpsPort", "5006"), 5006)
    },
    ftp: {
      enabled: parseBool(getSetting("service.ftpEnabled", "0"), false),
      port: parseIntSafe(getSetting("share.ftp.port", "21"), 21)
    },
    nfs: {
      enabled: parseBool(getSetting("service.nfsEnabled", "0"), false),
      mountRoot: getSetting("share.nfs.root", "/")
    },
    dlna: {
      enabled: parseBool(getSetting("service.dlnaEnabled", "0"), false),
      mediaPath: getSetting("share.dlna.mediaPath", config.mediaPath)
    }
  };
}

export function saveFileShareProtocols(input = {}) {
  const now = new Date().toISOString();
  const writable = {
    "share.host": input.host,
    "share.smb.port": input.smbPort,
    "share.webdav.httpPort": input.webdavHttpPort,
    "share.webdav.httpsPort": input.webdavHttpsPort,
    "share.ftp.port": input.ftpPort,
    "share.nfs.root": input.nfsRoot,
    "share.dlna.mediaPath": input.dlnaMediaPath
  };

  const upsert = db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  );

  for (const [k, v] of Object.entries(writable)) {
    if (typeof v === "undefined") continue;
    upsert.run(k, String(v ?? ""), now);
  }

  return getFileShareProtocols();
}

export function listComposeProjectsConfig() {
  return db
    .prepare(
      `SELECT id, name, project_path, compose_file, source_type, created_at, updated_at
       FROM compose_projects
       ORDER BY id DESC`
    )
    .all();
}

export function upsertComposeProjectConfig({ name, projectPath, composeFile, sourceType = "inline" }) {
  const projectName = String(name || "").trim();
  if (!projectName) throw new HttpError(400, "项目名不能为空");
  const basePath = ensureAbsoluteDir(projectPath);
  const composePath = path.resolve(basePath, String(composeFile || "docker-compose.yml"));
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO compose_projects (name, project_path, compose_file, source_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
      project_path = excluded.project_path,
      compose_file = excluded.compose_file,
      source_type = excluded.source_type,
      updated_at = excluded.updated_at`
  ).run(projectName, basePath, composePath, String(sourceType || "inline"), now, now);

  return db
    .prepare(
      `SELECT id, name, project_path, compose_file, source_type, created_at, updated_at
       FROM compose_projects WHERE name = ?`
    )
    .get(projectName);
}

export function deleteComposeProjectConfig(projectName) {
  const name = String(projectName || "").trim();
  if (!name) throw new HttpError(400, "项目名不能为空");
  const row = db.prepare("SELECT id FROM compose_projects WHERE name = ?").get(name);
  if (!row) throw new HttpError(404, "Compose 项目配置不存在");
  db.prepare("DELETE FROM compose_projects WHERE name = ?").run(name);
  return { ok: true, name };
}

export function getRegistrySettings() {
  return {
    mirror: getSetting("docker.registryMirror", ""),
    proxy: getSetting("docker.registryProxy", ""),
    insecureRegistry: getSetting("docker.insecureRegistry", "")
  };
}

export function saveRegistrySettings(input = {}) {
  if (typeof input.mirror === "string") {
    setSetting("docker.registryMirror", input.mirror.trim());
  }
  if (typeof input.proxy === "string") {
    setSetting("docker.registryProxy", input.proxy.trim());
  }
  if (typeof input.insecureRegistry === "string") {
    setSetting("docker.insecureRegistry", input.insecureRegistry.trim());
  }
  return getRegistrySettings();
}

export function getSystemCapabilities() {
  return {
    allowHostServiceControl: config.allowHostServiceControl,
    allowHostNetworkApply: config.allowHostNetworkApply,
    forceHttpsAuthDefault: config.forceHttpsAuth,
    allowPlainLoginPayload: config.allowPlainLoginPayload,
    hostExec: getHostExecStatus()
  };
}
