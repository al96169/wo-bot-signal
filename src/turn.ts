import crypto from "node:crypto";

const TURN_SECRET = process.env.TURN_SECRET || "";

if (!TURN_SECRET) {
  console.error("[Turn] TURN_SECRET not configured");
}

/**
 * 生成 TURN 短期凭证（24h 有效）
 * 与 coturn 的 static-auth-secret + use-auth-secret 模式一致
 */
export function generateTurnCredentials(userId: string): { username: string; credential: string; ttl: number } {
  if (!TURN_SECRET) {
    throw new Error("TURN_SECRET not configured");
  }

  // coturn 的 use-auth-secret 模式：username = expiryTimestamp:userId
  // expiry 以小时为单位（unix 时间戳 / 3600）
  const expiry = Math.floor(Date.now() / 3600) + 24; // 24 小制后过期
  const username = `${expiry}:${userId}`;
  const credential = crypto.createHmac("sha1", TURN_SECRET).update(username).digest("hex");

  return {
    username,
    credential,
    ttl: 24 * 3600, // 秒
  };
}
