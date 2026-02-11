import express from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import {
  getActiveSessions,
  getContinueWatching,
  getLatestItems,
  listMediaLibrary,
  getMediaSummary,
  refreshLibrary
} from "../services/jellyfinService.js";
import { writeAudit } from "../services/auditService.js";

const router = express.Router();
router.use(requireAuth);

router.get(
  "/summary",
  asyncHandler(async (_req, res) => {
    res.json(await getMediaSummary());
  })
);

router.get(
  "/continue-watching",
  asyncHandler(async (req, res) => {
    res.json(await getContinueWatching(Number(req.query.limit || 12)));
  })
);

router.get(
  "/latest",
  asyncHandler(async (req, res) => {
    res.json(await getLatestItems(Number(req.query.limit || 20)));
  })
);

router.get(
  "/sessions",
  asyncHandler(async (_req, res) => {
    res.json(await getActiveSessions());
  })
);

router.get(
  "/library",
  asyncHandler(async (req, res) => {
    res.json(
      await listMediaLibrary({
        types: req.query.types,
        searchTerm: req.query.search,
        limit: req.query.limit,
        startIndex: req.query.start
      })
    );
  })
);

router.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const result = await refreshLibrary();
    writeAudit({ action: "media_refresh", actor: req.user.username, target: "jellyfin", status: "ok" });
    res.json(result);
  })
);

export default router;
