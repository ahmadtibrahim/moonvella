import { createHash, randomBytes, timingSafeEqual } from "crypto";

const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 64;
const SALT_LENGTH = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await new Promise<Buffer>((resolve, reject) => {
    require("crypto").pbkdf2(
      password,
      salt,
      PBKDF2_ITERATIONS,
      64,
      "sha256",
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      }
    );
  });
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [saltHex, hashHex] = storedHash.split(":");
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, "hex");
  const hash = Buffer.from(hashHex, "hex");

  const computedHash = await new Promise<Buffer>((resolve, reject) => {
    require("crypto").pbkdf2(
      password,
      salt,
      100000,
      64,
      "sha256",
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      }
    );
  });

  return timingSafeEqual(hash, computedHash);
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}