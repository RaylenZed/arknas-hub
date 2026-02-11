import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { db } from "./db.js";
import { config } from "./config.js";
import { HttpError } from "./lib/httpError.js";

export function createToken(user) {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn
  });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    throw new HttpError(401, "认证已过期，请重新登录");
  }
}

export function loginUser(username, password) {
  const user = db
    .prepare("SELECT id, username, role, password_hash FROM users WHERE username = ?")
    .get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    throw new HttpError(401, "用户名或密码错误");
  }
  return { id: user.id, username: user.username, role: user.role };
}

export function changePassword(userId, oldPassword, newPassword) {
  const user = db.prepare("SELECT id, password_hash FROM users WHERE id = ?").get(userId);
  if (!user || !bcrypt.compareSync(oldPassword, user.password_hash)) {
    throw new HttpError(400, "旧密码不正确");
  }
  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(hash, now, userId);
}
