import express from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { getContainerSummary } from "../services/dockerService.js";
import { getMediaSummary } from "../services/jellyfinService.js";
import { getDownloadSummary, listRecentCompleted } from "../services/qbittorrentService.js";
import { getSystemStatus } from "../services/systemService.js";

const router = express.Router();
router.use(requireAuth);

async function withSafePromise(fn) {
  try {
    const data = await fn();
    return { ok: true, data, error: null };
  } catch (err) {
    return { ok: false, data: null, error: err.message || "unknown error" };
  }
}

router.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    const [containers, media, downloads, recentCompleted, system] = await Promise.all([
      withSafePromise(() => getContainerSummary()),
      withSafePromise(() => getMediaSummary()),
      withSafePromise(() => getDownloadSummary()),
      withSafePromise(() => listRecentCompleted(10)),
      withSafePromise(() => getSystemStatus())
    ]);

    res.json({
      updatedAt: new Date().toISOString(),
      containers,
      media,
      downloads,
      recentCompleted,
      system
    });
  })
);

export default router;
