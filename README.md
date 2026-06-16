# WhatsApp Sender Platform

منصة إرسال رسائل واتساب جماعية مع نظام اشتراكات، لوحة تحكم ثنائية اللغة، وحماية من الحظر.

## Features

- **Multi-device WhatsApp** – each user gets their own WhatsApp session
- **Subscription management** – per-user quotas, expiry dates, API keys
- **Bulk sending** – send thousands of messages with anti-ban delays
- **Admin dashboard** – manage users, sessions, messages (Arabic/English)
- **REST API** – for developers to integrate programmatically
- **Real-time** – Socket.IO for live QR code scanning and message status
- **Anti-ban** – rate limiting, spam detection, smart delays

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Edit .env file (optional – defaults work out of the box)
#    JWT_SECRET=change-this-secret
#    ADMIN_EMAIL=admin@whatsapp.com
#    ADMIN_PASSWORD=Admin@123456

# 3. Start the platform
node src/index.js
```

Open **http://localhost:3000/admin** and login with:
- Email: `admin@whatsapp.com`
- Password: `Admin@123456`

## Architecture

```
src/
  index.js          – Main server (port 3000), Express + Socket.IO
  routes/
    api.js          – Internal REST API (JWT auth)
    external.js     – Customer API (API-Key auth, quota enforcement)
    admin.js        – Admin CRUD endpoints
    webhook.js      – Webhook events
  services/
    whatsapp.js     – WhatsApp multi-session manager
    auth.js         – JWT + bcrypt auth
  models/
    user.js         – Users with API keys, quotas, subscriptions
    session.js      – WhatsApp sessions per user
    message.js      – Message queue and history
  queue/
    sender.js       – BullMQ queue (falls back to direct send)
  middleware/
    auth.js         – JWT + API key + admin auth middleware
  utils/
    protection.js   – Rate limiter, anti-ban delays, spam detection
  database/
    db.js           – JSON file database (zero dependencies)
admin/
  index.html        – Modern admin dashboard (Tailwind CSS, bilingual)
  login.html        – Admin login page
```


## API Usage

### Authentication (API Key)

```bash
curl -X POST http://localhost:3000/v1/send \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":"966501234567","message":"Hello from API","sessionId":"SESSION_ID"}'
```

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/send` | Send a single message |
| POST | `/v1/send-bulk` | Send up to 500 messages |
| GET | `/v1/balance` | Check quota & subscription status |
| GET | `/v1/sessions` | List your sessions |
| POST | `/v1/sessions` | Create a new session |
| DELETE | `/v1/sessions/:id` | Delete a session |

### Response

```json
{
  "messageId": "uuid",
  "status": "queued",
  "estimatedDelay": 8
}
```

## Admin Dashboard

The admin dashboard at **`/admin`** includes:

| Section | Features |
|---------|----------|
| Dashboard | Stats cards, quick links, recent activity |
| Users | CRUD, search, pagination, usage progress bars |
| Sessions | View all WhatsApp sessions across users |
| Messages | View all messages and their delivery status |
| Settings | Server status, API base URL |
| WhatsApp Web | Create/manage sessions, scan QR codes, send test messages |

**Language toggle** – switch between العربية and English at the top of the dashboard.

## Selling Points

1. **Ready to sell** – complete subscription SaaS with user management
2. **No monthly fees** – self-hosted, one-time setup
3. **Anti-ban technology** – smart delays, rate limits, spam detection
4. **Dual interface** – simple WhatsApp sender + full admin dashboard
5. **API-first** – developers can integrate with any language
6. **Bilingual** – Arabic and English UI out of the box
7. **No build tools** – pure Node.js, runs on any Windows/Linux server

## Production Deployment

For production:

1. Install **Redis** for the message queue:
   ```bash
   # Windows: Download from https://redis.io/download
   # Linux: apt install redis-server
   ```

2. Set environment variables in `.env`:
   ```
   JWT_SECRET=a-strong-random-secret
   ADMIN_EMAIL=your@email.com
   ADMIN_PASSWORD=a-strong-password
   REDIS_HOST=127.0.0.1
   REDIS_PORT=6379
   ```

3. Use **PM2** for process management:
   ```bash
   npm install -g pm2
   pm2 start src/index.js --name whatsapp-sender
   pm2 save
   pm2 startup
   ```

## Requirements

- Node.js 18+
- Google Chrome (for whatsapp-web.js)
- Windows, Linux, or macOS
- No Docker, no build tools, no external databases

## License

MIT
