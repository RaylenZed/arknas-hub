import express from "express";
import multer from "multer";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import {
  addMagnet,
  addTorrentFile,
  deleteTasks,
  getDownloadSummary,
  listRecentCompleted,
  listTasks,
  pauseTasks,
  resumeTasks
} from "../services/qbittorrentService.js";
import { writeAudit } from "../services/auditService.js";
import { HttpError } from "../lib/httpError.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
router.use(requireAuth);

router.get(
  "/summary",
  asyncHandler(async (_req, res) => {
    res.json(await getDownloadSummary());
  })
);

router.get(
  "/tasks",
  asyncHandler(async (req, res) => {
    const filter = String(req.query.filter || "all");
    res.json(await listTasks(filter));
  })
);

router.get(
  "/recent-completed",
  asyncHandler(async (req, res) => {
    res.json(await listRecentCompleted(Number(req.query.limit || 20)));
  })
);

router.post(
  "/add-magnet",
  asyncHandler(async (req, res) => {
    const { urls, savepath = "" } = req.body || {};
    if (!urls) throw new HttpError(400, "urls 必填");
    await addMagnet(String(urls), String(savepath));
    writeAudit({ action: "download_add_magnet", actor: req.user.username, target: "qB", status: "ok" });
    res.json({ ok: true });
  })
);

router.post(
  "/add-torrent",
  upload.single("torrent"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, "torrent 文件缺失");
    await addTorrentFile(req.file, String(req.body?.savepath || ""));
    writeAudit({ action: "download_add_torrent", actor: req.user.username, target: req.file.originalname, status: "ok" });
    res.json({ ok: true });
  })
);

router.post(
  "/pause",
  asyncHandler(async (req, res) => {
    const hashes = String(req.body?.hashes || "");
    await pauseTasks(hashes);
    writeAudit({ action: "download_pause", actor: req.user.username, target: hashes, status: "ok" });
    res.json({ ok: true });
  })
);

router.post(
  "/resume",
  asyncHandler(async (req, res) => {
    const hashes = String(req.body?.hashes || "");
    await resumeTasks(hashes);
    writeAudit({ action: "download_resume", actor: req.user.username, target: hashes, status: "ok" });
    res.json({ ok: true });
  })
);

router.post(
  "/delete",
  asyncHandler(async (req, res) => {
    const hashes = String(req.body?.hashes || "");
    const deleteFiles = Boolean(req.body?.deleteFiles);
    await deleteTasks(hashes, deleteFiles);
    writeAudit({
      action: "download_delete",
      actor: req.user.username,
      target: hashes,
      status: "ok",
      detail: `deleteFiles=${deleteFiles}`
    });
    res.json({ ok: true });
  })
);

export default router;
