# Brightspace Calendar → Google Calendar exporter

This small webapp fetches a Brightspace calendar (iCal/.ics) feed or accepts an uploaded .ics file, parses events (due dates), and produces a Google Calendar-compatible .ics file you can import into Google Calendar.

Why this approach?
- Many Brightspace instances expose a calendar iCal feed for each user. That feed contains course events and due dates.
- A direct Brightspace OAuth/Valence integration is possible, but requires registering an application with the Laurier Brightspace instance and extra setup. This app keeps things simple: provide the feed URL (or upload a downloaded .ics) and get a cleaned .ics you can import.

Quickstart

1. Install dependencies

```bash
cd /path/to/assignments/a9
npm install
```

2. Run

```bash
npm start
# or for development with auto-reload
npm run dev
```

3. Open http://localhost:3000 in your browser. Upload an exported .ics file and click Convert.

- Create manual events and schedule email reminders

- The homepage also includes a form to create a manual event (name, due date, type (assignment/exam/etc), percentage of course, how many minutes to allocate, "worth", and class code). You can provide comma-separated one-off reminder times (minutes before the due date), enable daily reminders, and provide your email to receive reminders. You may also upload or provide a backdrop image URL and optionally provide YouTube/Spotify media to be shown on the confirmation page.
- To enable email reminders you must configure SMTP environment variables before starting the app:

```bash
export SMTP_HOST=smtp.example.com
export SMTP_PORT=587
export SMTP_SECURE=false # true for port 465
export SMTP_USER=your-smtp-username
export SMTP_PASS=your-smtp-password
export FROM_EMAIL="Your Name <no-reply@example.com>"
```

Spotify integration (optional)
- To enable "Sign in with Spotify" on the landing page, register an app at https://developer.spotify.com/dashboard and set the Redirect URI to e.g. `http://localhost:3000/callback/spotify`.
- Then set these environment variables before starting the server:

```bash
export SPOTIFY_CLIENT_ID=your_spotify_client_id
export SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
export SPOTIFY_REDIRECT_URI=http://localhost:3000/callback/spotify
```

The app will store the access token temporarily in the server session and attempt to fetch your first playlist to embed on the landing page. This uses Spotify's web API and only requires a client id/secret; no persistent storage is used.

Web Playback SDK notes (in-browser playback)
- The Web Playback SDK allows playback of a user's personal Spotify content inside the browser, but it requires:
	- An HTTPS origin (localhost works in many browsers but deploying publicly requires HTTPS).
	- A Spotify Premium account for the user.
	- The app to request the streaming and playback scopes (this app requests them during Spotify sign-in).
- After signing in, click "Start Spotify Player" on the landing page. The first time you must press play (Spotify requires a user gesture to start playback). The SDK will attempt to transfer playback to the browser device; if you have other devices/devices active, you may need to select the browser as the active device in the Spotify client.

Notes on reminders
- Reminder scheduling is in-memory and will be lost if the server restarts. For persistent scheduling across restarts, integrate a database and persistent job queue (e.g., Bull, Agenda) or use an external scheduler.
- The app will only send reminders for scheduled times that are in the future.

(If you have an exported .ics from Brightspace, upload it on the homepage to convert.)

Notes about deeper Brightspace integration
- Brightspace (D2L) has the Valence API. To access user course info programmatically you must register an application with Laurier's Brightspace instance to get App ID and App Key. That integration allows the app to fetch course due dates directly but requires server-side signing and user auth flows. If you want this, I can add a Valence-based flow next.

Security and privacy
- This app does not store provided calendar URLs or uploaded files by default. It only fetches them to produce the .ics for download. If you deploy it publicly, consider HTTPS, short-lived sessions, and removing logs containing incoming URLs.

Next steps / enhancements
- Add optional Google OAuth to push events directly to a user's Google Calendar.
- Implement Valence API integration for automatic fetching of assignments (requires app registration).
