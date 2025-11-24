require('dotenv').config();

// Trim common env vars that may include accidental whitespace/newlines when
// copied from example files. This prevents invalid Authorization headers
// like "Invalid character in header content [\"Authorization\"]" when the
// API key contains leading/trailing spaces or newlines.
if (process.env.ASSEMBLY_API_KEY && typeof process.env.ASSEMBLY_API_KEY === 'string') {
  process.env.ASSEMBLY_API_KEY = process.env.ASSEMBLY_API_KEY.trim();
}
if (process.env.ASSEMBLYAI_API_KEY && typeof process.env.ASSEMBLYAI_API_KEY === 'string') {
  process.env.ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY.trim();
}
if (process.env.GOOGLE_API_KEY && typeof process.env.GOOGLE_API_KEY === 'string') {
  process.env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY.trim();
}
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const ical = require('node-ical');
const { createEvents } = require('ics');
const nodemailer = require('nodemailer');
const schedule = require('node-schedule');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
// no child_process required: audio extraction is handled client-side (ffmpeg.wasm)
const FormData = require('form-data');
const path = require('path');
const https = require('https');
// Optional Vercel Blob SDK (server-side). We'll require lazily so local dev
// without the token still works. The SDK is used to upload files to a named
// Vercel Blob store when VERCEL_BLOB_TOKEN and VERCEL_BLOB_STORE are set.
let vercelBlob = null;
function ensureVercelBlob() {
  if (vercelBlob) return vercelBlob;
  try {
    vercelBlob = require('@vercel/blob');
    return vercelBlob;
  } catch (e) {
    console.warn('Optional @vercel/blob SDK not available. Install it to enable Vercel Blob uploads.');
    return null;
  }
}
// Upload a Buffer to Vercel Blob. Returns public URL or null. Attempts when BLOB_ENABLE=1 or running on Vercel.
async function uploadToVercelBlob(buffer, blobPath, contentType) {
  if (!(process.env.BLOB_ENABLE === '1' || process.env.VERCEL)) return null;
  const vb = ensureVercelBlob();
  if (!vb) return null;
  const opts = { access: 'public' };
  if (process.env.VERCEL_BLOB_TOKEN) opts.token = process.env.VERCEL_BLOB_TOKEN; // needed for local dev
  if (contentType) opts.contentType = contentType;
  try {
    if (typeof vb.put === 'function') {
      const putRes = await vb.put(blobPath, buffer, opts);
      return (putRes && (putRes.downloadUrl || putRes.url)) || null;
    }
    if (vb.default && typeof vb.default.put === 'function') {
      const putRes = await vb.default.put(blobPath, buffer, opts);
      return (putRes && (putRes.downloadUrl || putRes.url)) || null;
    }
  } catch (e) {
    console.error('[uploadToVercelBlob] put failed', e && (e.response ? e.response.data || e.response.status : e.message || e));
    return null;
  }
  return null;
}
// (Vercel Blob SDK is required lazily via ensureVercelBlob())
// store uploaded backdrops in /public/uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Decide upload directory:
    // - If FALLBACK_UPLOAD_DIR env var is set, use it (explicit override)
    // - If running in production-like environment (NODE_ENV=production or
    //   running on Vercel/Now) use OS temp dir
    // - Otherwise (local dev) use ./public/uploads and ensure it exists
    const isProdLike = process.env.NODE_ENV === 'production' || !!process.env.VERCEL || !!process.env.NOW_REGION;
    const fallback = process.env.FALLBACK_UPLOAD_DIR || (isProdLike ? os.tmpdir() : path.join(__dirname, 'public', 'uploads'));
    if (fallback === path.join(__dirname, 'public', 'uploads')) {
      try { fs.mkdirSync(fallback, { recursive: true }); } catch (e) { /* ignore */ }
    }
    cb(null, fallback);
  },
  filename: function (req, file, cb) {
    const safe = Date.now() + '-' + file.originalname.replace(/[^a-z0-9.\-_]/gi, '_');
    cb(null, safe);
  }
});
// General upload handler (used for backdrops/ics). For videos we use a stricter uploader below.
const upload = multer({ storage });

// Video-specific upload limits: max 200MB and only allow common video MIME types
const videoFileFilter = (req, file, cb) => {
  if (!file.mimetype) return cb(new Error('Unknown file type'), false);
  const ok = file.mimetype.startsWith('video/');
  cb(null, ok);
};
const uploadVideo = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 }, fileFilter: videoFileFilter });

// Audio-specific uploader for client-extracted WAV files (limit to 100MB)
const audioFileFilter = (req, file, cb) => {
  if (!file.mimetype) return cb(new Error('Unknown file type'), false);
  const ok = file.mimetype.startsWith('audio/');
  cb(null, ok);
};
const uploadAudio = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 }, fileFilter: audioFileFilter });

const app = express();
const PORT = process.env.PORT || 3000;

// Helper to write transcription or auxiliary files in a way that works both
// locally (where ./public/uploads is available) and in serverless (where
// only os.tmpdir() is writable). Returns an object { fullPath, publicUrl }
// where publicUrl is null when the file is not under ./public/uploads.
function writeUploadFile(filename, data, encoding = 'utf8') {
  const publicDir = path.join(__dirname, 'public', 'uploads');
  let targetDir = publicDir;
  try {
    // prefer public/uploads when it exists and is writable
    if (!fs.existsSync(publicDir)) throw new Error('no public uploads dir');
    fs.accessSync(publicDir, fs.constants.W_OK);
  } catch (e) {
    // fallback to os.tmpdir
    targetDir = os.tmpdir();
  }
  try {
    const fullPath = path.join(targetDir, filename);
    fs.writeFileSync(fullPath, data, encoding);
    const publicUrl = targetDir === publicDir ? `/uploads/${filename}` : null;
    return { fullPath, publicUrl };
  } catch (e) {
    console.error('writeUploadFile failed', e && e.message);
    throw e;
  }
}

// Download a remote URL (up to maxBytes) and save it into ./public/uploads so
// the browser can play it same-origin. Returns the public URL (e.g. /uploads/xxx)
// or null if the file couldn't be saved (not writable or too large).
async function fetchAndSaveToPublic(remoteUrl, preferredName, maxBytes = 10 * 1024 * 1024) {
  const publicDir = path.join(__dirname, 'public', 'uploads');
  try {
    // ensure public/uploads exists and is writable
    fs.mkdirSync(publicDir, { recursive: true });
    fs.accessSync(publicDir, fs.constants.W_OK);
  } catch (e) {
    console.log('[fetchAndSaveToPublic] public/uploads not writable or not available');
    return null;
  }

  // Determine filename and extension
  let name = String(preferredName || `download-${Date.now()}`).replace(/[^a-z0-9.\-_]/gi, '_');
  // If there's no extension, try to infer from content-type after HEAD
  const tmpPath = path.join(publicDir, name);

  const httpsAgent = new https.Agent({ rejectUnauthorized: false }); // testing helper
  try {
    const resp = await axios.get(remoteUrl, { responseType: 'stream', timeout: 20000, httpsAgent, validateStatus: () => true });
    const contentType = resp.headers && resp.headers['content-type'];
    // infer extension
    if (!path.extname(name) && contentType) {
      if (contentType.includes('mp4') || contentType.includes('video')) name = name + '.mp4';
      else if (contentType.includes('wav')) name = name + '.wav';
      else if (contentType.includes('mpeg') || contentType.includes('audio')) name = name + '.mp3';
      else if (contentType.includes('ogg')) name = name + '.ogg';
    }

    const fullPath = path.join(publicDir, name);
    const ws = fs.createWriteStream(fullPath);
    let downloaded = 0;
    let aborted = false;

    return await new Promise((resolve) => {
      resp.data.on('data', (chunk) => {
        downloaded += chunk.length;
        if (downloaded > maxBytes) {
          aborted = true;
          try { resp.data.destroy(); } catch (e) {}
          try { ws.destroy(); } catch (e) {}
          try { fs.unlinkSync(fullPath); } catch (e) {}
          console.log('[fetchAndSaveToPublic] aborted - exceeded maxBytes', downloaded, '>', maxBytes);
          return resolve(null);
        }
      });

      resp.data.pipe(ws);

      ws.on('finish', () => {
        if (aborted) return resolve(null);
        const publicUrl = `/uploads/${name}`;
        console.log('[fetchAndSaveToPublic] saved', fullPath, 'size=', downloaded);
        resolve(publicUrl);
      });

      ws.on('error', (err) => {
        console.error('[fetchAndSaveToPublic] write error', err && err.message);
        try { fs.unlinkSync(fullPath); } catch (e) {}
        resolve(null);
      });

      resp.data.on('error', (err) => {
        console.error('[fetchAndSaveToPublic] stream error', err && err.message);
        try { ws.destroy(); } catch (e) {}
        try { fs.unlinkSync(fullPath); } catch (e) {}
        resolve(null);
      });
    });
  } catch (e) {
    console.error('[fetchAndSaveToPublic] failed to fetch remote', e && (e.response ? e.response.status : e.message || e));
    return null;
  }
}

