# Pledgekit API

Express + TypeScript backend for **Pledgekit** crowdfunding.

## Admin credentials

- Email: `admin@fundora.app`
- Password: `Admin@Fundora2026`

## Local setup

1. Copy `.env.example` → `.env` (MongoDB Atlas URI must include `/fundora` or set `MONGODB_DB=fundora`)
2. `npm install`
3. `npm run seed`
4. `npm run dev` → nodemon on port 5000

## Notable admin APIs

- `PATCH /api/admin/users/:email/block` — `{ blocked: true|false, reason?: string }`
- Role update, user remove, campaign moderation, withdrawal approval, reports

## Business rules

- Registration credits: Supporter 50 / Creator 20
- Purchase: 10 credits = $1
- Withdraw: 20 credits = $1 (min 200)
