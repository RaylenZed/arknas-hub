import express from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import {
  createComposeProject,
  getDockerRegistrySettings,
  connectContainerToNetwork,
  controlComposeProject,
  controlContainer,
  createDockerNetwork,
  getContainerLogs,
  getContainerSummary,
  getDockerInfo,
  listComposeProjects,
  listDockerNetworks,
  listLocalImages,
  removeComposeProject,
  pullImageByName,
  removeDockerNetwork,
  removeLocalImage,
  searchRegistryRepositories,
  disconnectContainerFromNetwork,
  updateDockerRegistrySettings,
  updateContainer
} from "../services/dockerService.js";
import { writeAudit } from "../services/auditService.js";

const router = express.Router();
router.use(requireAuth);

router.get(
  "/summary",
  asyncHandler(async (_req, res) => {
    res.json(await getContainerSummary());
  })
);

router.get(
  "/info",
  asyncHandler(async (_req, res) => {
    res.json(await getDockerInfo());
  })
);

router.get(
  "/compose/projects",
  asyncHandler(async (_req, res) => {
    res.json(await listComposeProjects());
  })
);

router.post(
  "/compose/projects",
  asyncHandler(async (req, res) => {
    const result = await createComposeProject(req.body || {});
    writeAudit({
      action: "compose_create",
      actor: req.user.username,
      target: result.project,
      status: "ok"
    });
    res.status(201).json(result);
  })
);

router.delete(
  "/compose/projects/:project",
  asyncHandler(async (req, res) => {
    const down = Boolean(req.query.down === "1");
    const removeFiles = Boolean(req.query.removeFiles === "1");
    const result = await removeComposeProject(req.params.project, {
      down,
      removeFiles
    });
    writeAudit({
      action: "compose_delete",
      actor: req.user.username,
      target: req.params.project,
      status: "ok",
      detail: JSON.stringify(result)
    });
    res.json(result);
  })
);

router.post(
  "/compose/projects/:project/:action(start|stop|restart)",
  asyncHandler(async (req, res) => {
    const { project, action } = req.params;
    const result = await controlComposeProject(project, action);
    writeAudit({
      action: `compose_${action}`,
      actor: req.user.username,
      target: project,
      status: "ok",
      detail: JSON.stringify(result)
    });
    res.json(result);
  })
);

router.get(
  "/images",
  asyncHandler(async (_req, res) => {
    res.json(await listLocalImages());
  })
);

router.post(
  "/images/pull",
  asyncHandler(async (req, res) => {
    const image = String(req.body?.image || "");
    const result = await pullImageByName(image);
    writeAudit({
      action: "image_pull",
      actor: req.user.username,
      target: image,
      status: "ok"
    });
    res.json(result);
  })
);

router.delete(
  "/images/:id",
  asyncHandler(async (req, res) => {
    const force = Boolean(req.query.force === "1");
    const result = await removeLocalImage(req.params.id, force);
    writeAudit({
      action: "image_remove",
      actor: req.user.username,
      target: req.params.id,
      status: "ok",
      detail: `force=${force}`
    });
    res.json(result);
  })
);

router.get(
  "/registry/search",
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || "");
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 20);
    res.json(await searchRegistryRepositories(q, page, limit));
  })
);

router.get(
  "/registry/settings",
  asyncHandler(async (_req, res) => {
    res.json(getDockerRegistrySettings());
  })
);

router.put(
  "/registry/settings",
  asyncHandler(async (req, res) => {
    const result = updateDockerRegistrySettings(req.body || {});
    writeAudit({
      action: "registry_settings_update",
      actor: req.user.username,
      status: "ok"
    });
    res.json(result);
  })
);

router.get(
  "/networks",
  asyncHandler(async (_req, res) => {
    res.json(await listDockerNetworks());
  })
);

router.post(
  "/networks",
  asyncHandler(async (req, res) => {
    const result = await createDockerNetwork(req.body || {});
    writeAudit({
      action: "network_create",
      actor: req.user.username,
      target: result.name,
      status: "ok"
    });
    res.json(result);
  })
);

router.delete(
  "/networks/:id",
  asyncHandler(async (req, res) => {
    const result = await removeDockerNetwork(req.params.id);
    writeAudit({
      action: "network_remove",
      actor: req.user.username,
      target: req.params.id,
      status: "ok"
    });
    res.json(result);
  })
);

router.post(
  "/networks/:id/connect",
  asyncHandler(async (req, res) => {
    const containerId = String(req.body?.containerId || "");
    const result = await connectContainerToNetwork(req.params.id, containerId);
    writeAudit({
      action: "network_connect",
      actor: req.user.username,
      target: `${req.params.id}:${containerId}`,
      status: "ok"
    });
    res.json(result);
  })
);

router.post(
  "/networks/:id/disconnect",
  asyncHandler(async (req, res) => {
    const containerId = String(req.body?.containerId || "");
    const force = Boolean(req.body?.force);
    const result = await disconnectContainerFromNetwork(req.params.id, containerId, force);
    writeAudit({
      action: "network_disconnect",
      actor: req.user.username,
      target: `${req.params.id}:${containerId}`,
      status: "ok",
      detail: `force=${force}`
    });
    res.json(result);
  })
);

router.post(
  "/:id/:action(start|stop|restart)",
  asyncHandler(async (req, res) => {
    const { id, action } = req.params;
    const result = await controlContainer(id, action);
    writeAudit({ action: `container_${action}`, actor: req.user.username, target: id, status: "ok" });
    res.json(result);
  })
);

router.get(
  "/:id/logs",
  asyncHandler(async (req, res) => {
    const lines = Number(req.query.lines || 200);
    const logs = await getContainerLogs(req.params.id, lines);
    res.type("text/plain").send(logs);
  })
);

router.post(
  "/:id/update",
  asyncHandler(async (req, res) => {
    const recreate = Boolean(req.body?.recreate);
    const result = await updateContainer(req.params.id, { recreate });
    writeAudit({
      action: "container_update",
      actor: req.user.username,
      target: req.params.id,
      status: "ok",
      detail: JSON.stringify(result)
    });
    res.json(result);
  })
);

export default router;
