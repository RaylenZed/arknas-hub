import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { db } from "./db.js";
import { config } from "./config.js";
import { HttpError } from "./lib/httpError.js";

const loginKeyPair = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048
});
const loginPublicKeyPem = loginKeyPair.publicKey.export({ type: "spki", format: "pem" });
const loginKeyId = crypto.randomBytes(12).toString("hex");

export function getLoginPublicKey() {
  return {
    keyId: loginKeyId,
    algorithms: ["RSA-OAEP-256", "RSAES-PKCS1-v1_5"],
    publicKey: String(loginPublicKeyPem)
  };
}

function tryDecrypt(buffer, mode) {
  if (mode === "RSAES-PKCS1-v1_5") {
    return crypto.privateDecrypt(
      {
        key: loginKeyPair.privateKey,
        padding: crypto.constants.RSA_PKCS1_PADDING
      },
      buffer
    );
  }
  return crypto.privateDecrypt(
    {
      key: loginKeyPair.privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256"
    },
    buffer
  );
}

export function decodeLoginPassword({ password, passwordEncrypted, keyId, algorithm, allowPlaintext = false }) {
  if (typeof password === "string" && password.length > 0) {
    if (allowPlaintext) return password;
    throw new HttpError(400, "禁止明文密码提交，请刷新页面后重试");
  }
  const encrypted = String(passwordEncrypted || "").trim();
  if (!encrypted) return "";
  if (String(keyId || "").trim() !== loginKeyId) {
    throw new HttpError(400, "登录密钥已失效，请刷新页面后重试");
  }

  const encryptedBuffer = Buffer.from(encrypted, "base64");
  const pref = String(algorithm || "").trim();
  const modes = pref ? [pref] : [];
  if (!modes.includes("RSA-OAEP-256")) modes.push("RSA-OAEP-256");
  if (!modes.includes("RSAES-PKCS1-v1_5")) modes.push("RSAES-PKCS1-v1_5");

  try {
    for (const mode of modes) {
      try {
        const decrypted = tryDecrypt(encryptedBuffer, mode);
        return decrypted.toString("utf8");
      } catch {
        // try next mode
      }
    }
    throw new Error("all decrypt modes failed");
  } catch (err) {
    throw new HttpError(400, `无法解密登录凭据: ${String(err.message || err)}`);
  }
}

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
