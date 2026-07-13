# Deployment notes

## Vercel (server)

1. Import `Ahmad-Said-2350/crowdfunding-server`.
2. Set Root Directory to repository root.
3. Add environment variables from `.env.example`.
4. Build command: `npm run build`
5. Output: `dist` (or use `vercel.json` with `@vercel/node` on `index.ts`).
6. Bind to `0.0.0.0:$PORT` (already configured).

## MongoDB Atlas

Use an SRV connection string (`mongodb+srv://...`) and whitelist Vercel egress IPs or `0.0.0.0/0` for development.
