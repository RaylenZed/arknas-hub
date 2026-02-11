import express from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import {
  bindCertificateRoutes,
  deleteCertificate,
  issueCertificate,
  listCertificates,
  readCertificateFile,
  renewCertificateById
} from "../services/sslService.js";
import { writeAudit } from "../services/auditService.js";
import { HttpError } from "../lib/httpError.js";

const router = express.Router();
router.use(requireAuth);

router.get(
  "/certs",
  asyncHandler(async (_req, res) => {
    res.json(listCertificates());
  })
);

router.post(
  "/certs/issue",
  asyncHandler(async (req, res) => {
    const { domain, sans = [], email = "", autoRenew = true } = req.body || {};
    if (!domain) throw new HttpError(400, "domain 必填");
    const result = await issueCertificate({ domain, sans, email, autoRenew });
    writeAudit({ action: "ssl_issue", actor: req.user.username, target: domain, status: "ok" });
    res.json(result);
  })
);

router.post(
  "/certs/:id/renew",
  asyncHandler(async (req, res) => {
    const result = await renewCertificateById(Number(req.params.id));
    writeAudit({ action: "ssl_renew", actor: req.user.username, target: String(req.params.id), status: "ok" });
    res.json(result);
  })
);

router.patch(
  "/certs/:id/bind",
  asyncHandler(async (req, res) => {
    const routes = Array.isArray(req.body?.routes) ? req.body.routes : [];
    const result = bindCertificateRoutes(Number(req.params.id), routes);
    writeAudit({
      action: "ssl_bind_routes",
      actor: req.user.username,
      target: String(req.params.id),
      status: "ok",
      detail: JSON.stringify(routes)
    });
    res.json(result);
  })
);

router.get(
  "/certs/:id/download",
  asyncHandler(async (req, res) => {
    const type = String(req.query.type || "fullchain");
    const file = readCertificateFile(Number(req.params.id), type);
    res.setHeader("Content-Disposition", `attachment; filename=${file.filename}`);
    res.type("application/x-pem-file").send(file.content);
  })
);

router.delete(
  "/certs/:id",
  asyncHandler(async (req, res) => {
    const result = deleteCertificate(Number(req.params.id));
    writeAudit({ action: "ssl_delete", actor: req.user.username, target: String(req.params.id), status: "ok" });
    res.json(result);
  })
);

export default router;
