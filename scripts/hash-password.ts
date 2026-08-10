// Generates a bcrypt hash for ADMIN_PASSWORD_HASH.
// Usage: npm run hash-password -- "your password here"
import bcrypt from "bcryptjs";

const password = process.argv[2];
if (!password) {
  console.error('Usage: npm run hash-password -- "your password here"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);

// Next.js's env loader (@next/env) expands $-prefixed tokens even inside
// single-quoted .env values, which mangles a raw bcrypt hash. Escaping each
// $ makes it paste safely into .env.local as ADMIN_PASSWORD_HASH=<this>.
console.log(hash.replace(/\$/g, "\\$"));