// We handle audio extraction client-side using ffmpeg.wasm. The server will
// accept already-extracted audio (`/upload/audio`) or raw video uploads and
// forward them to the transcription API. This avoids requiring ffmpeg to be
// installed on the server host.

// (Previously used for Spotify sessions) No server-side session is required for YouTube embed.
// const session = require('express-session');
// app.use(session({
//   secret: process.env.SESSION_SECRET || 'change-this-secret',
//   resave: false,
//   saveUninitialized: false,
//   cookie: { maxAge: 24 * 60 * 60 * 1000 }
// }));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Site access secret: when set, require Basic auth (or Bearer) for all requests.
// This is an easy way to keep the deployment private without changing Vercel
// project settings. Set SITE_ACCESS_SECRET in your environment on Vercel or
// locally to enable. Leave unset to allow public access.
const SITE_ACCESS_SECRET = process.env.SITE_ACCESS_SECRET || null;
console.log('SITE_ACCESS_SECRET=', SITE_ACCESS_SECRET ? 'SET' : 'not set');
app.use((req, res, next) => {
  if (!SITE_ACCESS_SECRET) return next();
  const auth = req.headers && req.headers.authorization;
  if (!auth) {
    res.set('WWW-Authenticate', 'Basic realm="Protected"');
    return res.status(401).send('Unauthorized');
  }
  const parts = auth.split(' ');
  if (parts[0] === 'Basic' && parts[1]) {
    try {
      const creds = Buffer.from(parts[1], 'base64').toString();
      const idx = creds.indexOf(':');
      const password = idx === -1 ? creds : creds.slice(idx + 1);
      if (password === SITE_ACCESS_SECRET) return next();
    } catch (e) { /* fallthrough */ }
  }
  if (parts[0] === 'Bearer' && parts[1] === SITE_ACCESS_SECRET) return next();
  res.set('WWW-Authenticate', 'Basic realm="Protected"');
  return res.status(401).send('Unauthorized');
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Important: enable cross-origin isolation so the browser can create
// SharedArrayBuffer which ffmpeg.wasm may require. This sets COOP/COEP
// headers. Note: when these headers are enabled, any cross-origin resources
// (CDN scripts, images) must send appropriate CORP/CORS headers. The
// recommended flow is to host ffmpeg.wasm and its assets locally under
// /public/vendor/ffmpeg so they are same-origin and usable by ffmpeg.wasm.
// Cross-origin isolation (required for SharedArrayBuffer / ffmpeg.wasm).
// This blocks embedding cross-origin resources (like YouTube) unless those
// resources send compatible CORP/CORS headers. Make this optional so you can
// disable it when embedding external iframes is required.
//
// To enable cross-origin isolation, set ENABLE_CROSS_ORIGIN_ISOLATION=1 in
// your environment. When not set, these headers will NOT be added and YouTube
// embeds will work normally.
const enableCOOP = (process.env.ENABLE_CROSS_ORIGIN_ISOLATION === '1');
// Log the runtime value so we can confirm the environment is available in the serverless runtime
console.log('ENABLE_CROSS_ORIGIN_ISOLATION=', process.env.ENABLE_CROSS_ORIGIN_ISOLATION);
app.use((req, res, next) => {
  if (enableCOOP) {
    // Only set on HTML and script requests; static assets under /public will
    // also inherit these headers which is desired for cross-origin isolation.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    console.log('[COOP] set COOP/COEP for', req.method, req.url);
  } else {
    console.log('[COOP] not enabled for', req.method, req.url);
  }
  next();
});


// Video/audio transcription routes removed - calendar conversion only

// Proxy an external video URL so the browser can load it with correct CORS

  // Use actual uploaded path when available and only expose public URL if
  // the file was written into ./public/uploads. On serverless hosts files
  // are typically written to os.tmpdir and cannot be served from /uploads.
  const uploadedPath = (req.file && req.file.path) ? req.file.path : path.join(__dirname, 'public', 'uploads', req.file.filename);
  const publicUploadsDir = path.join(__dirname, 'public', 'uploads');
  const publicUrl = uploadedPath && uploadedPath.startsWith(publicUploadsDir) ? `/uploads/${req.file.filename}` : null;
  const basename = req.file.filename.replace(/\.[^/.]+$/, '');
  const result = { url: publicUrl };

    // Detect configured transcription keys (AssemblyAI or Google)
    const GOOGLE_KEY = process.env.GOOGLE_API_KEY || null;
    const ASSEMBLY_KEY = process.env.ASSEMBLY_API_KEY || process.env.ASEMBLYAI_API_KEY || null;

    // Debug logging to help diagnose missing transcripts
    try {
      const st = uploadedPath && fs.existsSync(uploadedPath) ? fs.statSync(uploadedPath) : null;
      console.log(`[upload/audio] received file=${req.file.filename} path=${uploadedPath} size=${st ? st.size : 'unknown'} verbatim=${req.body && req.body.verbatim} longrunning=${req.body && req.body.longrunning} GOOGLE_KEY=${!!GOOGLE_KEY} ASSEMBLY_KEY=${!!ASSEMBLY_KEY}`);
    } catch (e) {
      console.log('[upload/audio] received file (stat failed)', req.file && req.file.filename, 'path=', uploadedPath, 'err=', e && e.message);
    }

    if (!GOOGLE_KEY && !ASSEMBLY_KEY) {
      result.transcriptAvailable = false;
      result.message = 'Upload succeeded. Set GOOGLE_API_KEY or ASSEMBLY_API_KEY in the server environment to enable automatic transcription, or extract audio client-side and POST to /upload/audio.';
      console.log('[upload/audio] no transcription key configured - returning message to client');
      return res.json(result);
    }

    // Respect verbatim flag from client
    const verbatimRequested = req.body && (req.body.verbatim === '1' || req.body.verbatim === 'true' || req.body.verbatim === 'on');
    try {
      // Prefer AssemblyAI if configured
      const ASSEMBLY_KEY = process.env.ASSEMBLY_API_KEY || process.env.ASEMBLYAI_API_KEY || null;
      if (ASSEMBLY_KEY) {
        console.log('[upload/audio] Using AssemblyAI for transcription');
        // upload the file bytes to AssemblyAI
        if (!uploadedPath || !fs.existsSync(uploadedPath)) {
          result.transcriptAvailable = false;
          result.message = 'Uploaded file not found on server (it may be larger than the allowed payload). Try extracting audio client-side or set FALLBACK_UPLOAD_DIR.';
          console.error('[upload/audio] file not found at', uploadedPath);
          return res.json(result);
        }
        const buf = fs.readFileSync(uploadedPath);
        let uploadUrl = null;
        try {
          const upRes = await axios.post('https://api.assemblyai.com/v2/upload', buf, {
            headers: { Authorization: ASSEMBLY_KEY, 'Content-Type': 'application/octet-stream' },
            maxBodyLength: Infinity,
            timeout: 120000
          });
          uploadUrl = (upRes.data && (upRes.data.upload_url || upRes.data.url)) || upRes.data;
        } catch (e) {
          console.error('[upload/audio] AssemblyAI upload failed', e && (e.response ? e.response.data : e.message || e));
          result.transcriptAvailable = false;
          result.message = 'AssemblyAI upload failed: ' + (e && e.response && e.response.data ? JSON.stringify(e.response.data) : (e.message || 'unknown'));
          return res.json(result);
        }

        // Create transcript job and return immediately to avoid function timeouts.
        let transcriptId = null;
        try {
          const createResp = await axios.post('https://api.assemblyai.com/v2/transcript', {
            audio_url: uploadUrl,
            punctuate: true,
            format_text: true
          }, {
            headers: { Authorization: ASSEMBLY_KEY, 'Content-Type': 'application/json' },
            timeout: 120000
          });
          transcriptId = createResp.data && createResp.data.id;
        } catch (e) {
          console.error('[upload/audio] AssemblyAI create transcript failed', e && (e.response ? e.response.data : e.message || e));
          result.transcriptAvailable = false;
          result.message = 'AssemblyAI create transcript failed: ' + (e && e.response && e.response.data ? JSON.stringify(e.response.data) : (e.message || 'unknown'));
          return res.json(result);
        }

        result.transcriptAvailable = false;
        result.transcriptId = transcriptId;
        result.message = 'Transcription job created; poll /transcript/status/:id for updates.';
        return res.json(result);
      }
      // If a Google API key (Gemini-style) was provided, use Google Speech-to-Text
      // for transcription. Use longrunningrecognize automatically for larger
      // uploads or when explicitly requested via form field `longrunning=1`.
  if (GOOGLE_KEY) {
        const stat = fs.statSync(uploadedPath);
        const useLong = (req.body && (req.body.longrunning === '1' || req.body.longrunning === 'true')) || stat.size > (5 * 1024 * 1024);
        const buf = fs.readFileSync(uploadedPath);
        const b64 = buf.toString('base64');
        const languageCode = req.body.languageCode || 'en-US';

        const config = {
          encoding: 'LINEAR16',
          sampleRateHertz: 16000,
          languageCode: languageCode,
          enableWordTimeOffsets: !!verbatimRequested,
          enableAutomaticPunctuation: true
        };

        if (useLong) {
          // Start a longrunningrecognize operation
          const longReq = { config, audio: { content: b64 } };
          const lres = await axios.post(`https://speech.googleapis.com/v1/speech:longrunningrecognize?key=${encodeURIComponent(GOOGLE_KEY)}`, longReq, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 120000
          });

          const opName = lres.data && (lres.data.name || (lres.data.operation && lres.data.operation.name));
          if (!opName) {
            result.transcriptAvailable = false;
            result.message = 'Could not start longrunning transcription (no operation name returned)';
            return res.json(result);
          }

          // Poll the operation status until done (with timeout)
          const start = Date.now();
          const timeoutMs = 5 * 60 * 1000; // 5 minutes
          let opResp = null;
          while (true) {
            await new Promise(r => setTimeout(r, 2000));
            const poll = await axios.get(`https://speech.googleapis.com/v1/operations/${encodeURIComponent(opName)}?key=${encodeURIComponent(GOOGLE_KEY)}`, { timeout: 120000 });
            opResp = poll.data || {};
            if (opResp.done) break;
            if (Date.now() - start > timeoutMs) {
              result.transcriptAvailable = false;
              result.message = 'Longrunning transcription timed out';
              return res.json(result);
            }
          }

          // Operation finished — extract results
          const gbody = (opResp.response && opResp.response) || opResp; // response may contain results
          let text = '';
          if (gbody && gbody.results && Array.isArray(gbody.results) && gbody.results.length) {
            text = gbody.results.map(r => (r.alternatives && r.alternatives[0] && r.alternatives[0].transcript) || '').join(' ').trim();
          } else if (gbody && gbody.results && Array.isArray(gbody.results)) {
            text = gbody.results.map(r => (r.alternatives && r.alternatives[0] && r.alternatives[0].transcript) || '').join(' ').trim();
          }

          if (text) {
            const transcriptFilename = `${basename}.txt`;
            try {
              const written = writeUploadFile(transcriptFilename, text, 'utf8');
              result.transcriptAvailable = true;
              result.transcriptUrl = written.publicUrl;
              result.transcriptText = text.length > 5000 ? text.slice(0,5000) + '\n\n...[truncated]' : text;
            } catch (e) {
              console.error('[upload/audio] could not write google transcript', e && e.message);
            }

            try {
              const jsonFile = `${basename}.transcription.google.longrunning.json`;
              const written = writeUploadFile(jsonFile, JSON.stringify(opResp, null, 2), 'utf8');
              result.transcriptionJsonUrl = written.publicUrl;
            } catch (e) { /* ignore */ }

            if (verbatimRequested && gbody.results) {
              const words = [];
              for (const r of gbody.results) {
                const alt = r.alternatives && r.alternatives[0];
                if (!alt) continue;
                if (alt.words && Array.isArray(alt.words)) {
                  for (const w of alt.words) words.push(w.word);
                }
              }
              if (words.length) {
                const vfn = `${basename}.verbatim.txt`;
                try {
                  const written = writeUploadFile(vfn, words.join(' '), 'utf8');
                  result.verbatimAvailable = true;
                  result.verbatimUrl = written.publicUrl;
                } catch (e) {}
              }
            }
          } else {
            result.transcriptAvailable = false;
            result.message = 'Google longrunning transcription returned empty text';
          }

          return res.json(result);
        } else {
          // Synchronous recognize for short audio
          const googleReq = { config, audio: { content: b64 } };
          const gres = await axios.post(`https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(GOOGLE_KEY)}`, googleReq, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 120000
          });

          const gbody = gres.data || {};
          let text = '';
          if (gbody.results && Array.isArray(gbody.results) && gbody.results.length) {
            text = gbody.results.map(r => (r.alternatives && r.alternatives[0] && r.alternatives[0].transcript) || '').join(' ').trim();
          }

          if (text) {
            const transcriptFilename = `${basename}.txt`;
            try {
              const written = writeUploadFile(transcriptFilename, text, 'utf8');
              result.transcriptAvailable = true;
              result.transcriptUrl = written.publicUrl;
              result.transcriptText = text.length > 5000 ? text.slice(0,5000) + '\n\n...[truncated]' : text;
            } catch (e) { console.error('[upload/audio] could not write google sync transcript', e && e.message); }

            try {
              const jsonFile = `${basename}.transcription.google.json`;
              const written = writeUploadFile(jsonFile, JSON.stringify(gbody, null, 2), 'utf8');
              result.transcriptionJsonUrl = written.publicUrl;
            } catch (e) { }

            if (verbatimRequested && gbody.results) {
              const words = [];
              for (const r of gbody.results) {
                const alt = r.alternatives && r.alternatives[0];
                if (!alt) continue;
                if (alt.words && Array.isArray(alt.words)) {
                  for (const w of alt.words) words.push(w.word);
                }
              }
              if (words.length) {
                const vfn = `${basename}.verbatim.txt`;
                try { const written = writeUploadFile(vfn, words.join(' '), 'utf8'); result.verbatimAvailable = true; result.verbatimUrl = written.publicUrl; } catch (e) {}
              }
            }
          } else {
            result.transcriptAvailable = false;
            result.message = 'Google transcription returned empty text';
          }

          return res.json(result);
        }
      }

      // Note: OpenAI transcription support has been removed. If you need
      // server-side transcription for non-wav containers, implement a GCS
      // upload + Google longrunningrecognize flow or extract audio client-side
      // and POST to this endpoint.
      res.json(result);
    } catch (err) {
      console.error('Transcription error', err && err.response ? err.response.data : err.message || err);
      res.json({ transcriptAvailable: false, message: 'Transcription failed: ' + (err && err.response && err.response.data ? JSON.stringify(err.response.data) : (err.message || 'unknown')) });
    }

