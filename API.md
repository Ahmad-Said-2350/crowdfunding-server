## Fundora API map

### Auth
- `POST /api/auth/*` — Better Auth handler (sign-up, sign-in, Google, JWT)

### Public
- `GET /` health banner
- `GET /health`
- `GET /api/campaigns/top`
- `GET /api/campaigns/explore`
- `GET /api/campaigns/:id`
- `GET /api/stats/public`
- `GET /api/insights/categories`
- `GET /api/insights/impact`

### Authenticated
- `GET|PATCH /api/me`
- `GET /api/notifications`
- `PATCH /api/notifications/read-all`

### Supporter
- `POST /api/contributions`
- `GET /api/supporter/home`
- `GET /api/supporter/contributions`
- `POST /api/payments/create-checkout`
- `POST /api/payments/confirm`
- `GET /api/supporter/payment-history`
- `POST /api/reports`

### Creator
- `POST /api/campaigns`
- `GET /api/creator/campaigns`
- `PATCH|DELETE /api/campaigns/:id`
- `GET /api/creator/home`
- `PATCH /api/contributions/:id/status`
- `GET /api/creator/withdrawals/summary`
- `POST /api/withdrawals`
- `GET /api/creator/payment-history`

### Admin
- `GET /api/admin/home`
- `PATCH /api/admin/campaigns/:id/status`
- `GET /api/admin/withdrawals`
- `PATCH /api/admin/withdrawals/:id/approve`
- `GET /api/admin/users`
- `PATCH /api/admin/users/:email/role`
- `DELETE /api/admin/users/:email`
- `GET /api/admin/campaigns`
- `DELETE /api/admin/campaigns/:id`
- `GET /api/admin/reports`
- `PATCH /api/admin/reports/:id`
