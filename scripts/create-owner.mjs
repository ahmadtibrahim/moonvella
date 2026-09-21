import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const BCRYPT_ROUNDS = 12;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function isBcryptHash(value) {
  return typeof value === "string" && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = args.email || process.env.OWNER_EMAIL;
  const name = args.name || process.env.OWNER_NAME || "Owner";
  const role = args.role || process.env.OWNER_ROLE || "OWNER";

  // A pre-computed hash is the production path: no plaintext password ever
  // enters the environment, the compose file, or a shell history.
  const suppliedHash = args["password-hash"] || process.env.OWNER_PASSWORD_HASH;
  const suppliedPassword = args.password || process.env.OWNER_PASSWORD;

  if (!email) {
    console.error(
      "Usage: npm run create-owner -- --email you@example.com --password-hash '<bcrypt-hash>' [--name 'Your Name'] [--role OWNER]"
    );
    process.exit(1);
  }

  let passwordHash;
  if (suppliedHash) {
    if (!isBcryptHash(suppliedHash)) {
      console.error(
        "OWNER_PASSWORD_HASH is not a valid bcrypt hash. Generate one with:\n" +
          "  node -e \"console.log(require('bcryptjs').hashSync(process.argv[1],12))\" 'your-password'"
      );
      process.exit(1);
    }
    passwordHash = suppliedHash;
  } else if (suppliedPassword) {
    if (String(suppliedPassword).length < 12) {
      console.error("Password must be at least 12 characters.");
      process.exit(1);
    }
    console.warn(
      "WARNING: hashing a plaintext password supplied on the command line or in the environment.\n" +
        "         Prefer --password-hash / OWNER_PASSWORD_HASH in production so the plaintext\n" +
        "         never reaches the environment or shell history."
    );
    passwordHash = await bcrypt.hash(suppliedPassword, BCRYPT_ROUNDS);
  } else {
    console.error(
      "No password supplied. Pass --password-hash (preferred) or --password.\n" +
        "  node -e \"console.log(require('bcryptjs').hashSync(process.argv[1],12))\" 'your-password'"
    );
    process.exit(1);
  }

  const validRoles = ["OWNER", "OPERATIONS", "REVIEWER", "READONLY"];
  if (!validRoles.includes(role)) {
    console.error(`Role must be one of: ${validRoles.join(", ")}`);
    process.exit(1);
  }

  const existing = await prisma.ownerUser.findUnique({ where: { email } });

  if (existing) {
    await prisma.ownerUser.update({
      where: { email },
      data: { passwordHash, name, role, isActive: true },
    });
    // Changing credentials must not leave older sessions alive.
    await prisma.ownerSession.deleteMany({ where: { userId: existing.id } });
    console.log(`Updated owner account: ${email} (${role}) — existing sessions invalidated`);
  } else {
    await prisma.ownerUser.create({
      data: { email, passwordHash, name, role, isActive: true },
    });
    console.log(`Created owner account: ${email} (${role})`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
