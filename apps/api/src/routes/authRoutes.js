import express from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { changePassword, createToken, loginUser } from "../auth.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { writeAudit } from "../services/auditService.js";
import { HttpError } from "../lib/httpError.js";

const router = express.Router();

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) throw new HttpError(400, "用户名和密码必填");

    const user = loginUser(String(username), String(password));
    const token = createToken(user);

    writeAudit({ action: "login", actor: user.username, target: "auth", status: "ok" });

    res.json({ token, user });
  })
);

router.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    writeAudit({ action: "logout", actor: req.user.username, target: "auth", status: "ok" });
    res.json({ ok: true });
  })
);

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user });
  })
);

router.post(
  "/change-password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword || String(newPassword).length < 8) {
      throw new HttpError(400, "新密码至少 8 位");
    }
    changePassword(req.user.sub, String(oldPassword), String(newPassword));
    writeAudit({ action: "change_password", actor: req.user.username, status: "ok" });
    res.json({ ok: true });
  })
);

export default router;
