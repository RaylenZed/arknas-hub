import express from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { writeAudit } from "../services/auditService.js";
import {
  addGroupMember,
  createDDNSRecord,
  createExternalShare,
  createGroup,
  createStorageSpace,
  createUser,
  deleteComposeProjectConfig,
  deleteDDNSRecord,
  deleteExternalShare,
  deleteGroup,
  deleteStorageSpace,
  deleteUser,
  deleteUserQuota,
  getAccessPorts,
  getDeviceOverview,
  getFileShareProtocols,
  getRegistrySettings,
  getRemoteAccessConfig,
  getServiceSwitches,
  getSystemCapabilities,
  getSystemStatus,
  listComposeProjectsConfig,
  listDDNSRecords,
  listExternalShares,
  listGroups,
  listNetworkProfiles,
  listStorageSpaces,
  listUserQuotas,
  listUsers,
  removeGroupMember,
  saveAccessPorts,
  saveFileShareProtocols,
  saveRegistrySettings,
  saveRemoteAccessConfig,
  saveServiceSwitches,
  updateGroup,
  updateStorageSpace,
  updateUser,
  upsertComposeProjectConfig,
  upsertNetworkProfile,
  upsertUserQuota
} from "../services/systemService.js";

const router = express.Router();
router.use(requireAuth);

router.get(
  "/capabilities",
  asyncHandler(async (_req, res) => {
    res.json(getSystemCapabilities());
  })
);

router.get(
  "/status",
  asyncHandler(async (_req, res) => {
    res.json(await getSystemStatus());
  })
);

router.get(
  "/device-overview",
  asyncHandler(async (_req, res) => {
    res.json(await getDeviceOverview());
  })
);

router.get(
  "/users",
  asyncHandler(async (_req, res) => {
    res.json(listUsers());
  })
);

router.post(
  "/users",
  asyncHandler(async (req, res) => {
    const user = createUser(req.body || {});
    writeAudit({ action: "system_user_create", actor: req.user.username, target: user.username, status: "ok" });
    res.status(201).json(user);
  })
);

router.patch(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const updated = updateUser(req.params.id, req.body || {});
    writeAudit({ action: "system_user_update", actor: req.user.username, target: String(req.params.id), status: "ok" });
    res.json(updated);
  })
);

router.delete(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const result = deleteUser(req.params.id);
    writeAudit({ action: "system_user_delete", actor: req.user.username, target: String(req.params.id), status: "ok" });
    res.json(result);
  })
);

router.get(
  "/users/:id/quotas",
  asyncHandler(async (req, res) => {
    res.json(listUserQuotas(req.params.id));
  })
);

router.post(
  "/users/:id/quotas",
  asyncHandler(async (req, res) => {
    const quota = upsertUserQuota(req.params.id, req.body || {});
    writeAudit({
      action: "system_user_quota_upsert",
      actor: req.user.username,
      target: `${req.params.id}:${quota.mount_path}`,
      status: "ok"
    });
    res.status(201).json(quota);
  })
);

router.delete(
  "/user-quotas/:quotaId",
  asyncHandler(async (req, res) => {
    const result = deleteUserQuota(req.params.quotaId);
    writeAudit({
      action: "system_user_quota_delete",
      actor: req.user.username,
      target: String(req.params.quotaId),
      status: "ok"
    });
    res.json(result);
  })
);

router.get(
  "/groups",
  asyncHandler(async (_req, res) => {
    res.json(listGroups());
  })
);

router.post(
  "/groups",
  asyncHandler(async (req, res) => {
    const group = createGroup(req.body || {});
    writeAudit({ action: "system_group_create", actor: req.user.username, target: group.name, status: "ok" });
    res.status(201).json(group);
  })
);

router.patch(
  "/groups/:id",
  asyncHandler(async (req, res) => {
    const group = updateGroup(req.params.id, req.body || {});
    writeAudit({ action: "system_group_update", actor: req.user.username, target: String(req.params.id), status: "ok" });
    res.json(group);
  })
);

router.delete(
  "/groups/:id",
  asyncHandler(async (req, res) => {
    const result = deleteGroup(req.params.id);
    writeAudit({ action: "system_group_delete", actor: req.user.username, target: String(req.params.id), status: "ok" });
    res.json(result);
  })
);

router.post(
  "/groups/:id/members",
  asyncHandler(async (req, res) => {
    const result = addGroupMember(req.params.id, req.body?.userId);
    writeAudit({
      action: "system_group_member_add",
      actor: req.user.username,
      target: `${req.params.id}:${req.body?.userId}`,
      status: "ok"
    });
    res.json(result);
  })
);

router.delete(
  "/groups/:id/members/:userId",
  asyncHandler(async (req, res) => {
    const result = removeGroupMember(req.params.id, req.params.userId);
    writeAudit({
      action: "system_group_member_remove",
      actor: req.user.username,
      target: `${req.params.id}:${req.params.userId}`,
      status: "ok"
    });
    res.json(result);
  })
);

router.get(
  "/storage/spaces",
  asyncHandler(async (_req, res) => {
    res.json(await listStorageSpaces());
  })
);

router.post(
  "/storage/spaces",
  asyncHandler(async (req, res) => {
    const row = createStorageSpace(req.body || {});
    writeAudit({ action: "system_storage_create", actor: req.user.username, target: row.name, status: "ok" });
    res.status(201).json(row);
  })
);

