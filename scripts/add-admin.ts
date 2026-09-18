import { SQL } from "bun";
import { platformRoles, type PlatformRole } from "../packages/contracts/src";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const db = new SQL(databaseUrl);

async function addAdmin() {
  const args = process.argv.slice(2);
  const email = args[0]?.trim().toLowerCase();
  const roleInput = (args[1]?.trim().toUpperCase() || "SUPER_ADMIN") as PlatformRole;

  if (!email) {
    console.log("Usage: bun run scripts/add-admin.ts <email> [ROLE]");
    console.log(`Available roles: ${platformRoles.join(", ")} (default: SUPER_ADMIN)`);
    process.exit(1);
  }

  if (!platformRoles.includes(roleInput)) {
    console.error(`Invalid role: ${roleInput}`);
    console.log(`Allowed roles: ${platformRoles.join(", ")}`);
    process.exit(1);
  }

  try {
    const users = await db.unsafe(`SELECT id, email FROM auth.users WHERE lower(email) = $1`, [email]);
    if (!users || users.length === 0) {
      console.error(`User with email "${email}" not found in auth.users.`);
      console.log("Please make sure the user is registered first.");
      process.exit(1);
    }

    const userId = users[0].id;

    await db.unsafe(
      `INSERT INTO public.platform_users (user_id, role, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (user_id) DO UPDATE SET role = $2, is_active = true, updated_at = now()`,
      [userId, roleInput]
    );

    console.log(`Successfully granted ${roleInput} platform role to "${email}" (ID: ${userId})`);
  } catch (error: any) {
    console.error("Failed to add admin:", error.message);
    process.exit(1);
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  addAdmin();
}
