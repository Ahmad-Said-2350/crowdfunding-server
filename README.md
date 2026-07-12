# Fundora API

Express + TypeScript backend for the Fundora crowdfunding platform.

## Stack

- Node.js + Express + TypeScript
- MongoDB Atlas (native driver + Better Auth MongoDB adapter)
- Better Auth (email/password + Google) with JWT plugin
- Stripe for credit purchases and withdrawals
- Zod validation

## Local setup

1. Copy `.env.example` to `.env` and fill in MongoDB Atlas SRV URI and secrets.
2. `npm install`
3. `npm run seed` (creates admin user)
4. `npm run dev` → http://localhost:5000

## Admin credentials

- Email: `admin@fundora.app`
- Password: `Admin@Fundora2026`

## Scripts

- `npm run dev` — development server with hot reload
- `npm run build` — compile TypeScript
- `npm start` — run production build
- `npm run seed` — seed admin account

## Business rules

- Supporters receive **50 credits** on registration; Creators receive **20 credits**.
- Supporters purchase credits at **10 credits = $1**.
- Creators withdraw at **20 credits = $1** (minimum **200 credits / $10**).
- Campaigns require Admin approval before appearing to Supporters.
- Contributions start as `pending` until the Creator approves or rejects them.