router.patch(
  "/storage/spaces/:id",
  asyncHandler(async (req, res) => {
    const row = updateStorageSpace(req.params.id, req.body || {});
    writeAudit({ action: "system_storage_update", actor: req.user.username, target: row.name, status: "ok" });
    res.json(row);
  })
);

router.delete(
  "/storage/spaces/:id",
  asyncHandler(async (req, res) => {
    const result = deleteStorageSpace(req.params.id);
    writeAudit({ action: "system_storage_delete", actor: req.user.username, target: String(req.params.id), status: "ok" });
    res.json(result);
  })
);

router.get(
  "/network/interfaces",
  asyncHandler(async (_req, res) => {
    res.json(await listNetworkProfiles());
  })
);

router.put(
  "/network/interfaces/:iface",
  asyncHandler(async (req, res) => {
    const result = upsertNetworkProfile(req.params.iface, req.body || {});
    writeAudit({
      action: "system_network_update",
      actor: req.user.username,
      target: req.params.iface,
      status: result.apply.status === "ok" || result.apply.status === "skipped" ? "ok" : "failed",
      detail: result.apply.message || ""
    });
    res.json(result);
  })
);

router.get(
  "/access-ports",
  asyncHandler(async (_req, res) => {
    res.json(getAccessPorts());
  })
);

router.put(
  "/access-ports",
  asyncHandler(async (req, res) => {
    const result = saveAccessPorts(req.body || {});
    writeAudit({ action: "system_access_port_update", actor: req.user.username, status: "ok" });
    res.json(result);
  })
);

router.get(
  "/remote",
  asyncHandler(async (_req, res) => {
    res.json(getRemoteAccessConfig());
  })
);

router.put(
  "/remote",
  asyncHandler(async (req, res) => {
    const result = saveRemoteAccessConfig(req.body || {});
    writeAudit({ action: "system_remote_update", actor: req.user.username, status: "ok" });
    res.json(result);
  })
);

router.get(
  "/ddns",
  asyncHandler(async (_req, res) => {
    res.json(listDDNSRecords());
  })
);

router.post(
  "/ddns",
  asyncHandler(async (req, res) => {
    const row = createDDNSRecord(req.body || {});
    writeAudit({ action: "system_ddns_create", actor: req.user.username, target: row.domain, status: "ok" });
    res.status(201).json(row);
  })
);

router.delete(
  "/ddns/:id",
  asyncHandler(async (req, res) => {
    const result = deleteDDNSRecord(req.params.id);
    writeAudit({ action: "system_ddns_delete", actor: req.user.username, target: String(req.params.id), status: "ok" });
    res.json(result);
  })
);

router.get(
  "/external-shares",
  asyncHandler(async (_req, res) => {
    res.json(listExternalShares());
  })
);

router.post(
  "/external-shares",
  asyncHandler(async (req, res) => {
    const row = createExternalShare(req.body || {});
    writeAudit({ action: "system_external_share_create", actor: req.user.username, target: row.name, status: "ok" });
    res.status(201).json(row);
  })
);

router.delete(
  "/external-shares/:id",
  asyncHandler(async (req, res) => {
    const result = deleteExternalShare(req.params.id);
    writeAudit({ action: "system_external_share_delete", actor: req.user.username, target: String(req.params.id), status: "ok" });
    res.json(result);
  })
);

router.get(
  "/services",
  asyncHandler(async (_req, res) => {
    res.json(getServiceSwitches());
  })
);

router.put(
  "/services",
  asyncHandler(async (req, res) => {
    const result = saveServiceSwitches(req.body || {});
    writeAudit({ action: "system_services_update", actor: req.user.username, status: "ok", detail: JSON.stringify(result.apply || []) });
    res.json(result);
  })
);

router.get(
  "/share/protocols",
  asyncHandler(async (_req, res) => {
    res.json(getFileShareProtocols());
  })
);

router.put(
  "/share/protocols",
  asyncHandler(async (req, res) => {
    const result = saveFileShareProtocols(req.body || {});
    writeAudit({ action: "system_share_protocol_update", actor: req.user.username, status: "ok" });
    res.json(result);
  })
);

router.get(
  "/compose-configs",
  asyncHandler(async (_req, res) => {
    res.json(listComposeProjectsConfig());
  })
);

router.post(
  "/compose-configs",
  asyncHandler(async (req, res) => {
    const row = upsertComposeProjectConfig(req.body || {});
    writeAudit({ action: "system_compose_config_upsert", actor: req.user.username, target: row.name, status: "ok" });
    res.status(201).json(row);
  })
);

router.delete(
  "/compose-configs/:name",
  asyncHandler(async (req, res) => {
    const result = deleteComposeProjectConfig(req.params.name);
    writeAudit({ action: "system_compose_config_delete", actor: req.user.username, target: req.params.name, status: "ok" });
    res.json(result);
  })
);

router.get(
  "/docker/registry-settings",
  asyncHandler(async (_req, res) => {
    res.json(getRegistrySettings());
  })
);

router.put(
  "/docker/registry-settings",
  asyncHandler(async (req, res) => {
    const result = saveRegistrySettings(req.body || {});
    writeAudit({ action: "system_registry_setting_update", actor: req.user.username, status: "ok" });
    res.json(result);
  })
);

export default router;
