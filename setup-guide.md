# USPA Records Viewer — Setup Guide
## Deploy your free proxy in ~5 minutes

This guide walks you through putting the proxy server online so **anyone** can use the records viewer without touching code again.

---

## What you're doing (plain English)

The USPA website loads its records data in a way that blocks other websites from reading it directly. You're going to run a tiny "middleman" server (the proxy) that fetches the data and passes it along. Render hosts it for free.

---

## Step 1 — Create a free GitHub account (if you don't have one)

1. Go to **https://github.com** and sign up (free)
2. Verify your email

---

## Step 2 — Create a new repository on GitHub

1. Click the **+** button in the top right → **New repository**
2. Name it: `uspa-records-proxy`
3. Set it to **Public**
4. Click **Create repository**

---

## Step 3 — Upload the proxy files

In your new repository, click **uploading an existing file** (shown on the empty repo page).

Drag and drop these 3 files from this folder:
- `server.js`
- `package.json`
- `render.yaml`

Click **Commit changes**.

---

## Step 4 — Create a free Render account

1. Go to **https://render.com** and sign up (free)
2. Click **Sign in with GitHub** — this links Render to your GitHub

---

## Step 5 — Deploy the proxy on Render

1. In Render, click **New +** → **Web Service**
2. Click **Connect** next to your `uspa-records-proxy` repository
3. Render will auto-detect the settings from `render.yaml`. You should see:
   - **Name**: uspa-records-proxy
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Make sure **Free** plan is selected
5. Click **Create Web Service**

Render will build and deploy. This takes about **2–3 minutes** the first time.

---

## Step 6 — Copy your proxy URL

Once deployed, Render shows you a URL like:
```
https://uspa-records-proxy.onrender.com
```

Copy this URL.

---

## Step 7 — Connect the viewer to your proxy

1. Open `index.html` in a web browser
2. Click **⚙ PROXY SERVER URL** at the top
3. Paste your Render URL
4. Click **Save & Load**

Records will load automatically! 🎉

---

## Step 8 — Host the viewer (optional, so others can use it)

The easiest free option is **GitHub Pages**:

1. In your GitHub repository, click **Add file** → **Upload files**
2. Upload `index.html`
3. Go to **Settings** → **Pages**
4. Under Source, select **Deploy from a branch** → `main` → `/ (root)`
5. Click **Save**

After ~1 minute, your viewer is live at:
```
https://YOUR-USERNAME.github.io/uspa-records-proxy/
```

Share that link with anyone!

---

## Important notes

### Free tier limitations
- **Render free servers "sleep"** after 15 minutes of no traffic
- The first person to visit after a sleep period waits **30–60 seconds** for the server to wake up
- After that, it's fast for everyone
- To avoid this, upgrade to Render's $7/month "Starter" plan

### Data freshness
- Records are cached for **1 hour** on the proxy
- After 1 hour, the next visitor triggers a fresh scrape automatically
- You don't need to do anything to keep data current

### Updating the proxy
- If the USPA website changes and data stops loading, just re-upload `server.js` to GitHub
- Render automatically re-deploys whenever you push changes

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Error: fetch failed" | Server is waking up — wait 30–60 seconds and retry |
| Records load but are empty | USPA site structure may have changed — check for an updated `server.js` |
| Render build fails | Make sure all 3 files are uploaded (server.js, package.json, render.yaml) |
| Page shows but no records | Double-check the proxy URL has no trailing slash |
