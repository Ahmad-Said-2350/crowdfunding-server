import dotenv from "dotenv";
dotenv.config({ quiet: true });
import cors from "cors";
import express, { Request, Response, NextFunction } from "express";
import { MongoClient, ObjectId, Db, Collection } from "mongodb";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { jwt } from "better-auth/plugins";
import Stripe from "stripe";
import { z } from "zod";

const CREDIT_PACKAGES = {
  "100": { credits: 100, price: 10, label: "100 credits" },
  "300": { credits: 300, price: 25, label: "300 credits" },
  "800": { credits: 800, price: 60, label: "800 credits" },
  "1500": { credits: 1500, price: 110, label: "1500 credits" },
} as const;

const REGISTRATION_CREDITS = {
  supporter: 50,
  creator: 20,
  admin: 0,
} as const;

const WITHDRAW_CREDITS_PER_DOLLAR = 20;
const MIN_WITHDRAWAL_CREDITS = 200;

function momentumScore(amountRaised: number, fundingGoal: number, deadline: Date): number {
  const progress = fundingGoal > 0 ? amountRaised / fundingGoal : 0;
  const daysLeft = Math.max(1, (deadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  return Number((progress * 100 + Math.min(30, 30 / daysLeft)).toFixed(2));
}

function healthPayload() {
  return { ok: true, service: "pledgekit-api", time: new Date().toISOString() };
}

const PORT = Number(process.env.PORT) || 5000;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "fundora";
const CLIENT_URL = (process.env.CLIENT_URL || "http://localhost:3000").replace(/\/$/, "");
const BETTER_AUTH_URL = (process.env.BETTER_AUTH_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "dev-secret-change-me-in-production-32chars";
const IS_VERCEL = Boolean(process.env.VERCEL);

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

let client: MongoClient;
let db: Db;

type Role = "supporter" | "creator" | "admin";

interface AppUser {
  _id?: ObjectId;
  id?: string;
  name: string;
  email: string;
  emailVerified?: boolean;
  image?: string | null;
  bio?: string;
  phone?: string;
  location?: string;
  createdAt?: Date;
  updatedAt?: Date;
  role: Role;
  credits: number;
  raisedCredits: number;
  blocked?: boolean;
  blockedReason?: string;
  blockedAt?: Date | null;
}

interface Campaign {
  _id?: ObjectId;
  campaign_title: string;
  campaign_story: string;
  category: string;
  funding_goal: number;
  minimum_contribution: number;
  deadline: Date;
  reward_info: string;
  campaign_image_url: string;
  creator_email: string;
  creator_name: string;
  amount_raised: number;
  status: "pending" | "approved" | "rejected" | "suspended";
  createdAt: Date;
  updatedAt: Date;
}

interface Contribution {
  _id?: ObjectId;
  campaign_id: string;
  campaign_title: string;
  contribution_amount: number;
  supporter_email: string;
  supporter_name: string;
  creator_name: string;
  creator_email: string;
  message?: string;
  current_date: Date;
  status: "pending" | "approved" | "rejected" | "canceled";
}

interface Withdrawal {
  _id?: ObjectId;
  creator_email: string;
  creator_name: string;
  withdrawal_credit: number;
  withdrawal_amount: number;
  payment_system: string;
  account_number: string;
  withdraw_date: Date;
  status: "pending" | "approved" | "rejected" | "canceled";
}

interface Payment {
  _id?: ObjectId;
  user_email: string;
  user_name: string;
  credits: number;
  amount: number;
  package_label: string;
  stripe_session_id?: string;
  payment_system: string;
  status: "pending" | "completed" | "failed" | "canceled";
  createdAt: Date;
}

interface Notification {
  _id?: ObjectId;
  message: string;
  toEmail: string;
  actionRoute: string;
  time: Date;
  read: boolean;
}

interface Report {
  _id?: ObjectId;
  campaign_id: string;
  campaign_title: string;
  reporter_name: string;
  reporter_email: string;
  reason: string;
  date: Date;
  status: "open" | "resolved" | "suspended";
}

let usersCol: Collection<AppUser>;
let campaignsCol: Collection<Campaign>;
let contributionsCol: Collection<Contribution>;
let withdrawalsCol: Collection<Withdrawal>;
let paymentsCol: Collection<Payment>;
let notificationsCol: Collection<Notification>;
let reportsCol: Collection<Report>;

export let auth: ReturnType<typeof betterAuth> | undefined;

function defaultCredits(role: Role): number {
  return REGISTRATION_CREDITS[role];
}

async function createNotification(payload: Omit<Notification, "_id" | "read" | "time"> & { time?: Date }) {
  await notificationsCol.insertOne({
    message: payload.message,
    toEmail: payload.toEmail,
    actionRoute: payload.actionRoute,
    time: payload.time || new Date(),
    read: false,
  });
}

async function getSessionUser(req: Request): Promise<AppUser | null> {
  if (!auth) return null;
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!session?.user?.email) return null;
  const user = await usersCol.findOne({ email: session.user.email });
  if (!user) return null;
  return { ...user, id: user.id || user._id?.toString() };
}

function requireAuth(roles?: Role[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await getSessionUser(req);
      if (!user) {
        return res.status(401).json({ success: false, message: "Unauthorized. Please log in." });
      }
      if (user.blocked) {
        return res.status(403).json({
          success: false,
          message: user.blockedReason || "Your account has been blocked by Pledgekit administrators.",
          code: "ACCOUNT_BLOCKED",
        });
      }
      if (roles && !roles.includes(user.role)) {
        return res.status(403).json({ success: false, message: "Forbidden for this role." });
      }
      (req as Request & { user: AppUser }).user = user;
      next();
    } catch (error) {
      console.error("Auth middleware error:", error);
      return res.status(401).json({ success: false, message: "Authentication failed." });
    }
  };
}

async function bootstrap() {
  if (!MONGODB_URI) {
    throw new Error("Missing MONGODB_URI in environment variables.");
  }

  client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 5,
  });
  await client.connect();
  db = client.db(MONGODB_DB);
  console.log(`Connected to MongoDB - ${MONGODB_DB}`);
  console.log("Pledgekit API online");

  usersCol = db.collection<AppUser>("user");
  campaignsCol = db.collection<Campaign>("campaigns");
  contributionsCol = db.collection<Contribution>("contributions");
  withdrawalsCol = db.collection<Withdrawal>("withdrawals");
  paymentsCol = db.collection<Payment>("payments");
  notificationsCol = db.collection<Notification>("notifications");
  reportsCol = db.collection<Report>("reports");

  await Promise.all([
    campaignsCol.createIndex({ status: 1, deadline: 1 }),
    campaignsCol.createIndex({ creator_email: 1 }),
    contributionsCol.createIndex({ supporter_email: 1 }),
    contributionsCol.createIndex({ creator_email: 1, status: 1 }),
    withdrawalsCol.createIndex({ creator_email: 1 }),
    notificationsCol.createIndex({ toEmail: 1, time: -1 }),
    usersCol.createIndex({ email: 1 }, { unique: true }),
  ]);

  auth = betterAuth({
    database: mongodbAdapter(db, { client }),
    secret: BETTER_AUTH_SECRET,
    baseURL: BETTER_AUTH_URL,
    trustedOrigins: [CLIENT_URL, BETTER_AUTH_URL, "http://localhost:3000", "http://localhost:5000"],
    advanced: {
      // Client (zeta.vercel.app) and API (blond.vercel.app) are different sites.
      // Without SameSite=None, Google OAuth session cookies never reach /api/me.
      defaultCookieAttributes: {
        sameSite: IS_VERCEL ? "none" : "lax",
        secure: IS_VERCEL ? true : false,
        httpOnly: true,
        path: "/",
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          socialProviders: {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
              // Must match Google Cloud Console → Authorized redirect URIs exactly
              redirectURI: `${BETTER_AUTH_URL}/api/auth/callback/google`,
            },
          },
        }
      : {}),
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: true,
          defaultValue: "supporter",
          input: true,
        },
        credits: {
          type: "number",
          required: true,
          defaultValue: 50,
          input: false,
        },
        raisedCredits: {
          type: "number",
          required: true,
          defaultValue: 0,
          input: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const rawRole = String((user as Record<string, unknown>).role || "supporter");
            const validRole: Role = ["supporter", "creator", "admin"].includes(rawRole)
              ? (rawRole as Role)
              : "supporter";
            const assigned = validRole === "admin" ? "supporter" : validRole;
            return {
              data: {
                ...user,
                role: assigned,
                credits: defaultCredits(assigned),
                raisedCredits: 0,
              },
            };
          },
        },
      },
    },
    plugins: [jwt()],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const app = express();

  app.use(
    cors({
      origin: CLIENT_URL,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  );

  // Block casual browser navigation on protected API routes (Accept: text/html)
  // Always allow Better Auth OAuth callbacks (Google redirects here as a document GET).
  app.use("/api", (req, res, next) => {
    const original = String(req.originalUrl || req.url || "");
    if (original.includes("/api/auth") || req.path.startsWith("/auth")) {
      return next();
    }
    const accept = String(req.headers.accept || "");
    const isBrowserDocument =
      req.method === "GET" &&
      accept.includes("text/html") &&
      !accept.includes("application/json");
    if (isBrowserDocument && req.path !== "/") {
      return res.status(403).json({
        success: false,
        message: "Browser navigation blocked on protected API routes.",
      });
    }
    next();
  });

  app.all("/api/auth/*", toNodeHandler(auth!));

  app.use(express.json({ limit: "2mb" }));

  console.log("Security v2: browser navigation blocked on protected API routes");

  app.get("/", (_req, res) => {
    res.json({
      name: "Fundora API",
      status: "running",
      version: "1.0.0",
      docs: "See README.md for endpoints and setup.",
    });
  });

  app.get("/health", (_req, res) => {
    res.json(healthPayload());
  });

  // ——— Session / profile ———
  app.get("/api/me", requireAuth(), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    res.json({
      success: true,
      user: {
        id: user.id || user._id?.toString(),
        name: user.name,
        email: user.email,
        image: user.image,
        bio: user.bio || "",
        phone: user.phone || "",
        location: user.location || "",
        role: user.role,
        credits: user.credits,
        raisedCredits: user.raisedCredits || 0,
        blocked: Boolean(user.blocked),
        createdAt: user.createdAt || null,
      },
    });
  });

  app.patch("/api/me", requireAuth(), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    const schema = z.object({
      name: z.string().trim().min(2).max(80).optional(),
      image: z.string().url().optional().or(z.literal("")),
      bio: z.string().trim().max(500).optional(),
      phone: z.string().trim().max(30).optional(),
      location: z.string().trim().max(120).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.image !== undefined) updates.image = parsed.data.image || null;
    if (parsed.data.bio !== undefined) updates.bio = parsed.data.bio;
    if (parsed.data.phone !== undefined) updates.phone = parsed.data.phone;
    if (parsed.data.location !== undefined) updates.location = parsed.data.location;

    await usersCol.updateOne({ email: user.email }, { $set: updates });
    const updated = await usersCol.findOne({ email: user.email });
    if (!updated) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    res.json({
      success: true,
      user: {
        id: updated._id?.toString(),
        name: updated.name,
        email: updated.email,
        image: updated.image,
        bio: updated.bio || "",
        phone: updated.phone || "",
        location: updated.location || "",
        role: updated.role,
        credits: updated.credits,
        raisedCredits: updated.raisedCredits || 0,
        blocked: Boolean(updated.blocked),
        createdAt: updated.createdAt || null,
      },
    });
  });

  // ——— Public campaigns ———
  const publicCache = "public, s-maxage=30, stale-while-revalidate=120";

  app.get("/api/campaigns/top", async (_req, res) => {
    const campaigns = await campaignsCol
      .find({ status: "approved" })
      .sort({ amount_raised: -1 })
      .limit(6)
      .toArray();
    res.setHeader("Cache-Control", publicCache);
    res.json({ success: true, campaigns: campaigns.map((c) => ({ ...c, momentum: momentumScore(c.amount_raised, c.funding_goal, c.deadline) })) });
  });

  app.get("/api/campaigns/explore", async (req, res) => {
    const { category, q, minGoal, maxGoal, sort = "deadline" } = req.query;
    const filter: Record<string, unknown> = {
      status: "approved",
      deadline: { $gte: new Date() },
    };
    if (category && typeof category === "string" && category !== "all") {
      filter.category = category;
    }
    if (q && typeof q === "string" && q.trim()) {
      filter.$or = [
        { campaign_title: { $regex: q.trim(), $options: "i" } },
        { campaign_story: { $regex: q.trim(), $options: "i" } },
        { creator_name: { $regex: q.trim(), $options: "i" } },
      ];
    }
    if (minGoal || maxGoal) {
      filter.funding_goal = {};
      if (minGoal) (filter.funding_goal as Record<string, number>).$gte = Number(minGoal);
      if (maxGoal) (filter.funding_goal as Record<string, number>).$lte = Number(maxGoal);
    }

    const sortMap: Record<string, Record<string, 1 | -1>> = {
      deadline: { deadline: 1 },
      raised: { amount_raised: -1 },
      goal: { funding_goal: -1 },
      newest: { createdAt: -1 },
    };

    const campaigns = await campaignsCol
      .find(filter)
      .sort(sortMap[String(sort)] || { deadline: 1 })
      .toArray();
    res.setHeader("Cache-Control", publicCache);
    res.json({ success: true, campaigns: campaigns.map((c) => ({ ...c, momentum: momentumScore(c.amount_raised, c.funding_goal, c.deadline) })) });
  });

  app.get("/api/campaigns/:id", async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid campaign id." });
    }
    const campaign = await campaignsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!campaign) {
      return res.status(404).json({ success: false, message: "Campaign not found." });
    }
    res.setHeader("Cache-Control", publicCache);
    res.json({ success: true, campaign });
  });

  app.get("/api/stats/public", async (_req, res) => {
    const [campaignCount, raisedAgg, supporterCount, creatorCount] = await Promise.all([
      campaignsCol.countDocuments({ status: "approved" }),
      campaignsCol
        .aggregate([{ $match: { status: "approved" } }, { $group: { _id: null, total: { $sum: "$amount_raised" } } }])
        .toArray(),
      usersCol.countDocuments({ role: "supporter" }),
      usersCol.countDocuments({ role: "creator" }),
    ]);
    res.setHeader("Cache-Control", publicCache);
    res.json({
      success: true,
      stats: {
        campaigns: campaignCount,
        creditsRaised: raisedAgg[0]?.total || 0,
        supporters: supporterCount,
        creators: creatorCount,
      },
    });
  });

  // ——— Creator: campaigns ———
  app.post("/api/campaigns", requireAuth(["creator", "admin"]), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    const schema = z.object({
      campaign_title: z.string().min(5),
      campaign_story: z.string().min(20),
      category: z.string().min(2),
      funding_goal: z.number().positive(),
      minimum_contribution: z.number().positive(),
      deadline: z.string().or(z.date()),
      reward_info: z.string().min(5),
      campaign_image_url: z.string().url(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    }
    const data = parsed.data;
    const deadline = new Date(data.deadline);
    if (Number.isNaN(deadline.getTime()) || deadline <= new Date()) {
      return res.status(400).json({ success: false, message: "Deadline must be a future date." });
    }
    if (data.minimum_contribution > data.funding_goal) {
      return res.status(400).json({ success: false, message: "Minimum contribution cannot exceed funding goal." });
    }

    const campaign: Campaign = {
      ...data,
      deadline,
      creator_email: user.email,
      creator_name: user.name,
      amount_raised: 0,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await campaignsCol.insertOne(campaign);
    res.status(201).json({ success: true, campaign: { ...campaign, _id: result.insertedId } });
  });

  app.get("/api/creator/campaigns", requireAuth(["creator", "admin"]), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    const campaigns = await campaignsCol
      .find({ creator_email: user.email })
      .sort({ deadline: -1 })
      .toArray();
    res.json({ success: true, campaigns: campaigns.map((c) => ({ ...c, momentum: momentumScore(c.amount_raised, c.funding_goal, c.deadline) })) });
  });

  app.patch("/api/campaigns/:id", requireAuth(["creator", "admin"]), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid campaign id." });
    }
    const campaign = await campaignsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found." });
    if (campaign.creator_email !== user.email && user.role !== "admin") {
      return res.status(403).json({ success: false, message: "You can only update your own campaigns." });
    }
    const schema = z.object({
      campaign_title: z.string().min(5).optional(),
      campaign_story: z.string().min(20).optional(),
      reward_info: z.string().min(5).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    }
    await campaignsCol.updateOne(
      { _id: campaign._id },
      { $set: { ...parsed.data, updatedAt: new Date() } }
    );
    const updated = await campaignsCol.findOne({ _id: campaign._id });
    res.json({ success: true, campaign: updated });
  });

  app.delete("/api/campaigns/:id", requireAuth(["creator", "admin"]), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid campaign id." });
    }
    const campaign = await campaignsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found." });
    if (campaign.creator_email !== user.email && user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Not allowed." });
    }

    const approved = await contributionsCol.find({ campaign_id: String(campaign._id), status: "approved" }).toArray();
    for (const c of approved) {
      await usersCol.updateOne({ email: c.supporter_email }, { $inc: { credits: c.contribution_amount } });
      await createNotification({
        message: `Your contribution of ${c.contribution_amount} credits to ${campaign.campaign_title} was refunded because the campaign was deleted.`,
        toEmail: c.supporter_email,
        actionRoute: "/dashboard/my-contributions",
      });
    }
    await contributionsCol.deleteMany({ campaign_id: String(campaign._id) });
    await campaignsCol.deleteOne({ _id: campaign._id });
    res.json({ success: true, message: "Campaign deleted and approved contributions refunded." });
  });

  // ——— Creator home ———
  app.get("/api/creator/home", requireAuth(["creator", "admin"]), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    const campaigns = await campaignsCol.find({ creator_email: user.email }).toArray();
    const now = new Date();
    const totalCampaigns = campaigns.length;
    const activeCampaigns = campaigns.filter((c) => c.deadline > now && c.status === "approved").length;
    const totalRaised = campaigns.reduce((sum, c) => sum + (c.amount_raised || 0), 0);
    const pending = await contributionsCol
      .find({ creator_email: user.email, status: "pending" })
      .sort({ current_date: -1 })
      .toArray();
    res.json({
      success: true,
      stats: { totalCampaigns, activeCampaigns, totalRaised },
      pendingContributions: pending,
    });
  });

  app.get("/api/contributions/:id", requireAuth(["creator", "admin", "supporter"]), async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid id." });
    }
    const contribution = await contributionsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!contribution) return res.status(404).json({ success: false, message: "Not found." });
    res.json({ success: true, contribution });
  });

  app.patch("/api/contributions/:id/status", requireAuth(["creator", "admin"]), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    const status = req.body.status as "approved" | "rejected";
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ success: false, message: "Status must be approved or rejected." });
    }
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid id." });
    }
    const contribution = await contributionsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!contribution) return res.status(404).json({ success: false, message: "Contribution not found." });
    if (contribution.creator_email !== user.email && user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Not allowed." });
    }
    if (contribution.status !== "pending") {
      return res.status(400).json({ success: false, message: "Contribution already reviewed." });
    }

    if (status === "approved") {
      await contributionsCol.updateOne({ _id: contribution._id }, { $set: { status: "approved" } });
      await campaignsCol.updateOne(
        { _id: new ObjectId(contribution.campaign_id) },
        { $inc: { amount_raised: contribution.contribution_amount } }
      );
      await usersCol.updateOne(
        { email: contribution.creator_email },
        { $inc: { raisedCredits: contribution.contribution_amount } }
      );
      await createNotification({
        message: `Your contribution of ${contribution.contribution_amount} credits to ${contribution.campaign_title} was approved by ${contribution.creator_name}`,
        toEmail: contribution.supporter_email,
        actionRoute: "/dashboard/supporter-home",
      });
    } else {
      await contributionsCol.updateOne({ _id: contribution._id }, { $set: { status: "rejected" } });
      await usersCol.updateOne(
        { email: contribution.supporter_email },
        { $inc: { credits: contribution.contribution_amount } }
      );
      await createNotification({
        message: `Your contribution of ${contribution.contribution_amount} credits to ${contribution.campaign_title} was rejected by ${contribution.creator_name}. Credits were refunded.`,
        toEmail: contribution.supporter_email,
        actionRoute: "/dashboard/supporter-home",
      });
    }

    res.json({ success: true, message: `Contribution ${status}.` });
  });

  // ——— Supporter contributions ———
  app.post("/api/contributions", requireAuth(["supporter", "admin"]), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    const schema = z.object({
      campaign_id: z.string().min(1),
      contribution_amount: z.number().positive(),
      message: z.string().max(500).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    }
    if (!ObjectId.isValid(parsed.data.campaign_id)) {
      return res.status(400).json({ success: false, message: "Invalid campaign id." });
    }
    const campaign = await campaignsCol.findOne({ _id: new ObjectId(parsed.data.campaign_id) });
    if (!campaign || campaign.status !== "approved" || campaign.deadline < new Date()) {
      return res.status(400).json({ success: false, message: "Campaign is not open for contributions." });
    }
    if (parsed.data.contribution_amount < campaign.minimum_contribution) {
      return res.status(400).json({
        success: false,
        message: `Minimum contribution is ${campaign.minimum_contribution} credits.`,
      });
    }
    const freshUser = await usersCol.findOne({ email: user.email });
    if (!freshUser || freshUser.credits < parsed.data.contribution_amount) {
      return res.status(400).json({ success: false, message: "Insufficient credits." });
    }

    await usersCol.updateOne({ email: user.email }, { $inc: { credits: -parsed.data.contribution_amount } });

    const contribution: Contribution = {
      campaign_id: String(campaign._id),
      campaign_title: campaign.campaign_title,
      contribution_amount: parsed.data.contribution_amount,
      supporter_email: user.email,
      supporter_name: user.name,
      creator_name: campaign.creator_name,
      creator_email: campaign.creator_email,
      message: parsed.data.message || "",
      current_date: new Date(),
      status: "pending",
    };
    const result = await contributionsCol.insertOne(contribution);

    await createNotification({
      message: `${user.name} contributed ${parsed.data.contribution_amount} credits to ${campaign.campaign_title}. Review it in your dashboard.`,
      toEmail: campaign.creator_email,
      actionRoute: "/dashboard/creator-home",
    });

    res.status(201).json({ success: true, contribution: { ...contribution, _id: result.insertedId } });
  });

  app.get("/api/supporter/home", requireAuth(["supporter", "admin"]), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    const contributions = await contributionsCol.find({ supporter_email: user.email }).toArray();
    const totalContributions = contributions.length;
    const pendingContributions = contributions.filter((c) => c.status === "pending").length;
    const totalAmount = contributions
      .filter((c) => c.status === "approved")
      .reduce((sum, c) => sum + c.contribution_amount, 0);
    const approved = contributions.filter((c) => c.status === "approved");
    res.json({
      success: true,
      stats: { totalContributions, pendingContributions, totalAmount },
      approvedContributions: approved,
    });
  });

  app.get("/api/supporter/contributions", requireAuth(["supporter", "admin"]), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const filter = { supporter_email: user.email };
    const total = await contributionsCol.countDocuments(filter);
    const contributions = await contributionsCol
      .find(filter)
      .sort({ current_date: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();
    res.json({
      success: true,
      contributions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    });
  });

  // ——— Withdrawals ———
  app.get("/api/creator/withdrawals/summary", requireAuth(["creator", "admin"]), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    const fresh = await usersCol.findOne({ email: user.email });
    const raisedCredits = fresh?.raisedCredits || 0;
    res.json({
      success: true,
      raisedCredits,
      withdrawableDollars: raisedCredits / WITHDRAW_CREDITS_PER_DOLLAR,
      canWithdraw: raisedCredits >= MIN_WITHDRAWAL_CREDITS,
    });
  });

  app.post("/api/withdrawals", requireAuth(["creator", "admin"]), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    const schema = z.object({
      withdrawal_credit: z.number().positive(),
      payment_system: z.string().min(2),
      account_number: z.string().min(4),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    }
    const fresh = await usersCol.findOne({ email: user.email });
    const raisedCredits = fresh?.raisedCredits || 0;
    if (raisedCredits < MIN_WITHDRAWAL_CREDITS) {
      return res.status(400).json({ success: false, message: `Minimum ${MIN_WITHDRAWAL_CREDITS} credits required to withdraw.` });
    }
    if (parsed.data.withdrawal_credit > raisedCredits) {
      return res.status(400).json({ success: false, message: "Insufficient raised credits." });
    }
    if (parsed.data.withdrawal_credit < MIN_WITHDRAWAL_CREDITS) {
      return res.status(400).json({ success: false, message: `Minimum withdrawal is ${MIN_WITHDRAWAL_CREDITS} credits.` });
    }

    const withdrawal: Withdrawal = {
      creator_email: user.email,
      creator_name: user.name,
      withdrawal_credit: parsed.data.withdrawal_credit,
      withdrawal_amount: parsed.data.withdrawal_credit / WITHDRAW_CREDITS_PER_DOLLAR,
      payment_system: parsed.data.payment_system,
      account_number: parsed.data.account_number,
      withdraw_date: new Date(),
      status: "pending",
    };
    const result = await withdrawalsCol.insertOne(withdrawal);
    res.status(201).json({ success: true, withdrawal: { ...withdrawal, _id: result.insertedId } });
  });

  app.get("/api/creator/payment-history", requireAuth(["creator", "admin"]), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    const withdrawals = await withdrawalsCol
      .find({ creator_email: user.email })
      .sort({ withdraw_date: -1 })
      .toArray();
    res.json({ success: true, withdrawals });
  });

  // ——— Payments (credits) ———
  app.post("/api/payments/create-checkout", requireAuth(["supporter", "admin"]), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    const packageKey = String(req.body.packageKey || "") as keyof typeof CREDIT_PACKAGES;
    const pkg = CREDIT_PACKAGES[packageKey];
    if (!pkg) {
      return res.status(400).json({ success: false, message: "Invalid credit package." });
    }

    if (!stripe) {
      // Dummy payment fallback when Stripe is not configured
      await usersCol.updateOne({ email: user.email }, { $inc: { credits: pkg.credits } });
      const payment: Payment = {
        user_email: user.email,
        user_name: user.name,
        credits: pkg.credits,
        amount: pkg.price,
        package_label: pkg.label,
        payment_system: "dummy",
        status: "completed",
        createdAt: new Date(),
      };
      const result = await paymentsCol.insertOne(payment);
      return res.json({
        success: true,
        mode: "dummy",
        message: "Credits added (Stripe not configured).",
        payment: { ...payment, _id: result.insertedId },
      });
    }

    const payment: Payment = {
      user_email: user.email,
      user_name: user.name,
      credits: pkg.credits,
      amount: pkg.price,
      package_label: pkg.label,
      payment_system: "stripe",
      status: "pending",
      createdAt: new Date(),
    };
    const insert = await paymentsCol.insertOne(payment);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: user.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: pkg.price * 100,
            product_data: {
              name: `Fundora ${pkg.label}`,
              description: `Purchase ${pkg.credits} platform credits`,
            },
          },
        },
      ],
      success_url: `${CLIENT_URL}/dashboard/payment-history?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CLIENT_URL}/dashboard/purchase-credit?canceled=1`,
      metadata: {
        paymentId: String(insert.insertedId),
        userEmail: user.email,
        credits: String(pkg.credits),
      },
    });

    await paymentsCol.updateOne(
      { _id: insert.insertedId },
      { $set: { stripe_session_id: session.id } }
    );

    res.json({ success: true, mode: "stripe", url: session.url, sessionId: session.id });
  });

  app.post("/api/payments/confirm", requireAuth(["supporter", "admin"]), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    const sessionId = String(req.body.sessionId || "");
    if (!sessionId) {
      return res.status(400).json({ success: false, message: "sessionId required." });
    }

    const payment = await paymentsCol.findOne({ stripe_session_id: sessionId, user_email: user.email });
    if (!payment) {
      return res.status(404).json({ success: false, message: "Payment not found." });
    }
    if (payment.status === "completed") {
      return res.json({ success: true, message: "Already processed.", payment });
    }

    if (stripe) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status !== "paid") {
        return res.status(400).json({ success: false, message: "Payment not completed." });
      }
    }

    await paymentsCol.updateOne({ _id: payment._id }, { $set: { status: "completed" } });
    await usersCol.updateOne({ email: user.email }, { $inc: { credits: payment.credits } });
    res.json({ success: true, message: "Credits added.", credits: payment.credits });
  });

  app.get("/api/supporter/payment-history", requireAuth(["supporter", "admin"]), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    const payments = await paymentsCol
      .find({ user_email: user.email })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ success: true, payments });
  });

  // Cancel pending credit purchase (supporter) or admin override
  app.patch("/api/payments/:id/cancel", requireAuth(["supporter", "admin"]), async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid payment id." });
    }
    const user = (req as Request & { user: AppUser }).user;
    const payment = await paymentsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!payment) return res.status(404).json({ success: false, message: "Payment not found." });
    if (user.role !== "admin" && payment.user_email !== user.email) {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }
    if (payment.status !== "pending") {
      return res.status(400).json({ success: false, message: "Only pending payments can be canceled." });
    }
    await paymentsCol.updateOne({ _id: payment._id }, { $set: { status: "canceled" } });
    res.json({ success: true, message: "Payment canceled." });
  });

  // Admin payment control center
  app.get("/api/admin/payments", requireAuth(["admin"]), async (_req, res) => {
    const payments = await paymentsCol.find({}).sort({ createdAt: -1 }).limit(200).toArray();
    res.json({ success: true, payments });
  });

  app.patch("/api/admin/payments/:id/status", requireAuth(["admin"]), async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid payment id." });
    }
    const status = req.body.status as "completed" | "canceled" | "failed";
    if (!["completed", "canceled", "failed"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status." });
    }
    const payment = await paymentsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!payment) return res.status(404).json({ success: false, message: "Payment not found." });

    if (status === "completed" && payment.status !== "completed") {
      await paymentsCol.updateOne({ _id: payment._id }, { $set: { status: "completed" } });
      await usersCol.updateOne({ email: payment.user_email }, { $inc: { credits: payment.credits } });
      await createNotification({
        message: `Admin confirmed your purchase of ${payment.credits} credits.`,
        toEmail: payment.user_email,
        actionRoute: "/dashboard/payment-history",
      });
    } else if ((status === "canceled" || status === "failed") && payment.status === "pending") {
      await paymentsCol.updateOne({ _id: payment._id }, { $set: { status } });
    } else if ((status === "canceled" || status === "failed") && payment.status === "completed") {
      // Reverse completed payment: claw back credits if possible
      const holder = await usersCol.findOne({ email: payment.user_email });
      if (!holder || (holder.credits || 0) < payment.credits) {
        return res.status(400).json({
          success: false,
          message: "Cannot reverse: user no longer has enough credits.",
        });
      }
      await usersCol.updateOne({ email: payment.user_email }, { $inc: { credits: -payment.credits } });
      await paymentsCol.updateOne({ _id: payment._id }, { $set: { status } });
      await createNotification({
        message: `Admin reversed your purchase of ${payment.credits} credits (${status}).`,
        toEmail: payment.user_email,
        actionRoute: "/dashboard/payment-history",
      });
    } else {
      return res.status(400).json({ success: false, message: `Cannot change ${payment.status} to ${status}.` });
    }

    const updated = await paymentsCol.findOne({ _id: payment._id });
    res.json({ success: true, payment: updated });
  });

  // Creator cancels pending withdrawal
  app.patch("/api/withdrawals/:id/cancel", requireAuth(["creator", "admin"]), async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid withdrawal id." });
    }
    const user = (req as Request & { user: AppUser }).user;
    const withdrawal = await withdrawalsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!withdrawal) return res.status(404).json({ success: false, message: "Withdrawal not found." });
    if (user.role !== "admin" && withdrawal.creator_email !== user.email) {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }
    if (withdrawal.status !== "pending") {
      return res.status(400).json({ success: false, message: "Only pending withdrawals can be canceled." });
    }
    await withdrawalsCol.updateOne({ _id: withdrawal._id }, { $set: { status: "canceled" } });
    res.json({ success: true, message: "Withdrawal canceled." });
  });

  // Admin reject withdrawal
  app.patch("/api/admin/withdrawals/:id/reject", requireAuth(["admin"]), async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid id." });
    }
    const withdrawal = await withdrawalsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!withdrawal || withdrawal.status !== "pending") {
      return res.status(400).json({ success: false, message: "Pending withdrawal not found." });
    }
    await withdrawalsCol.updateOne({ _id: withdrawal._id }, { $set: { status: "rejected" } });
    await createNotification({
      message: `Your withdrawal of ${withdrawal.withdrawal_credit} credits was rejected by Admin.`,
      toEmail: withdrawal.creator_email,
      actionRoute: "/dashboard/payment-history",
    });
    res.json({ success: true, message: "Withdrawal rejected." });
  });

  // Supporter cancels pending contribution
  app.patch("/api/contributions/:id/cancel", requireAuth(["supporter", "admin"]), async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid contribution id." });
    }
    const user = (req as Request & { user: AppUser }).user;
    const contribution = await contributionsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!contribution) return res.status(404).json({ success: false, message: "Contribution not found." });
    if (user.role !== "admin" && contribution.supporter_email !== user.email) {
      return res.status(403).json({ success: false, message: "Forbidden." });
    }
    if (contribution.status !== "pending") {
      return res.status(400).json({ success: false, message: "Only pending contributions can be canceled." });
    }
    await contributionsCol.updateOne({ _id: contribution._id }, { $set: { status: "canceled" } });
    await usersCol.updateOne(
      { email: contribution.supporter_email },
      { $inc: { credits: contribution.contribution_amount } }
    );
    await createNotification({
      message: `${contribution.supporter_name} canceled a pending contribution to ${contribution.campaign_title}.`,
      toEmail: contribution.creator_email,
      actionRoute: "/dashboard/creator-home",
    });
    res.json({ success: true, message: "Contribution canceled and credits refunded." });
  });

  // ——— Admin ———
  app.get("/api/admin/home", requireAuth(["admin"]), async (_req, res) => {
    const [supporters, creators, creditsAgg, paymentsProcessed] = await Promise.all([
      usersCol.countDocuments({ role: "supporter" }),
      usersCol.countDocuments({ role: "creator" }),
      usersCol.aggregate([{ $group: { _id: null, total: { $sum: "$credits" } } }]).toArray(),
      paymentsCol.countDocuments({ status: "completed" }),
    ]);
    const pendingCampaigns = await campaignsCol.find({ status: "pending" }).sort({ createdAt: -1 }).toArray();
    res.json({
      success: true,
      stats: {
        totalSupporters: supporters,
        totalCreators: creators,
        totalAvailableCredits: creditsAgg[0]?.total || 0,
        totalPaymentsProcessed: paymentsProcessed,
      },
      pendingCampaigns,
    });
  });

  app.patch("/api/admin/campaigns/:id/status", requireAuth(["admin"]), async (req, res) => {
    const status = req.body.status as "approved" | "rejected" | "suspended" | "pending";
    if (!["approved", "rejected", "suspended", "pending"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status." });
    }
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid id." });
    }
    const campaign = await campaignsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!campaign) return res.status(404).json({ success: false, message: "Not found." });
    await campaignsCol.updateOne({ _id: campaign._id }, { $set: { status, updatedAt: new Date() } });
    const messages: Record<string, string> = {
      approved: `Your campaign "${campaign.campaign_title}" was approved by Admin and is now live.`,
      rejected: `Your campaign "${campaign.campaign_title}" was rejected by Admin.`,
      suspended: `Your campaign "${campaign.campaign_title}" was suspended by Admin.`,
      pending: `Your campaign "${campaign.campaign_title}" was moved back to pending review.`,
    };
    await createNotification({
      message: messages[status],
      toEmail: campaign.creator_email,
      actionRoute: "/dashboard/my-campaigns",
    });
    res.json({ success: true, message: `Campaign ${status}.` });
  });

  app.patch("/api/admin/campaigns/:id", requireAuth(["admin"]), async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid id." });
    }
    const schema = z.object({
      campaign_title: z.string().min(3).max(120).optional(),
      campaign_story: z.string().min(20).optional(),
      category: z.string().min(2).optional(),
      funding_goal: z.number().positive().optional(),
      minimum_contribution: z.number().positive().optional(),
      reward_info: z.string().min(2).optional(),
      deadline: z.string().datetime().or(z.string().min(8)).optional(),
      status: z.enum(["pending", "approved", "rejected", "suspended"]).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    }
    const campaign = await campaignsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!campaign) return res.status(404).json({ success: false, message: "Not found." });

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value === undefined) continue;
      updates[key] = key === "deadline" ? new Date(String(value)) : value;
    }
    await campaignsCol.updateOne({ _id: campaign._id }, { $set: updates });
    const updated = await campaignsCol.findOne({ _id: campaign._id });
    res.json({ success: true, campaign: updated });
  });

  app.get("/api/admin/withdrawals", requireAuth(["admin"]), async (_req, res) => {
    const withdrawals = await withdrawalsCol.find({ status: "pending" }).sort({ withdraw_date: -1 }).toArray();
    res.json({ success: true, withdrawals });
  });

  app.patch("/api/admin/withdrawals/:id/approve", requireAuth(["admin"]), async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid id." });
    }
    const withdrawal = await withdrawalsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!withdrawal || withdrawal.status !== "pending") {
      return res.status(404).json({ success: false, message: "Pending withdrawal not found." });
    }
    const creator = await usersCol.findOne({ email: withdrawal.creator_email });
    if (!creator || (creator.raisedCredits || 0) < withdrawal.withdrawal_credit) {
      return res.status(400).json({ success: false, message: "Creator does not have enough raised credits." });
    }
    await withdrawalsCol.updateOne({ _id: withdrawal._id }, { $set: { status: "approved" } });
    await usersCol.updateOne(
      { email: withdrawal.creator_email },
      { $inc: { raisedCredits: -withdrawal.withdrawal_credit } }
    );
    await createNotification({
      message: `Your withdrawal of ${withdrawal.withdrawal_credit} credits ($${withdrawal.withdrawal_amount}) was approved by Admin.`,
      toEmail: withdrawal.creator_email,
      actionRoute: "/dashboard/payment-history",
    });
    res.json({ success: true, message: "Withdrawal marked as payment success." });
  });

  app.get("/api/admin/users", requireAuth(["admin"]), async (_req, res) => {
    const users = await usersCol
      .find(
        {},
        {
          projection: {
            name: 1,
            email: 1,
            image: 1,
            role: 1,
            credits: 1,
            raisedCredits: 1,
            createdAt: 1,
            blocked: 1,
            blockedReason: 1,
            blockedAt: 1,
          },
        }
      )
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ success: true, users });
  });

  app.patch("/api/admin/users/:email/block", requireAuth(["admin"]), async (req, res) => {
    const email = decodeURIComponent(req.params.email);
    if (email === process.env.ADMIN_EMAIL) {
      return res.status(400).json({ success: false, message: "Cannot block the primary admin." });
    }
    const blocked = Boolean(req.body.blocked);
    const blockedReason = String(req.body.reason || "").trim();
    if (blocked && blockedReason.length < 5) {
      return res.status(400).json({ success: false, message: "Provide a clear reason (min 5 characters)." });
    }
    const result = await usersCol.updateOne(
      { email },
      {
        $set: {
          blocked,
          blockedReason: blocked ? blockedReason : "",
          blockedAt: blocked ? new Date() : null,
          updatedAt: new Date(),
        },
      }
    );
    if (!result.matchedCount) return res.status(404).json({ success: false, message: "User not found." });
    await createNotification({
      message: blocked
        ? `Your Pledgekit account was blocked. Reason: ${blockedReason}`
        : "Your Pledgekit account has been unblocked. You can use the platform again.",
      toEmail: email,
      actionRoute: "/dashboard",
    });
    res.json({ success: true, message: blocked ? "User blocked." : "User unblocked." });
  });

  app.patch("/api/admin/users/:email/role", requireAuth(["admin"]), async (req, res) => {
    const role = req.body.role as Role;
    if (!["supporter", "creator", "admin"].includes(role)) {
      return res.status(400).json({ success: false, message: "Invalid role." });
    }
    const email = decodeURIComponent(req.params.email);
    const result = await usersCol.updateOne({ email }, { $set: { role, updatedAt: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ success: false, message: "User not found." });
    res.json({ success: true, message: "Role updated." });
  });

  app.delete("/api/admin/users/:email", requireAuth(["admin"]), async (req, res) => {
    const email = decodeURIComponent(req.params.email);
    if (email === process.env.ADMIN_EMAIL) {
      return res.status(400).json({ success: false, message: "Cannot delete primary admin." });
    }
    const result = await usersCol.deleteOne({ email });
    if (!result.deletedCount) return res.status(404).json({ success: false, message: "User not found." });
    res.json({ success: true, message: "User removed." });
  });

  app.get("/api/admin/campaigns", requireAuth(["admin"]), async (_req, res) => {
    const campaigns = await campaignsCol.find({}).sort({ createdAt: -1 }).toArray();
    res.json({ success: true, campaigns: campaigns.map((c) => ({ ...c, momentum: momentumScore(c.amount_raised, c.funding_goal, c.deadline) })) });
  });

  app.delete("/api/admin/campaigns/:id", requireAuth(["admin"]), async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid id." });
    }
    await contributionsCol.deleteMany({ campaign_id: req.params.id });
    const result = await campaignsCol.deleteOne({ _id: new ObjectId(req.params.id) });
    if (!result.deletedCount) return res.status(404).json({ success: false, message: "Not found." });
    res.json({ success: true, message: "Campaign deleted." });
  });

  // ——— Reports ———
  app.post("/api/reports", requireAuth(["supporter", "creator", "admin"]), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    const schema = z.object({
      campaign_id: z.string(),
      reason: z.string().min(10),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: parsed.error.errors[0].message });
    }
    if (!ObjectId.isValid(parsed.data.campaign_id)) {
      return res.status(400).json({ success: false, message: "Invalid campaign id." });
    }
    const campaign = await campaignsCol.findOne({ _id: new ObjectId(parsed.data.campaign_id) });
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found." });

    const report: Report = {
      campaign_id: String(campaign._id),
      campaign_title: campaign.campaign_title,
      reporter_name: user.name,
      reporter_email: user.email,
      reason: parsed.data.reason,
      date: new Date(),
      status: "open",
    };
    const result = await reportsCol.insertOne(report);
    res.status(201).json({ success: true, report: { ...report, _id: result.insertedId } });
  });

  app.get("/api/admin/reports", requireAuth(["admin"]), async (_req, res) => {
    const reports = await reportsCol.find({}).sort({ date: -1 }).toArray();
    res.json({ success: true, reports });
  });

  app.patch("/api/admin/reports/:id", requireAuth(["admin"]), async (req, res) => {
    const action = req.body.action as "suspend" | "delete" | "resolve";
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid id." });
    }
    const report = await reportsCol.findOne({ _id: new ObjectId(req.params.id) });
    if (!report) return res.status(404).json({ success: false, message: "Report not found." });

    if (action === "suspend") {
      await campaignsCol.updateOne(
        { _id: new ObjectId(report.campaign_id) },
        { $set: { status: "suspended", updatedAt: new Date() } }
      );
      await reportsCol.updateOne({ _id: report._id }, { $set: { status: "suspended" } });
    } else if (action === "delete") {
      await campaignsCol.deleteOne({ _id: new ObjectId(report.campaign_id) });
      await contributionsCol.deleteMany({ campaign_id: report.campaign_id });
      await reportsCol.updateOne({ _id: report._id }, { $set: { status: "resolved" } });
    } else {
      await reportsCol.updateOne({ _id: report._id }, { $set: { status: "resolved" } });
    }
    res.json({ success: true, message: `Report ${action}d.` });
  });

  // ——— Notifications ———
  app.get("/api/notifications", requireAuth(), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    const notifications = await notificationsCol
      .find({ toEmail: user.email })
      .sort({ time: -1 })
      .limit(50)
      .toArray();
    res.json({ success: true, notifications });
  });

  app.patch("/api/notifications/read-all", requireAuth(), async (req, res) => {
    const user = (req as Request & { user: AppUser }).user;
    await notificationsCol.updateMany({ toEmail: user.email, read: false }, { $set: { read: true } });
    res.json({ success: true });
  });

  // ——— Unique: trending categories ———
  app.get("/api/insights/categories", async (_req, res) => {
    const data = await campaignsCol
      .aggregate([
        { $match: { status: "approved" } },
        {
          $group: {
            _id: "$category",
            campaigns: { $sum: 1 },
            raised: { $sum: "$amount_raised" },
          },
        },
        { $sort: { raised: -1 } },
        { $limit: 8 },
      ])
      .toArray();
    res.json({ success: true, categories: data });
  });

  // ——— Unique: impact ledger (platform fee transparency) ———
  app.get("/api/insights/impact", async (_req, res) => {
    const [raised, withdrawn, purchased] = await Promise.all([
      campaignsCol
        .aggregate([{ $group: { _id: null, total: { $sum: "$amount_raised" } } }])
        .toArray(),
      withdrawalsCol
        .aggregate([
          { $match: { status: "approved" } },
          { $group: { _id: null, credits: { $sum: "$withdrawal_credit" }, dollars: { $sum: "$withdrawal_amount" } } },
        ])
        .toArray(),
      paymentsCol
        .aggregate([
          { $match: { status: "completed" } },
          { $group: { _id: null, credits: { $sum: "$credits" }, dollars: { $sum: "$amount" } } },
        ])
        .toArray(),
    ]);
    res.json({
      success: true,
      impact: {
        creditsRaisedOnCampaigns: raised[0]?.total || 0,
        creditsWithdrawn: withdrawn[0]?.credits || 0,
        dollarsPaidToCreators: withdrawn[0]?.dollars || 0,
        creditsPurchased: purchased[0]?.credits || 0,
        dollarsFromSupporters: purchased[0]?.dollars || 0,
        platformSpreadNote: "Supporters buy 10 credits/$1; creators withdraw 20 credits/$1.",
      },
    });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ success: false, message: "Internal server error." });
  });

  if (!IS_VERCEL) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Pledgekit server running on port ${PORT}`);
    });
  }

  return app;
}

type ExpressApp = Awaited<ReturnType<typeof bootstrap>>;
let bootPromise: Promise<ExpressApp> | null = null;

function ensureApp() {
  if (!bootPromise) {
    bootPromise = bootstrap().catch((err) => {
      bootPromise = null;
      throw err;
    });
  }
  return bootPromise;
}

async function handler(req: any, res: any) {
  try {
    const app = await ensureApp();
    return app(req, res);
  } catch (err) {
    console.error("Bootstrap failed:", err);
    const message = err instanceof Error ? err.message : "Failed to start API";
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: false, message, code: "BOOTSTRAP_FAILED" }));
  }
}

export default handler;

if (!IS_VERCEL) {
  ensureApp().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
