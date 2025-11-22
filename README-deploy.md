Deployment guide — what I prepared and how you can go live

Summary
- I added a Dockerfile, Procfile and a GitHub Actions workflow that builds and publishes a Docker image to GitHub Container Registry.
- I cannot actually buy domains or push to hosting providers from here (no access to your cloud credentials). The files are ready so you (or CI) can finish deployment.

Placeholder domain
- I picked a random placeholder domain: aurora-calendar.site
  - This is only a suggested name. I did not register or configure DNS for it — you'll need to purchase and point DNS records.

Quick options to go live (recommended order)

1) Render (easiest)
  - Push repo to GitHub.
  - Create a new Web Service -> Connect GitHub -> pick this repo and branch.
  - If you used the Dockerfile, Render will detect and build it. Alternatively set build command `npm ci` and start `npm start`.
  - Add environment variables in the Render dashboard: `ASSEMBLY_API_KEY`, `GOOGLE_API_KEY` (if used), `YT_API_KEY`, and any S3 credentials if you switch to S3.
  - Set persistent disk or configure S3 for uploads (public/uploads is ephemeral on many PaaS).
  - Add a custom domain in Render and enable TLS.

2) GitHub Container Registry + DigitalOcean App Platform
  - The workflow builds and publishes to GHCR on push to `main`.
  - Create a DigitalOcean App, select "Deploy from Container Registry", point to the pushed image, and set environment variables.

3) VPS (manual) — full control
  - Create a server (Ubuntu), install Docker, clone repo.
  - Build and run the image locally:
    docker build -t a9-calendar:latest .
    docker run -p 3000:3000 --env-file .env a9-calendar:latest
  - Set up nginx reverse proxy and Certbot for TLS.

Important production notes
- Do not commit `.env` with API keys. Use the host secrets management.
- The app currently writes uploads to `public/uploads`. On most PaaS this directory is ephemeral; use an S3-compatible bucket (I can add S3 code if you want).
- Keep `public/vendor/ffmpeg` served from same origin; the server sends COOP/COEP headers already — this is required for ffmpeg.wasm SharedArrayBuffer.

What I can do next for you (choose one)
- Add S3 upload support and migrate file writes to S3.
- Add a small Terraform manifest or Render `render.yaml` to fully automate provisioning.
- Create a domain purchase + DNS checklist and pre-fill DNS records for the placeholder domain.
- If you provide a GitHub repo URL and secrets (GHCR, Render API key), I can wire the GitHub Actions to finish publishing.
