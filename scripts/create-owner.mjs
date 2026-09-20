import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = args.email || process.env.OWNER_EMAIL;
  const password = args.password || process.env.OWNER_PASSWORD;
  const name = args.name || process.env.OWNER_NAME || "Owner";
  const role = args.role || process.env.OWNER_ROLE || "OWNER";

  if (!email || !password) {
    console.error(
      "Usage: npm run create-owner -- --email you@example.com --password 'your-password' [--name 'Your Name'] [--role OWNER]"
    );
    process.exit(1);
  }

  if (String(password).length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const validRoles = ["OWNER", "OPERATIONS", "REVIEWER", "READONLY"];
  if (!validRoles.includes(role)) {
    console.error(`Role must be one of: ${validRoles.join(", ")}`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const existing = await prisma.ownerUser.findUnique({ where: { email } });

  if (existing) {
    await prisma.ownerUser.update({
      where: { email },
      data: { passwordHash, name, role, isActive: true },
    });
    console.log(`Updated existing owner account: ${email}`);
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
