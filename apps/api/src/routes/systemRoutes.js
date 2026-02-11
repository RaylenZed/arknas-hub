import express from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { getSystemStatus } from "../services/systemService.js";

const router = express.Router();

router.get(
  "/status",
  requireAuth,
  asyncHandler(async (_req, res) => {
    const data = await getSystemStatus();
    res.json(data);
  })
);

export default router;
