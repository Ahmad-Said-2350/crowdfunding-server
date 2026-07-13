import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";

async function ensureUser(
  auth: ReturnType<typeof betterAuth>,
  db: ReturnType<MongoClient["db"]>,
  input: {
    email: string;
    password: string;
    name: string;
    role: string;
    credits: number;
    raisedCredits?: number;
  }
) {
  const existing = await db.collection("user").findOne({ email: input.email });
  if (existing) {
    await db.collection("user").updateOne(
      { email: input.email },
      {
        $set: {
          role: input.role,
          credits: existing.credits ?? input.credits,
          raisedCredits: existing.raisedCredits ?? input.raisedCredits ?? 0,
          name: existing.name || input.name,
        },
      }
    );
    return existing;
  }

  await auth.api.signUpEmail({
    body: {
      email: input.email,
      password: input.password,
      name: input.name,
      role: input.role,
    } as { email: string; password: string; name: string; role: string },
  });

  await db.collection("user").updateOne(
    { email: input.email },
    {
      $set: {
        role: input.role,
        credits: input.credits,
        raisedCredits: input.raisedCredits ?? 0,
        image: `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(input.name)}`,
      },
    }
  );

  return db.collection("user").findOne({ email: input.email });
}

async function seed() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "fundora";
  if (!uri) throw new Error("MONGODB_URI required");

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  console.log(`Seeding database: ${dbName}`);

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

  const adminEmail = process.env.ADMIN_EMAIL || "admin@fundora.app";
  const adminPassword = process.env.ADMIN_PASSWORD || "Admin@Fundora2026";

  await ensureUser(auth, db, {
    email: adminEmail,
    password: adminPassword,
    name: "Pledgekit Admin",
    role: "admin",
    credits: 0,
  });
  console.log(`Admin ready → ${adminEmail}`);

  await ensureUser(auth, db, {
    email: "creator@pledgekit.app",
    password: "Creator@2026",
    name: "Amina Rahman",
    role: "creator",
    credits: 20,
    raisedCredits: 4200,
  });

  await ensureUser(auth, db, {
    email: "supporter@pledgekit.app",
    password: "Supporter@2026",
    name: "Noah Hasan",
    role: "supporter",
    credits: 120,
  });

  const campaignsCol = db.collection("campaigns");
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const demos = [
    {
      campaign_title: "Clean Water for Coastal Schools",
      campaign_story:
        "Install filtration systems across eight coastal schools so students have reliable drinking water through monsoon season.",
      category: "Environment",
      funding_goal: 8000,
      minimum_contribution: 20,
      deadline: new Date(now + 28 * day),
      reward_info: "Impact report + donor wall mention",
      campaign_image_url: "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=1200&q=80",
      amount_raised: 5120,
    },
    {
      campaign_title: "Neighborhood Maker Lab",
      campaign_story:
        "Open a community workshop with tools, mentorship, and weekend classes for young builders in Dhaka.",
      category: "Community",
      funding_goal: 6500,
      minimum_contribution: 15,
      deadline: new Date(now + 21 * day),
      reward_info: "Workshop day pass for early backers",
      campaign_image_url: "https://images.unsplash.com/photo-1511632765486-a01980e01a18?auto=format&fit=crop&w=1200&q=80",
      amount_raised: 2480,
    },
    {
      campaign_title: "Open Learning Tablets",
      campaign_story:
        "Distribute refurbished tablets loaded with offline STEM courses for students without stable internet.",
      category: "Education",
      funding_goal: 10000,
      minimum_contribution: 25,
      deadline: new Date(now + 35 * day),
      reward_info: "Progress dashboard access",
      campaign_image_url: "https://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=1200&q=80",
      amount_raised: 7340,
    },
    {
      campaign_title: "Clinic Telemetry Kit",
      campaign_story:
        "Equip rural clinics with portable diagnostic kits and a shared telehealth console for remote specialists.",
      category: "Healthcare",
      funding_goal: 12000,
      minimum_contribution: 30,
      deadline: new Date(now + 40 * day),
      reward_info: "Named kit plaque for major supporters",
      campaign_image_url: "https://images.unsplash.com/photo-1576091160550-2173dba999ef?auto=format&fit=crop&w=1200&q=80",
      amount_raised: 3910,
    },
    {
      campaign_title: "Green Transit Sensors",
      campaign_story:
        "Pilot low-cost air quality sensors on city buses and publish live neighborhood readings.",
      category: "Technology",
      funding_goal: 9000,
      minimum_contribution: 20,
      deadline: new Date(now + 18 * day),
      reward_info: "API access for civic developers",
      campaign_image_url: "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=1200&q=80",
      amount_raised: 6105,
    },
    {
      campaign_title: "Youth Arts Collective",
      campaign_story:
        "Fund studio space, mentors, and a public showcase for emerging artists from underserved neighborhoods.",
      category: "Arts",
      funding_goal: 4500,
      minimum_contribution: 10,
      deadline: new Date(now + 24 * day),
      reward_info: "Limited edition print set",
      campaign_image_url: "https://images.unsplash.com/photo-1513364776144-60967b0f800f?auto=format&fit=crop&w=1200&q=80",
      amount_raised: 1760,
    },
    {
      campaign_title: "Food Rescue Network",
      campaign_story:
        "Connect surplus restaurant meals with shelters using a coordinated volunteer logistics network.",
      category: "Social Impact",
      funding_goal: 7000,
      minimum_contribution: 15,
      deadline: new Date(now + 16 * day),
      reward_info: "Volunteer shift badge + impact digest",
      campaign_image_url: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?auto=format&fit=crop&w=1200&q=80",
      amount_raised: 4295,
    },
  ];

  const demoCount = await campaignsCol.countDocuments({ demo: true });
  if (demoCount === 0) {
    await campaignsCol.insertMany(
      demos.map((c) => ({
        ...c,
        creator_email: "creator@pledgekit.app",
        creator_name: "Amina Rahman",
        status: "approved",
        demo: true,
        createdAt: new Date(now - 7 * day),
        updatedAt: new Date(),
        _id: new ObjectId(),
      }))
    );
    console.log(`Seeded ${demos.length} approved demo campaigns.`);
  } else {
    const imageUpdateResult = await campaignsCol.bulkWrite(
      demos.map(({ campaign_title, campaign_image_url }) => ({
        updateMany: {
          filter: { demo: true, campaign_title },
          update: { $set: { campaign_image_url, updatedAt: new Date() } },
        },
      }))
    );
    console.log(
      `Demo campaigns already present (${demoCount}). Updated images for ${imageUpdateResult.matchedCount} campaign(s).`
    );
  }

  console.log("Seed complete.");
  await client.close();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
