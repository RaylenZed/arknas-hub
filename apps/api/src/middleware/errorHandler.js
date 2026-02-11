import { logError } from "../lib/logger.js";

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: "Not Found" });
}

export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) {
    logError("request_failed", err, { path: req.path, method: req.method });
  }
  res.status(status).json({ error: err.message || "Internal Server Error" });
}
