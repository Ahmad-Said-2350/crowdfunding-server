# Fundora API

Express + TypeScript backend for the **Fundora** crowdfunding platform.

## Live / repository

- Server live API: `https://crowdfunding-server.vercel.app` *(update after deploy)*
- Server GitHub: https://github.com/Ahmad-Said-2350/crowdfunding-server
- Client GitHub: https://github.com/Ahmad-Said-2350/crowdfunding-client

## Admin credentials

- Email: `admin@fundora.app`
- Password: `Admin@Fundora2026`

## Features

- Better Auth (email/password + optional Google) with MongoDB adapter and JWT plugin
- Role middleware for supporter, creator, and admin routes
- Campaign CRUD with pending admin approval gate
- Contribution approve/reject with credit transfer and refunds
- Stripe checkout for credit packages with dummy payment fallback
- Creator withdrawals (20 credits = $1, minimum 200 credits)
- Notifications collection for contribution, campaign, and withdrawal events
- Reports workflow for suspicious campaigns
- Public explore filters plus category and impact insight endpoints
- Environment-variable based MongoDB Atlas SRV and Stripe secrets
- Seed script for primary admin account

## Local setup

1. Copy `.env.example` to `.env` and set `MONGODB_URI` (Atlas SRV), `BETTER_AUTH_SECRET`, `CLIENT_URL`.
2. `npm install`
3. `npm run seed`
4. `npm run dev` → http://localhost:5000

## Scripts

- `npm run dev` — TypeScript watch server
- `npm run build` — compile to `dist/`
- `npm start` — run compiled server
- `npm run seed` — create/ensure admin user

## Business rules

- Supporters receive **50 credits** on registration; Creators receive **20 credits**.
- Purchase rate: **10 credits = $1**.
- Withdrawal rate: **20 credits = $1** (minimum **200 credits / $10**).
- Contributions start as `pending` until the Creator approves or rejects them.
- Campaigns are visible to Supporters only after Admin approval.
