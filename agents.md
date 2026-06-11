# AGENTS.md

## Purpose

Define how an AI coding agent should set up and validate a lightweight CORS proxy app (like this USPA records proxy), plus what a human reviewer must do manually.

This document is optimized for agent execution, not for first-time end users.

---

## Project Context

- The viewer is static and runs in a browser.
- The upstream records source is blocked by browser CORS rules.
- The proxy server fetches upstream data and returns normalized JSON to the viewer.
- Typical deploy target is Render free tier.

---

## Required Files

- `server.js`: Express proxy server and scraping/fetch logic.
- `package.json`: runtime and scripts (`npm start` must launch server).
- `render.yaml`: Render service definition (name/build/start/env).
- `index.html`: viewer that calls the proxy URL.

If any file is missing, the agent should stop and report exactly which file is missing.

---

## Agent Objectives

1. Ensure the proxy app runs locally.
2. Ensure deploy config is correct for Render.
3. Ensure the viewer can target the deployed proxy URL.
4. Produce a clear handoff note with validation results and known limitations.

---

## Agent Workflow (Do This In Order)

### 1) Preflight checks

1. Confirm Node.js is installed.
2. Confirm required files exist.
3. Run `npm install`.
4. Verify `npm start` script exists in `package.json`.

### 2) Local runtime validation

1. Start server locally (`npm start`).
2. Call health or data endpoint using browser/curl.
3. Confirm response is valid JSON and not empty.
4. Confirm CORS headers are present for viewer usage.

### 3) Deployment readiness validation

1. Check `render.yaml` has the correct service type and start command.
2. Check no secrets are hardcoded in tracked files.
3. Check service port handling is compatible with Render (`PORT` env).
4. Check cache behavior is intentional and documented.

### 4) Viewer integration validation

1. Verify `index.html` supports editable proxy URL input.
2. Verify the URL is saved and reused (if local storage is expected).
3. Verify clicking load fetches through proxy and renders records.

### 5) Final handoff output

Agent must provide:

- What was verified successfully.
- What failed and why.
- Exact manual steps remaining for the human reviewer.
- Any known reliability limits (sleep/warmup/cache staleness).

---

## Decision Rules For Agents

- If upstream site layout changes and parsing fails: do not hide the error; surface actionable failure details.
- If deployment is not possible from local-only context: prepare files and provide minimal click-path instructions for reviewer.
- If a command fails: include command, error summary, and next corrective action attempted.
- Do not claim production-ready unless local runtime, endpoint output, and deploy config all pass.

---

## Manual Reviewer Checklist (Human-Only Tasks)

The reviewer must do these steps manually in external web UIs:

1. Create/verify GitHub repository visibility and ownership settings.
2. Push or upload project files to the repository default branch.
3. Connect repository to Render account.
4. Confirm Render service plan (free vs paid) and create service.
5. Copy deployed Render URL.
6. Open viewer, paste proxy URL, save, and run a real fetch.
7. Optionally publish `index.html` via GitHub Pages.
8. Confirm public URL works from a fresh/private browser session.

---

## Manual Reviewer Acceptance Criteria

- Deployed proxy returns valid records JSON from public URL.
- Viewer loads records using deployed proxy URL (not localhost).
- First-load wake-up delay on free tier is understood and acceptable.
- No hardcoded secrets in repository.
- README/notes include recovery guidance if upstream format changes.

---

## Operational Notes

- Render free services may sleep after inactivity; cold starts are expected.
- Cache windows reduce upstream load but can show stale data.
- Upstream HTML/API changes are the most likely breakage source.

---

## Troubleshooting Matrix

| Symptom | Likely Cause | Action |
|---|---|---|
| `fetch failed` from viewer | Render service sleeping or unreachable | Retry after 30-60s; check Render logs/status |
| Empty records payload | Upstream selector/API changed | Update parser logic in `server.js` |
| Render build failure | Missing file or bad script | Verify `package.json` scripts and required files |
| Viewer loads but no data | Wrong proxy URL or CORS issue | Recheck URL format and CORS headers |

---

## Reuse Template For Similar Apps

When cloning this pattern for another source site, keep this structure and only replace:

- Upstream endpoint and parsing logic in `server.js`.
- App/service naming in `render.yaml`.
- Viewer labels/default endpoint in `index.html`.

Do not change the workflow and manual checklist sections unless process requirements changed.
