import { verifyToken } from "../auth.js";
import { HttpError } from "../lib/httpError.js";

export function requireAuth(req, _res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : req.cookies?.arknas_token || "";

  if (!token) {
    return next(new HttpError(401, "未登录或 Token 缺失"));
  }

  try {
    req.user = verifyToken(token);
    return next();
  } catch (err) {
    return next(err);
  }
}
