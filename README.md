# WiseTech Image MCP Server

An MCP (Model Context Protocol) server that exposes **all three** WiseTech AI image tools to any MCP-compatible client (Claude, ChatGPT, Grok, etc.):

| Tool | What it does | API endpoint |
|------|-------------|-------------|
| `upscale_image` | Upscales an image to higher resolution | `{main_api}/upscale_web_v2` |
| `enhance_face` | Enhances faces in an image | `{main_api}/faceenhance_web` |
| `remove_background` | Removes the background from an image | `{bg_api}/uploadImageV2` → `/processImageBackgroundRemove` → `/getStatus` → `/downloadImage` |

All three accept a **public image URL** and return the processed image as **base64 PNG**.

**Verified working** — all three APIs tested end-to-end on 2026-06-20.

---

## Quick start (local testing)

```bash
npm install
npm run dev
```

Server starts on `http://localhost:3000/mcp`. No `.env` needed for local testing — it auto-resolves the API URLs.

---

## Environment variables

All config lives in `.env` (never committed to git). Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_AUTH_KEY` | **Yes for production** | Your secret key. Clients send `Authorization: Bearer <key>`. Generate with `openssl rand -hex 32`. |
| `WISETECH_MAIN_DNS` | No | DNS resolver URL for main API (default: `https://sd.rad-wi.com`) |
| `WISETECH_BG_DNS` | No | DNS resolver URL for bg remover API (default: `https://ibgc.rad-wi.com/`) |
| `WISETECH_MAIN_FALLBACK` | No | Fallback main API IP if DNS fails |
| `WISETECH_BG_FALLBACK` | No | Fallback bg API IP if DNS fails |
| `WISETECH_MAIN_API_URL` | No | Pin a specific main API host (skips DNS) |
| `WISETECH_BG_API_URL` | No | Pin a specific bg API host (skips DNS) |
| `WISETECH_API_KEY` | No | API key if WiseTech adds one (currently not needed) |
| `WISETECH_AUTH_HEADER` | No | Header name for the API key (e.g. `x-api-key`) |
| `PORT` | No | HTTP port (default: `3000`, use `8443` for VPS HTTPS) |
| `HTTPS_CERT_DIR` | No | Path to Let's Encrypt cert dir. When set, server uses HTTPS directly (no nginx needed). Example: `/etc/letsencrypt/live/mcp.yourdomain.com` |

### DNS auto-refresh

The WiseTech API IPs rotate daily. This server replicates the WordPress plugin's DNS-resolution: on startup (and every 6 hours) it fetches the current URL from the DNS endpoints. No manual IP updates needed.

---

## Deploy on Heroku

### Step 1: Install Heroku CLI and login

```bash
npm install -g heroku
heroku login
```

### Step 2: Create a Heroku app

```bash
cd wisetech-image-mcp
heroku create wisetech-image-mcp
```

### Step 3: Set environment variables

```bash
# Generate a strong auth key
heroku config:set MCP_AUTH_KEY=$(openssl rand -hex 32)

# API URLs (auto-resolved from DNS, but set fallbacks)
heroku config:set WISETECH_MAIN_DNS=https://sd.rad-wi.com
heroku config:set WISETECH_BG_DNS=https://ibgc.rad-wi.com/
heroku config:set WISETECH_MAIN_FALLBACK=http://34.232.100.156:5454
heroku config:set WISETECH_BG_FALLBACK=http://35.190.164.209:5454
```

### Step 4: Deploy

```bash
git add .
git commit -m "Initial deploy"
git push heroku main
```

Heroku automatically:
- Runs `npm install`
- Runs `npm run build` (via the `build` script in `package.json`)
- Starts the app using the `Procfile`: `web: node dist/index.js`
- Assigns a port via the `PORT` env var (handled automatically)

### Step 5: Verify it's running

```bash
heroku open
# Or test the MCP endpoint:
curl -X POST https://wisetech-image-mcp.herokuapp.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer YOUR_MCP_AUTH_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should see all three tools in the response.

### Step 6: Connect to AI tools

Your MCP URL is: `https://wisetech-image-mcp.herokuapp.com/mcp`

Use this URL + your `MCP_AUTH_KEY` in Claude / ChatGPT / Grok (see below).

### Heroku notes

- **Free tier sleeps** after 30 min of inactivity. First request after sleep takes ~10s to wake up. Use `heroku ps:scale web=1` and consider upgrading to Eco/Hobby for always-on.
- **Port**: Heroku sets `PORT` automatically — don't set it yourself.
- **Timeout**: Heroku has a 30s request timeout on free tier. Image processing can take up to 180s. If you hit timeouts, upgrade to Hobby tier or use a VPS instead.

