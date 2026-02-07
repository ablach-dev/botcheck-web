# Blech's Viewbot Check (Web)

A Next.js dashboard that monitors Twitch chat activity and viewer counts in real time.

## Features
- Live Viewers (CCV)
- Peak Viewers
- Total Messages
- Unique Chatters
- Chatters with < 3 messages
- Messages Per Minute
- Top 5 Chatters

## Setup
1. Install dependencies.
2. Copy `.env.example` to `.env.local` and fill in Twitch credentials.
3. Run the dev server.

```bash
npm install
npm run dev
```

## Twitch Credentials
Create a Twitch application to get a Client ID and Client Secret. Add them to `.env.local`:

```
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret
```

If you already have an app access token you want to use directly, set:

```
TWITCH_ACCESS_TOKEN=your_app_access_token
```

Note: the access token should be the raw token (no `oauth:` prefix). App access tokens expire, so using `TWITCH_CLIENT_SECRET` is recommended for auto-refresh.

Deploy to Vercel by adding the same environment variables in the project settings.

## Rate Limiting
The `/api/twitch/viewers` route includes a basic per-IP rate limit. This is best-effort on serverless platforms.
