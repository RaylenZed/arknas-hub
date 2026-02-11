import express from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { changePassword, createToken, decodeLoginPassword, getLoginPublicKey, loginUser } from "../auth.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { writeAudit } from "../services/auditService.js";
import { HttpError } from "../lib/httpError.js";
import { config } from "../config.js";
import { getAccessPorts } from "../services/systemService.js";

const router = express.Router();

router.get(
  "/public-key",
  asyncHandler(async (_req, res) => {
    res.json(getLoginPublicKey());
  })
);

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const accessPorts = getAccessPorts();
    if (accessPorts.forceHttpsAuth || config.forceHttpsAuth) {
      const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "").toLowerCase();
      const isSecure = req.secure || proto === "https";
      if (!isSecure) {
        throw new HttpError(400, "当前服务要求 HTTPS 登录，请使用 https:// 访问面板");
      }
    }

    const { username, password, passwordEncrypted, keyId, algorithm } = req.body || {};
    const finalPassword = decodeLoginPassword({
      password,
      passwordEncrypted,
      keyId,
      algorithm,
      allowPlaintext: config.allowPlainLoginPayload
    });
    if (!username || !finalPassword) throw new HttpError(400, "用户名和密码必填");
    const user = loginUser(String(username), String(finalPassword));
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
