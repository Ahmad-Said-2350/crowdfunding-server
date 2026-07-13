import "dotenv/config";
import { MongoClient } from "mongodb";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";

async function seed() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "fundora";
  if (!uri) throw new Error("MONGODB_URI required");

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  console.log(`Seeding database: ${dbName}`);

  const email = process.env.ADMIN_EMAIL || "admin@fundora.app";
  const password = process.env.ADMIN_PASSWORD || "Admin@Fundora2026";
  const existing = await db.collection("user").findOne({ email });
  if (existing) {
    await db.collection("user").updateOne(
      { email },
      { $set: { role: "admin", credits: existing.credits ?? 0, raisedCredits: existing.raisedCredits ?? 0 } }
    );
    console.log(`Admin already exists: ${email} (role ensured).`);
    await client.close();
    return;
  }

  const auth = betterAuth({
    database: mongodbAdapter(db, { client }),
    secret: process.env.BETTER_AUTH_SECRET || "dev-secret-change-me-in-production-32chars",
    baseURL: process.env.BETTER_AUTH_URL || "http://localhost:5000",
    emailAndPassword: { enabled: true },
    user: {
      additionalFields: {
        role: { type: "string", required: true, defaultValue: "admin", input: true },
        credits: { type: "number", required: true, defaultValue: 0, input: false },
        raisedCredits: { type: "number", required: true, defaultValue: 0, input: false },
      },
    },
  });

  await auth.api.signUpEmail({
    body: {
      email,
      password,
      name: "Fundora Admin",
      role: "admin",
    } as { email: string; password: string; name: string; role: string },
  });

  await db.collection("user").updateOne(
    { email },
    { $set: { role: "admin", credits: 0, raisedCredits: 0, image: "https://api.dicebear.com/9.x/initials/svg?seed=Admin" } }
  );

  console.log(`Seeded admin → ${email} / ${password}`);
  await client.close();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