// Accept raw audio bytes (application/octet-stream or audio/wav) in the request
// body. This avoids multipart parsing differences on serverless hosts like
// Vercel where multer may not always find uploaded files. The client should
// POST the raw bytes (fetch body = ArrayBuffer or Blob) to this endpoint.
app.post('/upload/audio-raw', async (req, res) => {
  try {
    // Read raw request body into a buffer
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    if (!buf || buf.length === 0) return res.status(400).json({ error: 'No file uploaded' });

    // Determine a filename (client can provide 'x-filename' header)
    const headerName = (req.headers['x-filename'] || req.headers['x_file_name'] || `upload-${Date.now()}.wav`);
    const safeName = String(headerName).replace(/[^a-z0-9.\-_%~()\[\]{}@!$\^&+=,;:\s]/i, '_');
    const filename = Date.now() + '-' + safeName;

    // Attempt Blob upload first (avoid writing to disk in serverless)
    const prefix = process.env.BLOB_PREFIX || 'uploads/';
    let playbackUrl = null;
    try { playbackUrl = await uploadToVercelBlob(buf, prefix + filename, req.headers['content-type']); } catch (e) { console.warn('[upload/audio-raw] blob upload failed', e && e.message); }
    const basename = filename.replace(/\.[^/.]+$/, '');
    const result = {};
    if (playbackUrl) { result.playbackUrl = playbackUrl; result.url = playbackUrl; result.storage = 'blob'; }
    else {
      // Fallback: write to temp (not publicly served unless mapped)
      const tmpPath = path.join(os.tmpdir(), filename);
      try { fs.writeFileSync(tmpPath, buf); result.tempPath = tmpPath; } catch (e) { console.error('[upload/audio-raw] temp write failed', e && e.message); }
    }

    // Detect configured transcription keys
    const GOOGLE_KEY = process.env.GOOGLE_API_KEY || null;
    const ASSEMBLY_KEY = process.env.ASSEMBLY_API_KEY || process.env.ASSEMBLYAI_API_KEY || null;

    try {
  console.log(`[upload/audio-raw] received file=${filename} size=${buf.length} GOOGLE_KEY=${!!GOOGLE_KEY} ASSEMBLY_KEY=${!!ASSEMBLY_KEY} blob=${!!playbackUrl}`);

      if (!GOOGLE_KEY && !ASSEMBLY_KEY) {
        result.transcriptAvailable = false;
        result.message = 'Upload succeeded. Set GOOGLE_API_KEY or ASSEMBLY_API_KEY in the server environment to enable automatic transcription.';
        return res.json(result);
      }

      const verbatimRequested = req.headers['x-verbatim'] === '1' || req.headers['x-verbatim'] === 'true';

      if (ASSEMBLY_KEY) {
        // Prefer uploading to Vercel Blob (if configured) so the resulting
        // URL is served with proper headers and is directly playable in the
        // browser. If Blob upload is unavailable we'll fall back to uploading
        // to AssemblyAI and let AssemblyAI return an upload URL.
        // Reuse earlier blob URL if present
        let blobUrl = playbackUrl;

        let uploadUrl = null;
        if (blobUrl) {
          uploadUrl = blobUrl;
        } else {
          try {
            const upRes = await axios.post('https://api.assemblyai.com/v2/upload', buf, {
              headers: { Authorization: ASSEMBLY_KEY, 'Content-Type': 'application/octet-stream' },
              maxBodyLength: Infinity,
              timeout: 120000
            });
            uploadUrl = (upRes.data && (upRes.data.upload_url || upRes.data.url)) || upRes.data;
          } catch (e) {
            console.error('[upload/audio-raw] AssemblyAI upload failed', e && (e.response ? e.response.data : e.message || e));
            result.transcriptAvailable = false;
            result.message = 'AssemblyAI upload failed: ' + (e && e.response && e.response.data ? JSON.stringify(e.response.data) : (e.message || 'unknown'));
            return res.json(result);
          }
        }

        // Create transcript job and return immediately
        let transcriptId = null;
        try {
          const createResp = await axios.post('https://api.assemblyai.com/v2/transcript', {
            audio_url: uploadUrl,
            punctuate: true,
            format_text: true
          }, {
            headers: { Authorization: ASSEMBLY_KEY, 'Content-Type': 'application/json' },
            timeout: 120000
          });
          transcriptId = createResp.data && createResp.data.id;
        } catch (e) {
          console.error('[upload/audio-raw] AssemblyAI create transcript failed', e && (e.response ? e.response.data : e.message || e));
          result.transcriptAvailable = false;
          result.message = 'AssemblyAI create transcript failed: ' + (e && e.response && e.response.data ? JSON.stringify(e.response.data) : (e.message || 'unknown'));
          return res.json(result);
        }

        result.transcriptAvailable = false;
        result.transcriptId = transcriptId;
        if (!result.message) result.message = 'Transcription job created; poll /transcript/status/:id for updates.';
        return res.json(result);
      }

      // Google transcription flow (short/long) - reuse same logic as /upload/audio
      if (GOOGLE_KEY) {
        const statSize = buf.length;
        const useLong = statSize > (5 * 1024 * 1024);
        const b64 = buf.toString('base64');
        const languageCode = req.headers['x-language-code'] || 'en-US';
        const config = {
          encoding: 'LINEAR16',
          sampleRateHertz: 16000,
          languageCode: languageCode,
          enableWordTimeOffsets: !!verbatimRequested,
          enableAutomaticPunctuation: true
        };

        if (useLong) {
          const longReq = { config, audio: { content: b64 } };
          const lres = await axios.post(`https://speech.googleapis.com/v1/speech:longrunningrecognize?key=${encodeURIComponent(GOOGLE_KEY)}`, longReq, { headers: { 'Content-Type': 'application/json' }, timeout: 120000 });
          const opName = lres.data && (lres.data.name || (lres.data.operation && lres.data.operation.name));
          if (!opName) { result.transcriptAvailable = false; result.message = 'Could not start longrunning transcription (no operation name returned)'; return res.json(result); }

          const start = Date.now(); const timeoutMs = 5 * 60 * 1000; let opResp = null;
          while (true) {
            await new Promise(r => setTimeout(r, 2000));
            const poll = await axios.get(`https://speech.googleapis.com/v1/operations/${encodeURIComponent(opName)}?key=${encodeURIComponent(GOOGLE_KEY)}`, { timeout: 120000 });
            opResp = poll.data || {};
            if (opResp.done) break;
            if (Date.now() - start > timeoutMs) { result.transcriptAvailable = false; result.message = 'Longrunning transcription timed out'; return res.json(result); }
          }

          const gbody = (opResp.response && opResp.response) || opResp;
          let text = '';
          if (gbody && gbody.results && Array.isArray(gbody.results) && gbody.results.length) text = gbody.results.map(r => (r.alternatives && r.alternatives[0] && r.alternatives[0].transcript) || '').join(' ').trim();

          if (text) {
            try { const transcriptFilename = `${basename}.txt`; const written = writeUploadFile(transcriptFilename, text, 'utf8'); result.transcriptAvailable = true; result.transcriptUrl = written.publicUrl; result.transcriptText = text.length > 5000 ? text.slice(0,5000) + '\n\n...[truncated]' : text; } catch (e) { console.error('[upload/audio-raw] could not write google transcript', e && e.message); }
          } else { result.transcriptAvailable = false; result.message = 'Google longrunning transcription returned empty text'; }

          return res.json(result);
        } else {
          const googleReq = { config, audio: { content: b64 } };
          const gres = await axios.post(`https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(GOOGLE_KEY)}`, googleReq, { headers: { 'Content-Type': 'application/json' }, timeout: 120000 });
          const gbody = gres.data || {};
          let text = '';
          if (gbody.results && Array.isArray(gbody.results) && gbody.results.length) text = gbody.results.map(r => (r.alternatives && r.alternatives[0] && r.alternatives[0].transcript) || '').join(' ').trim();
          if (text) {
            try { const transcriptFilename = `${basename}.txt`; const written = writeUploadFile(transcriptFilename, text, 'utf8'); result.transcriptAvailable = true; result.transcriptUrl = written.publicUrl; result.transcriptText = text.length > 5000 ? text.slice(0,5000) + '\n\n...[truncated]' : text; } catch (e) { console.error('[upload/audio-raw] could not write google sync transcript', e && e.message); }
          } else { result.transcriptAvailable = false; result.message = 'Google transcription returned empty text'; }
          return res.json(result);
        }
      }

      return res.json(result);
    } catch (err) {
      console.error('Transcription error (raw)', err && err.response ? err.response.data : err.message || err);
      return res.json({ transcriptAvailable: false, message: 'Transcription failed: ' + (err && err.response && err.response.data ? JSON.stringify(err.response.data) : (err.message || 'unknown')) });
    }
  } catch (err) {
    console.error('Audio raw upload error', err);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// Upload a video file (served from /public/uploads afterwards)
app.post('/upload/video', uploadVideo.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Determine filesystem path and public URL (if written to public/uploads)
    const uploadedPath = (req.file && req.file.path) ? req.file.path : path.join(__dirname, 'public', 'uploads', req.file.filename);
    const publicUploadsDir = path.join(__dirname, 'public', 'uploads');
    const publicUrl = uploadedPath && uploadedPath.startsWith(publicUploadsDir) ? `/uploads/${req.file.filename}` : null;

    const result = { url: publicUrl };

    const ASSEMBLY_KEY = process.env.ASSEMBLY_API_KEY || process.env.ASSEMBLYAI_API_KEY || null;
    const GOOGLE_KEY = process.env.GOOGLE_API_KEY || null;

    try {
      const st = uploadedPath && fs.existsSync(uploadedPath) ? fs.statSync(uploadedPath) : null;
      console.log(`[upload/video] received file=${req.file.filename} path=${uploadedPath} size=${st ? st.size : 'unknown'} GOOGLE_KEY=${!!GOOGLE_KEY} ASSEMBLY_KEY=${!!ASSEMBLY_KEY}`);
    } catch (e) {
      console.log('[upload/video] stat failed', req.file && req.file.filename, 'err=', e && e.message);
    }

    if (ASSEMBLY_KEY) {
      // Upload container to AssemblyAI and create a transcript job
      if (!uploadedPath || !fs.existsSync(uploadedPath)) {
        result.transcriptAvailable = false;
        result.message = 'Uploaded file not found on server. In serverless environments files are stored in a temp directory; try client-side extraction or set FALLBACK_UPLOAD_DIR.';
        console.error('[upload/video] file not found at', uploadedPath);
        return res.json(result);
      }

      try {
        const buf = fs.readFileSync(uploadedPath);
        const upRes = await axios.post('https://api.assemblyai.com/v2/upload', buf, {
          headers: { Authorization: ASSEMBLY_KEY, 'Content-Type': 'application/octet-stream' },
          maxBodyLength: Infinity,
          timeout: 120000
        });
        const uploadUrl = (upRes.data && (upRes.data.upload_url || upRes.data.url)) || upRes.data;

        const createResp = await axios.post('https://api.assemblyai.com/v2/transcript', {
          audio_url: uploadUrl,
          punctuate: true,
          format_text: true
        }, { headers: { Authorization: ASSEMBLY_KEY, 'Content-Type': 'application/json' }, timeout: 120000 });

        const transcriptId = createResp.data && createResp.data.id;
        if (!transcriptId) {
          result.transcriptAvailable = false;
          result.message = 'Could not create AssemblyAI transcription job';
          return res.json(result);
        }

        // If we couldn't serve the uploaded file from our public uploads
        // directory (common on serverless platforms), fall back to returning
        // the external upload URL returned by AssemblyAI so the client has
        // something to load for playback. Note: external URLs may be
        // temporary and may have CORS restrictions preventing direct
        // playback; using S3/GCS with presigned uploads is more robust.
        if (!result.url && uploadUrl && typeof uploadUrl === 'string' && uploadUrl.startsWith('http')) {
          result.url = uploadUrl;
          result.assemblyUploadUrl = uploadUrl;
        }

        result.transcriptAvailable = false;
        result.transcriptId = transcriptId;
        result.message = 'Transcription job created; poll /transcript/status/:id for updates.';
        return res.json(result);
      } catch (e) {
        console.error('[upload/video] AssemblyAI error', e && (e.response ? e.response.data : e.message || e));
        result.transcriptAvailable = false;
        result.message = 'AssemblyAI transcription error: ' + (e && e.response && e.response.data ? JSON.stringify(e.response.data) : (e.message || 'unknown'));
        return res.json(result);
      }
    }

    // No server-side transcription provider available for video
    result.transcriptAvailable = false;
    result.message = 'Upload succeeded. Transcription is disabled on the server. Extract audio client-side and POST the WAV to /upload/audio, or set ASSEMBLY_API_KEY in the server environment.';
    return res.json(result);
  } catch (err) {
    console.error('Video upload error', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Accept raw video bytes (application/octet-stream or video/*) in the request
// body. This avoids multipart parsing differences on serverless hosts like
// Vercel where multer may not always find uploaded files. The client should
// POST the raw bytes (fetch body = ArrayBuffer or Blob) to this endpoint.
app.post('/upload/video-raw', async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    if (!buf || buf.length === 0) return res.status(400).json({ error: 'No file uploaded' });

    const headerName = (req.headers['x-filename'] || req.headers['x_file_name'] || `upload-${Date.now()}.mp4`);
    const safeName = String(headerName).replace(/[^a-z0-9.\-_%~()\[\]{}@!$\^&+=,;:\s]/i, '_');
    const filename = Date.now() + '-' + safeName;

    const prefix = process.env.BLOB_PREFIX || 'uploads/';
    let playbackUrl = null;
    try { playbackUrl = await uploadToVercelBlob(buf, prefix + filename, req.headers['content-type']); } catch (e) { console.warn('[upload/video-raw] blob upload failed', e && e.message); }
    const basename = filename.replace(/\.[^/.]+$/, '');
    const result = {};
    if (playbackUrl) { result.playbackUrl = playbackUrl; result.url = playbackUrl; result.storage = 'blob'; }
    else {
      const tmpPath = path.join(os.tmpdir(), filename);
      try { fs.writeFileSync(tmpPath, buf); result.tempPath = tmpPath; } catch (e) { console.error('[upload/video-raw] temp write failed', e && e.message); }
    }

    const GOOGLE_KEY = process.env.GOOGLE_API_KEY || null;
    const ASSEMBLY_KEY = process.env.ASSEMBLY_API_KEY || process.env.ASSEMBLYAI_API_KEY || null;

    try {
  console.log(`[upload/video-raw] received file=${filename} size=${buf.length} GOOGLE_KEY=${!!GOOGLE_KEY} ASSEMBLY_KEY=${!!ASSEMBLY_KEY} blob=${!!playbackUrl}`);

      if (!GOOGLE_KEY && !ASSEMBLY_KEY) {
        result.transcriptAvailable = false;
        result.message = 'Upload succeeded. Set GOOGLE_API_KEY or ASSEMBLY_API_KEY in the server environment to enable automatic transcription.';
        return res.json(result);
      }

      if (ASSEMBLY_KEY) {
        // Prefer uploading to Vercel Blob if configured
        // Reuse earlier blob URL if present
        let blobUrl = playbackUrl;

        let uploadUrl = null;
        if (blobUrl) {
          uploadUrl = blobUrl;
        } else {
          try {
            const upRes = await axios.post('https://api.assemblyai.com/v2/upload', buf, {
              headers: { Authorization: ASSEMBLY_KEY, 'Content-Type': 'application/octet-stream' },
              maxBodyLength: Infinity,
              timeout: 120000
            });
            uploadUrl = (upRes.data && (upRes.data.upload_url || upRes.data.url)) || upRes.data;
          } catch (e) {
            console.error('[upload/video-raw] AssemblyAI upload failed', e && (e.response ? e.response.data : e.message || e));
            result.transcriptAvailable = false;
            result.message = 'AssemblyAI upload failed: ' + (e && e.response && e.response.data ? JSON.stringify(e.response.data) : (e.message || 'unknown'));
            return res.json(result);
          }
        }

        let transcriptId = null;
        try {
          const createResp = await axios.post('https://api.assemblyai.com/v2/transcript', {
            audio_url: uploadUrl,
            punctuate: true,
            format_text: true
          }, {
            headers: { Authorization: ASSEMBLY_KEY, 'Content-Type': 'application/json' },
            timeout: 120000
          });
          transcriptId = createResp.data && createResp.data.id;
        } catch (e) {
          console.error('[upload/video-raw] AssemblyAI create transcript failed', e && (e.response ? e.response.data : e.message || e));
          result.transcriptAvailable = false;
          result.message = 'AssemblyAI create transcript failed: ' + (e && e.response && e.response.data ? JSON.stringify(e.response.data) : (e.message || 'unknown'));
          return res.json(result);
        }

        // If we couldn't serve the uploaded file from our public uploads
        // directory (common on serverless platforms), or if we used the
        // AssemblyAI upload URL, set result.url accordingly.
        if (!result.url && uploadUrl && typeof uploadUrl === 'string' && uploadUrl.startsWith('http')) {
          result.url = uploadUrl;
          result.assemblyUploadUrl = uploadUrl;
        }

        result.transcriptAvailable = false;
        result.transcriptId = transcriptId;
        if (!result.message) result.message = 'Transcription job created; poll /transcript/status/:id for updates.';
        return res.json(result);
      }

      // If Google transcription is configured, we could upload the file and call longrunningrecognize
      // but video containers typically require extracting audio; prefer AssemblyAI or client-side extraction.
      result.transcriptAvailable = false;
      result.message = 'Upload succeeded but no transcription provider configured.';
      return res.json(result);
    } catch (err) {
      console.error('Video raw transcription error', err && err.response ? err.response.data : err.message || err);
      return res.status(500).json({ error: 'Transcription failed' });
    }
  } catch (err) {
    console.error('Video raw upload error', err);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// Lightweight status endpoint so the client can poll AssemblyAI job status by id
app.get('/transcript/status/:id', async (req, res) => {
  const id = req.params && req.params.id;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const ASSEMBLY_KEY = process.env.ASSEMBLY_API_KEY || process.env.ASSEMBLYAI_API_KEY || null;
  if (!ASSEMBLY_KEY) return res.status(400).json({ error: 'No ASSEMBLY_API_KEY configured on server' });
  try {
    const resp = await axios.get(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(id)}`, { headers: { Authorization: ASSEMBLY_KEY }, timeout: 120000 });
    const body = resp.data || {};
    // Return a compact status object
    return res.json({ id: body.id, status: body.status, text: body.text || null, error: body.error || null, raw: body });
  } catch (e) {
    console.error('/transcript/status error', e && (e.response ? e.response.data : e.message || e));
    return res.status(500).json({ error: 'Could not fetch transcript status', details: e && e.response && e.response.data ? e.response.data : (e.message || String(e)) });
  }
});

// Proxy an external video URL so the browser can load it with correct CORS
// and Content-Type headers. Useful for testing AssemblyAI upload URLs which
// may not include playback-friendly headers. Example: /proxy/video?src=<url>
app.get('/proxy/video', async (req, res) => {
  try {
    const src = req.query && req.query.src;
    if (!src || typeof src !== 'string') return res.status(400).send('Missing src');
    // Basic validation: must be https
    if (!/^https:\/\//i.test(src)) return res.status(400).send('Invalid src');

    // Forward Range header if present so streaming/seeking works
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;

  // Fetch as stream. Some CDN endpoints may present certificate hostnames
  // that fail verification in this environment; allow falling back to an
  // insecure agent for the proxy request so we can test playback. In a
  // hardened production environment you may want to remove this and only
  // allow verified TLS.
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });
  const upstream = await axios.get(src, { responseType: 'stream', headers, timeout: 120000, httpsAgent });

    // Copy selected headers to the response
    const copyHeaders = ['content-type', 'content-length', 'accept-ranges', 'content-range', 'cache-control', 'last-modified'];
    for (const h of copyHeaders) {
      if (upstream.headers && upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    }
    // Ensure CORS for browser playback
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');

    // Pipe the stream. Preserve upstream status (200 or 206)
    res.status(upstream.status);
    upstream.data.pipe(res);
  } catch (e) {
    console.error('/proxy/video error', e && (e.response ? e.response.data || e.response.status : e.message || e));
    return res.status(500).send('Proxy error');
  }
});

// Diagnostic inspector for remote upload URLs. This is intended to be a
// short-lived debugging helper to check headers, range support and the
// first bytes of an AssemblyAI CDN upload URL. It restricts hosts to the
// AssemblyAI CDN to reduce SSRF risk.
app.get('/debug/inspect', async (req, res) => {
  try {
    const src = req.query && req.query.src;
    if (!src || typeof src !== 'string') return res.status(400).json({ error: 'Missing src query parameter' });

    let parsed;
    try { parsed = new URL(src); } catch (e) { return res.status(400).json({ error: 'Invalid URL' }); }

    // Only allow AssemblyAI CDN hosts (adjust if you need other hosts)
    const allowedHosts = ['cdn.assemblyai.com'];
    if (!allowedHosts.includes(parsed.hostname)) return res.status(400).json({ error: 'Host not allowed for inspection' });

    const httpsAgent = new https.Agent({ rejectUnauthorized: false }); // testing-purpose only

    // 1) HEAD
    let headResp = null;
    try {
      headResp = await axios.head(src, { timeout: 15000, httpsAgent, validateStatus: () => true });
    } catch (e) {
      // capture error and continue
      console.error('/debug/inspect HEAD failed', e && (e.response ? e.response.status : e.message || e));
    }

    // 2) small ranged GET (first 128 bytes)
    let firstBytes = null;
    let rangeResp = null;
    try {
      rangeResp = await axios.get(src, { responseType: 'arraybuffer', headers: { Range: 'bytes=0-127' }, timeout: 20000, httpsAgent, validateStatus: () => true });
      if (rangeResp && rangeResp.data) firstBytes = Buffer.from(rangeResp.data);
    } catch (e) {
      console.error('/debug/inspect ranged GET failed', e && (e.response ? e.response.status : e.message || e));
    }

    // 3) full-range support check (ask for tiny range and record status)
    let rangeCheck = null;
    try {
      const rc = await axios.get(src, { responseType: 'stream', headers: { Range: 'bytes=0-1' }, timeout: 15000, httpsAgent, validateStatus: () => true });
      rangeCheck = { status: rc.status, headers: rc.headers };
      // close stream if present
      if (rc && rc.data && rc.data.destroy) rc.data.destroy();
    } catch (e) {
      console.error('/debug/inspect range check failed', e && (e.response ? e.response.status : e.message || e));
    }

    const out = {
      url: src,
      headStatus: headResp ? headResp.status : null,
      headHeaders: headResp && headResp.headers ? headResp.headers : null,
      rangeStatus: rangeResp ? rangeResp.status : null,
      rangeHeaders: rangeResp && rangeResp.headers ? rangeResp.headers : null,
      rangeCheck: rangeCheck,
      firstBytesHex: firstBytes ? firstBytes.toString('hex').slice(0, 1024) : null,
      firstBytesBase64: firstBytes ? firstBytes.toString('base64') : null,
      firstBytesLength: firstBytes ? firstBytes.length : 0
    };

    return res.json(out);
  } catch (err) {
    console.error('/debug/inspect error', err && (err.response ? err.response.data : err.message || err));
    return res.status(500).json({ error: 'Inspection failed', details: err && err.message });
  }
});

// Cleanup task: remove files in public/uploads older than KEEP_DAYS days
const KEEP_DAYS = parseInt(process.env.UPLOAD_KEEP_DAYS || '7', 10);
async function cleanupUploads() {
  try {
    const dir = path.join(__dirname, 'public', 'uploads');
    const files = fs.readdirSync(dir);
    const now = Date.now();
    const cutoff = KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        const age = now - st.mtimeMs;
        if (age > cutoff) {
          fs.unlinkSync(full);
          console.log('Removed old upload:', full);
        }
      } catch (e) {
        // ignore per-file errors
      }
    }
  } catch (err) {
    console.error('Error during cleanupUploads', err);
  }
}

// Schedule cleanup once a day at 03:30
try {
  schedule.scheduleJob('30 3 * * *', cleanupUploads);
} catch (e) {
  // scheduling may fail in some environments, that's ok
  console.warn('Could not schedule cleanup job:', e && e.message);
}

app.get('/', (req, res) => {
  // Landing page: determine provider so the client can default to client-side
  // extraction when Google transcription is configured.
  const ASSEMBLY_KEY = process.env.ASSEMBLY_API_KEY || process.env.ASSEMBLYAI_API_KEY || null;
  const GOOGLE_KEY = process.env.GOOGLE_API_KEY || null;
  const provider = ASSEMBLY_KEY ? 'assembly' : (GOOGLE_KEY ? 'google' : 'none');
  res.render('index', { example: '', provider });
});

// Spotify support removed; YouTube embed is client-side only.

// Accept either a URL to an .ics feed or an uploaded .ics file
app.post('/convert', upload.single('icsfile'), async (req, res) => {
  try {
    let rawICS;

    if (req.body.icsurl && req.body.icsurl.trim()) {
      const url = req.body.icsurl.trim();
      console.log('[convert] using ics URL:', url);
      const resp = await axios.get(url, { responseType: 'text' });
      rawICS = resp.data;
    } else if (req.file) {
      console.log('[convert] received uploaded file:', req.file && ({ originalname: req.file.originalname, filename: req.file.filename, size: req.file.size || (req.file.buffer && req.file.buffer.length) }));
      // multer may be configured with diskStorage (writes file to disk) or
      // memoryStorage (provides buffer). Support both.
      try {
        if (req.file.buffer && req.file.buffer.length) {
          rawICS = req.file.buffer.toString('utf8');
        } else if (req.file.path && fs.existsSync(req.file.path)) {
          rawICS = fs.readFileSync(req.file.path, 'utf8');
        } else if (req.file.filename) {
          // Try common locations: first ./public/uploads (local dev), then OS temp dir (serverless)
          const localP = path.join(__dirname, 'public', 'uploads', req.file.filename);
          const tmpP = path.join(os.tmpdir(), req.file.filename);
          if (fs.existsSync(localP)) rawICS = fs.readFileSync(localP, 'utf8');
          else if (fs.existsSync(tmpP)) rawICS = fs.readFileSync(tmpP, 'utf8');
        }
      } catch (e) {
        console.error('[convert] error reading uploaded ICS file', e && e.message);
      }
      if (!rawICS) return res.status(400).send('No ICS URL or file provided');
    } else {
      return res.status(400).send('No ICS URL or file provided');
    }

    // parse with node-ical
    let parsed;
    try {
      parsed = ical.sync.parseICS(rawICS);
    } catch (e) {
      console.error('[convert] Failed to parse ICS:', e && e.message);
      // include a bit of the uploaded content for debugging (trimmed)
      try {
        const sample = typeof rawICS === 'string' ? rawICS.slice(0, 1000) : String(rawICS);
        console.error('[convert] Raw ICS sample:', sample.replace(/\r?\n/g, '\\n'));
      } catch (ee) {}
      return res.status(400).send('Invalid ICS content (could not parse)');
    }

    // convert events to ics package format
    const events = [];

    for (const k of Object.keys(parsed)) {
      const ev = parsed[k];
      if (ev && ev.type === 'VEVENT') {
        // build start and end arrays: [YYYY, M, D, H, m]
        const start = ev.start instanceof Date ? [ev.start.getFullYear(), ev.start.getMonth() + 1, ev.start.getDate(), ev.start.getHours(), ev.start.getMinutes()] : null;
        const end = ev.end instanceof Date ? [ev.end.getFullYear(), ev.end.getMonth() + 1, ev.end.getDate(), ev.end.getHours(), ev.end.getMinutes()] : null;

        const description = ev.description || ev.summary || '';

        const event = {
          title: ev.summary || 'Untitled',
          start: start || undefined,
          end: end || undefined,
          description: description,
          uid: ev.uid || undefined,
          location: ev.location || undefined
        };

        events.push(event);
      }
    }

    if (events.length === 0) return res.status(404).send('No events found in ICS');

    // create ICS content
    createEvents(events, (error, value) => {
      if (error) {
        console.error(error);
        return res.status(500).send('Error creating ICS');
      }

      // Send as downloadable .ics file
      res.setHeader('Content-disposition', 'attachment; filename=brightspace-export.ics');
      res.setHeader('Content-Type', 'text/calendar');
      res.send(value);
    });

  } catch (err) {
    console.error(err);
    res.status(500).send('Server error: ' + err.message);
  }
});

// Preview route: accept the manual form, save an uploaded backdrop (if any), and render confirmation
app.post('/preview', upload.single('backdropFile'), async (req, res) => {
  try {
    const title = req.body.title || 'Untitled';
    const type = req.body.type || '';
    const percentage = req.body.percentage || '';
    const dueDateStr = req.body.dueDate;
    const allocateMinutes = req.body.allocateMinutes || '';
    const reminders = req.body.reminders || '';
    const dailyReminders = req.body.dailyReminders === 'yes' || req.body.dailyReminders === 'on';
    const dailyTime = req.body.dailyTime || '09:00';
    const email = req.body.email || '';
    const worth = req.body.worth || '';
    const classCode = req.body.classCode || '';
    const youtube = req.body.youtube || '';
    const spotify = req.body.spotify || '';
    const includeMediaInEvent = req.body.includeMediaInEvent === 'yes' || req.body.includeMediaInEvent === 'on';

    // determine backdrop public URL (uploaded file or provided URL)
    let backdropPublicUrl = req.body.backdropUrl && req.body.backdropUrl.trim();
    let backdropFileName = '';
    if (req.file && req.file.filename) {
      backdropFileName = req.file.filename;
      backdropPublicUrl = `/uploads/${req.file.filename}`;
    }

    // Create a readable details string
    const detailsArr = [];
    detailsArr.push(`Type: ${type}`);
    if (percentage) detailsArr.push(`Percentage: ${percentage}`);
    if (worth) detailsArr.push(`Worth: ${worth}`);
    if (classCode) detailsArr.push(`Class: ${classCode}`);
    detailsArr.push(`Due: ${dueDateStr}`);
    if (allocateMinutes) detailsArr.push(`Allocate (minutes): ${allocateMinutes}`);
    if (reminders) detailsArr.push(`One-off reminders (min before): ${reminders}`);
    detailsArr.push(`Daily reminders: ${dailyReminders ? 'Yes' : 'No'} at ${dailyTime}`);
    if (email) detailsArr.push(`Email: ${email}`);
    if (includeMediaInEvent) {
      if (backdropPublicUrl) detailsArr.push(`Backdrop: ${backdropPublicUrl}`);
      if (youtube) detailsArr.push(`YouTube: ${youtube}`);
      if (spotify) detailsArr.push(`Spotify: ${spotify}`);
    }

    // prepare embed URLs
    let youtubeEmbed = '';
    if (youtube) {
      // convert common youtube urls to embed form
      const m = youtube.match(/v=([^&]+)/);
      const id = m ? m[1] : (youtube.split('youtu.be/')[1] || '');
      if (id) youtubeEmbed = `https://www.youtube.com/embed/${id}`;
    }

    let spotifyEmbed = '';
    if (spotify) {
      // assume user provided an embed URL or a track URL; try to coerce
      if (spotify.includes('embed')) spotifyEmbed = spotify;
      else if (spotify.includes('track') || spotify.includes('playlist') || spotify.includes('album')) {
        // users may paste a normal spotify URL; convert to embed
        spotifyEmbed = spotify.replace('open.spotify.com', 'open.spotify.com/embed');
      }
    }

    res.render('preview', {
      title,
      type,
      percentage,
      dueDateISO: dueDateStr,
      dueDate: dueDateStr,
      allocateMinutes,
      reminders,
      dailyReminders,
      dailyTime,
      email,
      worth,
      classCode,
      backdrop: backdropPublicUrl,
      backdropFileName,
      youtube,
      spotify,
      includeMediaInEvent,
      youtubeEmbed,
      spotifyEmbed,
      details: detailsArr.join('\n')
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error preparing preview: ' + err.message);
  }
});

// Create a custom event from user fields and optionally schedule email reminders
app.post('/create', upload.single('backdropFile'), async (req, res) => {
  try {
    const title = req.body.title || 'Untitled';
    const type = req.body.type || '';
    const percentage = req.body.percentage || '';
    const dueDateStr = req.body.dueDate;
    const allocateMinutes = parseInt(req.body.allocateMinutes || '0', 10);
    const remindersStr = req.body.reminders || '';
    const dailyReminders = req.body.dailyReminders === 'yes' || req.body.dailyReminders === 'on' || req.body.dailyReminders === 'true';
    const dailyTime = req.body.dailyTime || '09:00';
    const email = req.body.email && req.body.email.trim();
    const worth = req.body.worth || '';
    const classCode = req.body.classCode || '';
    const backdropUrl = req.body.backdropUrl && req.body.backdropUrl.trim();
    const youtube = req.body.youtube && req.body.youtube.trim();
    const spotify = req.body.spotify && req.body.spotify.trim();
    const includeMediaInEvent = req.body.includeMediaInEvent === 'yes' || req.body.includeMediaInEvent === 'on' || req.body.includeMediaInEvent === 'true';

    // If a backdrop file was uploaded (or passed from preview), build its public URL
    let backdropPublicUrl = null;
    // priority: newly uploaded file (req.file), then backdropFileName from form (preview), then backdropUrl
    if (req.file && req.file.filename) {
      backdropPublicUrl = `/uploads/${req.file.filename}`;
    } else if (req.body.backdropFileName) {
      backdropPublicUrl = `/uploads/${req.body.backdropFileName}`;
    } else if (backdropUrl) {
      backdropPublicUrl = backdropUrl;
    }

    if (!dueDateStr) return res.status(400).send('Missing due date');

    const dueDate = new Date(dueDateStr);
    if (isNaN(dueDate.getTime())) return res.status(400).send('Invalid due date');

    // Build description with the new fields
    const descriptionParts = [];
    if (type) descriptionParts.push(`Type: ${type}`);
    if (percentage) descriptionParts.push(`Percentage: ${percentage}`);
    if (worth) descriptionParts.push(`Worth: ${worth}`);
    if (classCode) descriptionParts.push(`Class: ${classCode}`);
    if (includeMediaInEvent) {
      if (backdropPublicUrl) descriptionParts.push(`Backdrop: ${backdropPublicUrl}`);
      if (youtube) descriptionParts.push(`YouTube: ${youtube}`);
      if (spotify) descriptionParts.push(`Spotify: ${spotify}`);
    }
    const description = descriptionParts.join('\n');

    // Build event objects: due event, and optional work allocation event
    const events = [];

    const dueStart = [dueDate.getFullYear(), dueDate.getMonth() + 1, dueDate.getDate(), dueDate.getHours(), dueDate.getMinutes()];
    const dueEvent = {
      title: `${title} (Due)` ,
      start: dueStart,
      description: description,
      location: '',
    };
    events.push(dueEvent);

    if (allocateMinutes > 0) {
      const allocEnd = new Date(dueDate.getTime());
      const allocStartDate = new Date(dueDate.getTime() - allocateMinutes * 60000);
      const allocStart = [allocStartDate.getFullYear(), allocStartDate.getMonth() + 1, allocStartDate.getDate(), allocStartDate.getHours(), allocStartDate.getMinutes()];
      const allocEndArr = [allocEnd.getFullYear(), allocEnd.getMonth() + 1, allocEnd.getDate(), allocEnd.getHours(), allocEnd.getMinutes()];
      events.push({
        title: `Allocate ${allocateMinutes}m for ${title}`,
        start: allocStart,
        end: allocEndArr,
        description: `Planned work time for ${title}` + (description ? `\n\n${description}` : ''),
      });
    }

    // schedule email reminders if SMTP configured and an email is provided
    const smtpConfigured = process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS;
    const reminders = remindersStr.split(',').map(s => s.trim()).filter(Boolean).map(s => parseInt(s, 10)).filter(n => !isNaN(n) && n >= 0);

    if (email && smtpConfigured) {
      // create transporter
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT, 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });

      // one-off reminders (minutes before due)
      if (reminders.length > 0) {
        for (const minutesBefore of reminders) {
          const when = new Date(dueDate.getTime() - minutesBefore * 60000);
          if (when.getTime() <= Date.now()) {
            console.log(`Skipping reminder for ${minutesBefore}m before (time in past): ${when}`);
            continue;
          }

          // schedule job
          schedule.scheduleJob(when, async () => {
            try {
              await transporter.sendMail({
                from: process.env.FROM_EMAIL || process.env.SMTP_USER,
                to: email,
                subject: `Reminder: ${title} due ${dueDate.toLocaleString()}`,
                text: `This is a reminder for ${title} (due ${dueDate.toLocaleString()}).\n\n${description}`
              });
              console.log('Sent reminder to', email, 'for', title, 'at', new Date());
            } catch (err) {
              console.error('Error sending reminder email', err);
            }
          });
        }
      }

      // daily reminders: schedule a job each day at dailyTime until dueDate
      if (dailyReminders) {
        // parse dailyTime (HH:MM)
        const [hh, mm] = (dailyTime || '09:00').split(':').map(n => parseInt(n, 10));
        // start from today at hh:mm (or tomorrow if that time already passed)
        let current = new Date();
        current.setHours(hh, mm, 0, 0);
        if (current.getTime() <= Date.now()) {
          // move to next day
          current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
        }
        // schedule each day until dueDate (inclusive if occur before due time)
        while (current.getTime() <= dueDate.getTime()) {
          const when = new Date(current);
          schedule.scheduleJob(when, async () => {
            try {
              await transporter.sendMail({
                from: process.env.FROM_EMAIL || process.env.SMTP_USER,
                to: email,
                subject: `Daily reminder: ${title} (due ${dueDate.toLocaleString()})`,
                text: `Daily reminder for ${title}. Due: ${dueDate.toLocaleString()}\n\n${description}`
              });
              console.log('Sent daily reminder to', email, 'for', title, 'at', new Date());
            } catch (err) {
              console.error('Error sending daily reminder email', err);
            }
          });

          // next day
          current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
        }
      }
    }

    // Create ICS and send as download
    createEvents(events, (error, value) => {
      if (error) {
        console.error(error);
        return res.status(500).send('Error creating ICS');
      }

      res.setHeader('Content-disposition', `attachment; filename=${title.replace(/[^a-z0-9]/gi,'_')}.ics`);
      res.setHeader('Content-Type', 'text/calendar');
      res.send(value);
    });

  } catch (err) {
    console.error(err);
    res.status(500).send('Server error: ' + err.message);
  }
});

// Export the app for serverless adapters (Vercel) and only listen when
// running the server directly (node server.js).
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });

  // Provide a helpful error message if the port is already in use.
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Another process is listening on this port.`);
      console.error('Identify the process with: lsof -iTCP:' + PORT + ' -sTCP:LISTEN -n -P');
      console.error('Then stop it with: kill <pid> (or use `kill -9 <pid>` if necessary).');
      console.error('Or run the server on a different port: PORT=3001 npm start');
      process.exit(1);
    }
    console.error('Server error:', err);
    process.exit(1);
  });

}

module.exports = app;