---

## Deploy on a VPS (recommended for production)

VPS is better than Heroku for this because image processing can take up to 3 minutes (Heroku free tier times out at 30s).

This guide is written for **your specific VPS** (Ubuntu 24.04, IP `167.88.43.163`).

### Your VPS current state

| Service | Port | Status |
|---------|------|--------|
| Docker (n8n) | 3000 | ⚠️ Taken — don't use |
| OpenVPN | 80 | ⚠️ Taken — don't use |
| nginx | 443, 8080 | ⚠️ Taken (n8n.conf) |
| Redis | 6379 | In use |
| SSH | 22 | In use |
| **8443** | **free** | ✅ We'll use this |

**Strategy:** Use port `8443` with HTTPS directly from Node (no nginx needed). This avoids touching any existing services — no conflicts with n8n, OpenVPN, or nginx.

### Step 1: Install pm2 (process manager)

pm2 is not installed on your VPS yet. SSH into your VPS and install it:

```bash
ssh root@167.88.43.163
npm install -g pm2
```

### Step 2: Clone the repo

**If the repo is public:**
```bash
cd /opt
git clone https://github.com/Motasaith/MCP_Upscale_Face-Enhancer_Remove-BG.git wisetech-mcp
cd wisetech-mcp
npm install
npm run build
```

**If the repo is private**, generate a Personal Access Token first:
1. Go to https://github.com/settings/tokens → "Generate new token (classic)" → check `repo` → generate
2. Copy the token, then on the VPS:
```bash
cd /opt
git clone https://Motasaith:YOUR_TOKEN@github.com/Motasaith/MCP_Upscale_Face-Enhancer_Remove-BG.git wisetech-mcp
cd wisetech-mcp
npm install
npm run build
```

> **Note:** The repo is safe to make public — all secrets are in `.env` (gitignored), `SECURITY.md` is gitignored, and the PHP reference folder is gitignored. The code on GitHub contains no API URLs or keys.

### Step 3: Create the `.env` file

```bash
nano /opt/wisetech-mcp/.env
```

```env
MCP_AUTH_KEY=GENERATE_A_STRONG_KEY_HERE
WISETECH_MAIN_DNS=https://sd.rad-wi.com
WISETECH_BG_DNS=https://ibgc.rad-wi.com/
WISETECH_MAIN_FALLBACK=http://34.232.100.156:5454
WISETECH_BG_FALLBACK=http://35.190.164.209:5454
WISETECH_API_KEY=
WISETECH_AUTH_HEADER=
PORT=8443
HTTPS_CERT_DIR=/etc/letsencrypt/live/mcp.yourdomain.com
```

Generate a strong auth key:
```bash
openssl rand -hex 32
```

Lock down the file:
```bash
chmod 600 /opt/wisetech-mcp/.env
chown root:root /opt/wisetech-mcp/.env
```

### Step 4: Point a subdomain at this VPS

In your DNS dashboard (wherever you manage your domain — Cloudflare, Namecheap, etc.), add an A record:

```
A   mcp.yourdomain.com   →   167.88.43.163
```

Wait a few minutes for DNS to propagate. Verify:
```bash
dig mcp.yourdomain.com +short
# should return 167.88.43.163
```

### Step 5: Get the SSL certificate (DNS challenge — no port 80 needed)

This method avoids touching port 80 (which OpenVPN uses). It uses a DNS TXT record instead.

```bash
apt install -y certbot
certbot certonly --manual --preferred-challenges dns -d mcp.yourdomain.com
```

Certbot will print something like:
```
Please deploy a DNS TXT record under:
_acme-challenge.mcp.yourdomain.com
with this value:
abc123def456...
```

Go to your DNS dashboard, add that TXT record, wait ~2 minutes, then press Enter in the terminal.

Certbot saves the cert to `/etc/letsencrypt/live/mcp.yourdomain.com/`.

**Note:** This cert expires in 90 days. Since it's a manual DNS challenge, you'll need to repeat this step before it expires. If your domain is on Cloudflare, you can automate it later with `certbot-dns-cloudflare`.

### Step 6: Start the server with pm2

```bash
cd /opt/wisetech-mcp
pm2 start dist/index.js --name wisetech-mcp
pm2 save
pm2 startup    # follow the instructions it prints to make it survive reboots
```

Check it's running:
```bash
pm2 status
pm2 logs wisetech-mcp --lines 10
```

You should see:
```
WiseTech Image MCP server listening on :8443 (HTTPS, POST /mcp)
Tools: upscale_image, enhance_face, remove_background
[DNS] APIs resolved successfully.
```

