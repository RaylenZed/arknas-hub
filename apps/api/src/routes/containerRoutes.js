import express from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import {
  controlContainer,
  getContainerLogs,
  getContainerSummary,
  getDockerInfo,
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
