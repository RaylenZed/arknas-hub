import express from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { getIntegrations, saveIntegrations } from "../services/settingsService.js";
import { listAuditLogs, writeAudit } from "../services/auditService.js";

const router = express.Router();
router.use(requireAuth);

router.get(
  "/integrations",
  asyncHandler(async (_req, res) => {
    res.json(getIntegrations());
  })
);

router.put(
  "/integrations",
  asyncHandler(async (req, res) => {
    saveIntegrations(req.body || {});
    writeAudit({ action: "settings_update_integrations", actor: req.user.username, status: "ok" });
    res.json({ ok: true });
  })
);

router.get(
  "/audit-logs",
  asyncHandler(async (req, res) => {
    const limit = Number(req.query.limit || 200);
    res.json(listAuditLogs(limit));
  })
);

export default router;