### Step 7: Open the port (if firewall is active)

```bash
ufw status
```

If it says "active":
```bash
ufw allow 8443/tcp
```

If it says "inactive", skip this step.

### Step 8: Test from outside

```bash
curl -i -X POST https://mcp.yourdomain.com:8443/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer YOUR_MCP_AUTH_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should see all three tools in the response.

### Step 9: Connect to AI tools

Your MCP URL is: `https://mcp.yourdomain.com:8443/mcp`

Use this in Claude / ChatGPT / Grok (see the "Connecting to AI tools" section above).

### Useful pm2 commands

```bash
pm2 status                    # see if it's running
pm2 logs wisetech-mcp         # live logs (Ctrl+C to exit)
pm2 restart wisetech-mcp      # restart after code changes
pm2 stop wisetech-mcp         # stop
pm2 delete wisetech-mcp       # remove from pm2
```

### Certificate renewal (every 90 days)

Since we used a manual DNS challenge, auto-renewal won't work unattended. Before the cert expires:

```bash
certbot certonly --manual --preferred-challenges dns -d mcp.yourdomain.com
pm2 restart wisetech-mcp
```

If your domain is on Cloudflare, you can automate this:
```bash
apt install -y python3-certbot-dns-cloudflare
# Configure with your Cloudflare API token, then:
certbot certonly --dns-cloudflare --dns-cloudflare-credentials /root/.cloudflare.ini -d mcp.yourdomain.com
# Then add a cron job for auto-renewal
```

---

## Connecting to AI tools

### Claude Desktop

Edit this file:
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "wisetech-image": {
      "url": "https://your-domain.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_AUTH_KEY"
      }
    }
  }
}
```

Restart Claude Desktop. You'll see three tools available:
- `upscale_image`
- `enhance_face`
- `remove_background`

### ChatGPT / Grok / other MCP clients

Go to their custom tools / MCP settings and add:
- **URL:** `https://your-domain.com/mcp`
- **Header:** `Authorization: Bearer YOUR_MCP_AUTH_KEY`

### Local testing (no deployment needed)

```bash
npm run dev
```

Point your AI client at `http://localhost:3000/mcp` (no auth key needed for local).

---

## How it works

### Upscale & Face Enhance (synchronous)

```
User → AI tool → MCP server → downloads image from URL → base64-encodes →
  POST {main_api}/upscale_web_v2   (or /faceenhance_web)
  body: {"image": "<base64>"}
  → response: {"image": "<base64 result>"}
→ returns base64 PNG to the AI tool → AI tool shows it to the user
```

### Background Remover (asynchronous, handled automatically)

```
User → AI tool → MCP server → downloads image →
  1. POST  {bg_api}/uploadImageV2            (multipart "file")
  2. GET   {bg_api}/processImageBackgroundRemove?imageName=...
  3. Poll  {bg_api}/getStatus?imageName=...   (every 3s until status=1)
  4. GET   {bg_api}/downloadImage?imageName=...png
→ returns base64 PNG to the AI tool
```

The entire async flow is hidden from the AI tool — it just gets the final image back.

---

## Supported formats

| Tool | Formats |
|------|---------|
| Upscale | JPG, JPEG, PNG, GIF, JFIF, WEBP, BMP, ICO, SVG, AVIF |
| Face Enhance | JPG, JPEG, PNG, GIF, JFIF, WEBP, BMP, ICO, SVG, AVIF |
| Background Remove | JPG, JPEG, PNG, WEBP, JFIF, BMP |

**Max file size:** 10 MB (enforced server-side, matching the WP plugin).

---

## Project structure

```
wisetech-image-mcp/
├── index.ts          # MCP server — all 3 tools (supports HTTP + HTTPS)
├── package.json      # Dependencies + scripts
├── tsconfig.json     # TypeScript config
├── Procfile          # Heroku deployment config
├── .env              # Your secrets (NEVER commit to git)
├── .env.example      # Template for .env
├── .gitignore        # Blocks .env, SECURITY.md, node_modules from git
├── SECURITY.md       # Security & deployment details (kept private)
├── README.md         # This file
└── Extra_Just_For_API_Info/   # Original PHP plugin reference (gitignored)
```

---

## Notes

- The server uses **Streamable HTTP transport** (not stdio), so it works with remote/web-based MCP clients like ChatGPT and Grok, not just Claude Desktop.
- Background removal output is always PNG (the API converts the input filename to `.png`).
- All API URLs are in `.env`, not in the code — someone reading the source sees nothing.
- See `SECURITY.md` for detailed security information and hardening steps.