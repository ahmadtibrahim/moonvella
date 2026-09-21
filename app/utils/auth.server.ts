import bcrypt from "bcryptjs";

/**
 * Password hashing.
 *
 * Cost 12, not the framework's default 10. The callers here are staff sign-ins
 * — a handful of people, throttled at the login route — so the extra ~150ms per
 * verification is invisible to them and directly multiplies the cost of
 * attacking a stolen hash offline. Raising this does not invalidate existing
 * hashes: the cost is stored inside each hash and bcrypt.compare reads it from
 * there, so older hashes keep working and re-hash at the new cost when the
 * password is next changed.
 */
const BCRYPT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  if (!storedHash) return false;
  try {
    return await bcrypt.compare(password, storedHash);
  } catch {
    return false;
  }
}

// A plaintext-token generator used to live here, returning a raw session token
// for direct storage. It is gone deliberately: session and invitation tokens
// are now minted in services/adminAuth.server.ts, which only ever hands back a
// token that the caller must store as a digest. Leaving an unhashed generator
// next to the hashing helpers invites re-introducing stored tokens later.
