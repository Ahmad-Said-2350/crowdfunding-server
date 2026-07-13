# Pledgekit API

Express + TypeScript backend for **Pledgekit** crowdfunding.

## Live links

- API: https://crowdfunding-server-blond.vercel.app
- Client: https://crowdfunding-client-zeta.vercel.app
- Server GitHub: https://github.com/Ahmad-Said-2350/crowdfunding-server
- Client GitHub: https://github.com/Ahmad-Said-2350/crowdfunding-client

## Admin credentials

- Email: `admin@fundora.app`
- Password: `Admin@Fundora2026`

## Local setup

1. Copy `.env.example` ? `.env` (MongoDB Atlas URI must include `/fundora` or set `MONGODB_DB=fundora`)
2. `npm install`
3. `npm run seed`
4. `npm run dev` ? nodemon on port 5000

## Google OAuth (production)

Authorized redirect URI:
`https://crowdfunding-server-blond.vercel.app/api/auth/callback/google`

## Business rules

- Registration credits: Supporter 50 / Creator 20
- Purchase: 10 credits = $1
- Withdraw: 20 credits = $1 (min 200)
