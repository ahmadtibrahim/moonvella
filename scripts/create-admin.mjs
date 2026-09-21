/**
 * Create the primary owner account.
 *
 * Run once, interactively, by someone with shell access to the container:
 *
 *   docker compose exec app node scripts/create-admin.mjs \
 *     --email you@example.com --name "Your Name"
 *
 * There is deliberately no --password flag and no password environment
 * variable. Any of those would put the plaintext into shell history, the
 * process argument list (readable by every user on the host via /proc), or an
 * environment file — all of which outlive the command. Instead the password is
 * typed at a hidden prompt and hashed in this process, so the only thing that
 * ever leaves the machine is the bcrypt digest.
 *
 * This script creates the primary owner and nothing else. Every other account
 * is created by invitation from the admin panel.
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { stdin as input, stdout as output } from "node:process";

const prisma = new PrismaClient();

// Must match BCRYPT_ROUNDS in app/utils/auth.server.ts. A mismatch would not
// break sign-in — the cost is stored in each hash — but it would leave the
// first account materially weaker than every account created after it.
const BCRYPT_ROUNDS = 12;

const MIN_PASSWORD_LENGTH = 12;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

/**
 * Read a line from the terminal with echo disabled.
 *
 * Refuses to run when stdin is not a terminal. A piped password would have to
 * come from a file or an earlier command — that is, from somewhere it was
 * already written down, which defeats the point of prompting at all.
 */
function promptHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) {
      reject(
        new Error(
          "No terminal available for the password prompt. Run this with an\n" +
            "interactive TTY (docker compose exec, not exec -T)."
        )
      );
      return;
    }

    output.write(prompt);

    let value = "";
    const wasRaw = input.isRaw;

    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");

    const finish = (result, error) => {
      input.removeListener("data", onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(result);
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        switch (ch) {
          case "\r":
          case "\n":
          case "\u0004": // Ctrl-D
            finish(value);
            return;
          case "\u0003": // Ctrl-C
            finish(null, new Error("Cancelled."));
            return;
          case "\u007f": // Backspace (DEL)
          case "\b":
            value = value.slice(0, -1);
            break;
          default:
            // Ignore the rest of the control range so arrow keys and escape
            // sequences cannot be pasted into the password.
            if (ch >= " ") value += ch;
        }
      }
    };

    input.on("data", onData);
  });
}

/**
 * Mirror of validatePasswordStrength in app/services/adminAuth.server.ts.
 *
 * Duplicated rather than imported because this is a plain .mjs script run
 * outside the bundler and cannot import the TypeScript module. The rules must
 * be kept in step; if they drift, the script is the stricter of the two and
 * the login path stays the authority.
 */
function validatePassword(password) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (Buffer.byteLength(password, "utf8") > 72) {
    return "Password must be at most 72 bytes (roughly 72 characters).";
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "Password must contain at least one letter and one number.";
  }
  return null;
}

function isBcryptHash(value) {
  return typeof value === "string" && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const email = typeof args.email === "string" ? args.email.trim().toLowerCase() : "";
  const name = typeof args.name === "string" ? args.name.trim() : "";
  // The pre-hashed path exists so this can be scripted by someone who already
  // holds a digest. It is still never a plaintext argument.
  const suppliedHash = typeof args["password-hash"] === "string" ? args["password-hash"] : "";

  if (!email || !email.includes("@")) {
    output.write(
      "Usage: node scripts/create-admin.mjs --email you@example.com --name \"Your Name\"\n\n" +
        "The password is entered at a hidden prompt. There is no --password flag\n" +
        "and no password environment variable, by design.\n"
    );
    process.exitCode = 1;
    return;
  }
  if (!name) {
    output.write("A display name is required: --name \"Your Name\"\n");
    process.exitCode = 1;
    return;
  }

  // Refuse before prompting, so nobody types a password for an account that
  // cannot be created. The partial unique index enforces this too; this is the
  // readable version of the same rule.
  const existingPrimary = await prisma.adminUser.findFirst({
    where: { isPrimaryOwner: true },
    select: { email: true },
  });

  if (existingPrimary) {
    output.write(
      `A primary owner already exists (${existingPrimary.email}).\n\n` +
        "This script creates the first owner only. To add staff, sign in at\n" +
        "https://admin.moonvella.com/admin/users and send an invitation. To\n" +
        "change the owner's own password, use Settings.\n"
    );
    process.exitCode = 1;
    return;
  }

  let passwordHash;

  if (suppliedHash) {
    if (!isBcryptHash(suppliedHash)) {
      output.write("The supplied --password-hash is not a valid bcrypt hash.\n");
      process.exitCode = 1;
      return;
    }
    passwordHash = suppliedHash;
  } else {
    const password = await promptHidden(`Password for ${email}: `);
    const strengthError = validatePassword(password);
    if (strengthError) {
      output.write(`${strengthError}\n`);
      process.exitCode = 1;
      return;
    }

    const confirm = await promptHidden("Confirm password: ");
    if (password !== confirm) {
      output.write("The two passwords do not match.\n");
      process.exitCode = 1;
      return;
    }

    passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.adminUser.create({
      data: {
        email,
        name,
        passwordHash,
        role: "OWNER",
        isPrimaryOwner: true,
        isActive: true,
        // Nobody clicked a link in an email, but the address was verified in
        // the only way that matters here: by whoever controls the mailbox also
        // controlling this shell. Leaving it null would make the owner look
        // permanently unverified in the panel.
        emailVerifiedAt: new Date(),
      },
      select: { id: true, email: true, name: true, role: true },
    });

    await tx.auditLog.create({
      data: {
        actorType: "ADMIN_USER",
        actorId: created.id,
        actorName: created.name,
        action: "security.primary_owner_created",
        entityType: "AdminUser",
        entityId: created.id,
        afterData: JSON.stringify({ email: created.email, role: created.role }),
        userAgent: "create-admin.mjs",
      },
    });

    return created;
  });

  // Prints the account, never the credential. This output may be pasted into a
  // deployment record; it must be safe to do so.
  output.write(`\nPrimary owner created.\n  email: ${user.email}\n  name:  ${user.name}\n  role:  ${user.role}\n`);
  output.write("\nSign in at https://admin.moonvella.com/admin/login\n");
}

main()
  .catch((error) => {
    output.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
