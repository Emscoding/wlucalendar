require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const ical = require('node-ical');
const { createEvents } = require('ics');
const nodemailer = require('nodemailer');
const schedule = require('node-schedule');
const multer = require('multer');
const fs = require('fs');
// no child_process required: audio extraction is handled client-side (ffmpeg.wasm)
const FormData = require('form-data');
const path = require('path');
// store uploaded backdrops in /public/uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, 'public', 'uploads'));
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

app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Important: enable cross-origin isolation so the browser can create
// SharedArrayBuffer which ffmpeg.wasm may require. This sets COOP/COEP
// headers. Note: when these headers are enabled, any cross-origin resources
// (CDN scripts, images) must send appropriate CORP/CORS headers. The
// recommended flow is to host ffmpeg.wasm and its assets locally under
// /public/vendor/ffmpeg so they are same-origin and usable by ffmpeg.wasm.
app.use((req, res, next) => {
  // Only set on HTML and script requests; static assets under /public will
  // also inherit these headers which is desired for cross-origin isolation.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

// Log which transcription provider will be used based on env vars (standardized names)
(() => {
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const GOOGLE_KEY = process.env.GOOGLE_API_KEY || (OPENAI_KEY && OPENAI_KEY.startsWith('AIza') ? OPENAI_KEY : null);
  const ASSEMBLY_KEY = process.env.ASSEMBLY_API_KEY || process.env.ASSEMBLYAI_API_KEY || null;
  if (ASSEMBLY_KEY) console.log('Transcription provider: ASSEMBLY (using ASSEMBLY_API_KEY)');
  else if (GOOGLE_KEY) console.log('Transcription provider: GOOGLE (using GOOGLE_API_KEY or Google-style key in OPENAI_API_KEY)');
  else if (OPENAI_KEY) console.log('Transcription provider: OPENAI');
  else console.log('Transcription provider: none configured (set ASSEMBLY_API_KEY, OPENAI_API_KEY or GOOGLE_API_KEY)');
})();

// YouTube search proxy to keep API key server-side. Set YT_API_KEY in env or it will use the fallback key.
const YT_KEY = process.env.YT_API_KEY || 'AIzaSyAKF0xVjjNLsdG3valJOvgrQYj5UCEy_io';

app.post('/youtube/search', async (req, res) => {
  try {
    const q = (req.body && req.body.q) || req.query.q;
    if (!q) return res.status(400).json({ error: 'Missing q parameter' });

    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=9&q=${encodeURIComponent(q)}&key=${YT_KEY}`;
    const resp = await axios.get(url);
    // forward the API response body
    res.json(resp.data);
  } catch (err) {
    console.error('YouTube proxy error', err && err.response ? err.response.data : err.message || err);
    const status = err.response && err.response.status ? err.response.status : 500;
    const data = err.response && err.response.data ? err.response.data : { error: err.message || 'Unknown error' };
    res.status(status).json(data);
  }
});

// Upload a video file (served from /public/uploads afterwards)
app.post('/upload/video', uploadVideo.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // public URL for the uploaded video
    const publicUrl = `/uploads/${req.file.filename}`;

  // full filesystem path to uploaded file
  const uploadedPath = path.join(__dirname, 'public', 'uploads', req.file.filename);

    // prepare response object
    const result = { url: publicUrl };

    // We prefer client-side extraction and upload to /upload/audio, but if
    // an AssemblyAI key is configured we will upload the container and ask
    // AssemblyAI to transcribe it server-side. Otherwise we return a helpful
    // message instructing the user to extract audio client-side.
    const GOOGLE_KEY = process.env.GOOGLE_API_KEY || null;
    const ASSEMBLY_KEY = process.env.ASSEMBLY_API_KEY || process.env.ASEMBLYAI_API_KEY || null;
    try {
      const st = fs.statSync(uploadedPath);
      console.log(`[upload/video] received file=${req.file.filename} size=${st.size} verbatim=${req.body && req.body.verbatim} GOOGLE_KEY=${!!GOOGLE_KEY} ASSEMBLY_KEY=${!!ASSEMBLY_KEY}`);
    } catch (e) {
      console.log('[upload/video] received file (stat failed)', req.file.filename, 'err=', e && e.message);
    }

    if (ASSEMBLY_KEY) {
      // Use AssemblyAI to transcribe uploaded container
      try {
        const buf = fs.readFileSync(uploadedPath);
        let uploadUrl = null;
        const upRes = await axios.post('https://api.assemblyai.com/v2/upload', buf, {
          headers: { Authorization: ASSEMBLY_KEY, 'Content-Type': 'application/octet-stream' },
          maxBodyLength: Infinity,
          timeout: 120000
        });
        uploadUrl = (upRes.data && (upRes.data.upload_url || upRes.data.url)) || upRes.data;

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

        // Poll for completion
        const start = Date.now();
        const timeoutMs = 5 * 60 * 1000;
        let finalResp = null;
        while (true) {
          await new Promise(r => setTimeout(r, 2000));
          const poll = await axios.get(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(transcriptId)}`, { headers: { Authorization: ASSEMBLY_KEY }, timeout: 120000 });
          finalResp = poll.data || {};
          if (finalResp.status === 'completed' || finalResp.status === 'failed') break;
          if (Date.now() - start > timeoutMs) {
            result.transcriptAvailable = false;
            result.message = 'AssemblyAI transcription timed out';
            return res.json(result);
          }
        }

        if (finalResp && finalResp.status === 'completed') {
          const text = finalResp.text || '';
          if (text) {
            const transcriptFilename = `${req.file.filename.replace(/\.[^/.]+$/, '')}.txt`;
            fs.writeFileSync(path.join(__dirname, 'public', 'uploads', transcriptFilename), text, 'utf8');
            result.transcriptAvailable = true;
            result.transcriptUrl = `/uploads/${transcriptFilename}`;
            result.transcriptText = text.length > 5000 ? text.slice(0,5000) + '\n\n...[truncated]' : text;
            try {
              const jsonFile = `${req.file.filename.replace(/\.[^/.]+$/, '')}.transcription.assembly.json`;
              fs.writeFileSync(path.join(__dirname, 'public', 'uploads', jsonFile), JSON.stringify(finalResp, null, 2), 'utf8');
              result.transcriptionJsonUrl = `/uploads/${jsonFile}`;
            } catch (e) {}
          } else {
            result.transcriptAvailable = false;
            result.message = 'AssemblyAI returned empty transcript';
          }
        } else {
          result.transcriptAvailable = false;
          result.message = 'AssemblyAI transcription failed';
        }

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
    console.log('[upload/video] no transcription key configured - returning message to client');
    return res.json(result);
  } catch (err) {
    console.error('Video upload error', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Accept browser-extracted audio (WAV) and transcribe it using the same transcription flow
app.post('/upload/audio', uploadAudio.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const publicUrl = `/uploads/${req.file.filename}`;
    const uploadedPath = path.join(__dirname, 'public', 'uploads', req.file.filename);
    const basename = req.file.filename.replace(/\.[^/.]+$/, '');
    const result = { url: publicUrl };

    // Detect configured transcription keys (AssemblyAI or Google)
    const GOOGLE_KEY = process.env.GOOGLE_API_KEY || null;
    const ASSEMBLY_KEY = process.env.ASSEMBLY_API_KEY || process.env.ASEMBLYAI_API_KEY || null;

    // Debug logging to help diagnose missing transcripts
    try {
      const st = fs.statSync(uploadedPath);
      console.log(`[upload/audio] received file=${req.file.filename} size=${st.size} verbatim=${req.body && req.body.verbatim} longrunning=${req.body && req.body.longrunning} GOOGLE_KEY=${!!GOOGLE_KEY} ASSEMBLY_KEY=${!!ASSEMBLY_KEY}`);
    } catch (e) {
      console.log('[upload/audio] received file (stat failed)', req.file.filename, 'err=', e && e.message);
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

        // create transcript job
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

        // poll for completion
        const start = Date.now();
        const timeoutMs = 5 * 60 * 1000;
        let finalResp = null;
        while (true) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const poll = await axios.get(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(transcriptId)}`, { headers: { Authorization: ASSEMBLY_KEY }, timeout: 120000 });
            finalResp = poll.data || {};
            if (finalResp.status === 'completed' || finalResp.status === 'failed') break;
          } catch (e) {
            console.warn('[upload/audio] AssemblyAI poll error', e && (e.response ? e.response.data : e.message || e));
          }
          if (Date.now() - start > timeoutMs) {
            result.transcriptAvailable = false;
            result.message = 'AssemblyAI transcription timed out';
            return res.json(result);
          }
        }

        if (!finalResp || finalResp.status !== 'completed') {
          result.transcriptAvailable = false;
          result.message = 'AssemblyAI transcription failed or returned no text';
          try {
            const jf = `${basename}.transcription.assembly.json`;
            fs.writeFileSync(path.join(__dirname, 'public', 'uploads', jf), JSON.stringify(finalResp || {}, null, 2), 'utf8');
            result.transcriptionJsonUrl = `/uploads/${jf}`;
          } catch (e) {}
          return res.json(result);
        }

        // success
        const text = finalResp.text || '';
        if (text) {
          const transcriptFilename = `${basename}.txt`;
          fs.writeFileSync(path.join(__dirname, 'public', 'uploads', transcriptFilename), text, 'utf8');
          result.transcriptAvailable = true;
          result.transcriptUrl = `/uploads/${transcriptFilename}`;
          result.transcriptText = text.length > 5000 ? text.slice(0,5000) + '\n\n...[truncated]' : text;
          try {
            const jsonFile = `${basename}.transcription.assembly.json`;
            fs.writeFileSync(path.join(__dirname, 'public', 'uploads', jsonFile), JSON.stringify(finalResp, null, 2), 'utf8');
            result.transcriptionJsonUrl = `/uploads/${jsonFile}`;
          } catch (e) {}

          // verbatim word list if AssemblyAI provides 'words'
          if (verbatimRequested && finalResp.words && Array.isArray(finalResp.words)) {
            const words = finalResp.words.map(w => w.text || '').filter(Boolean);
            if (words.length) {
              const vfn = `${basename}.verbatim.txt`;
              fs.writeFileSync(path.join(__dirname, 'public', 'uploads', vfn), words.join(' '), 'utf8');
              result.verbatimAvailable = true;
              result.verbatimUrl = `/uploads/${vfn}`;
            }
          }
        } else {
          result.transcriptAvailable = false;
          result.message = 'AssemblyAI returned empty transcript';
        }

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
            fs.writeFileSync(path.join(__dirname, 'public', 'uploads', transcriptFilename), text, 'utf8');
            result.transcriptAvailable = true;
            result.transcriptUrl = `/uploads/${transcriptFilename}`;
            result.transcriptText = text.length > 5000 ? text.slice(0,5000) + '\n\n...[truncated]' : text;

            try {
              const jsonFile = `${basename}.transcription.google.longrunning.json`;
              fs.writeFileSync(path.join(__dirname, 'public', 'uploads', jsonFile), JSON.stringify(opResp, null, 2), 'utf8');
              result.transcriptionJsonUrl = `/uploads/${jsonFile}`;
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
                fs.writeFileSync(path.join(__dirname, 'public', 'uploads', vfn), words.join(' '), 'utf8');
                result.verbatimAvailable = true;
                result.verbatimUrl = `/uploads/${vfn}`;
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
            fs.writeFileSync(path.join(__dirname, 'public', 'uploads', transcriptFilename), text, 'utf8');
            result.transcriptAvailable = true;
            result.transcriptUrl = `/uploads/${transcriptFilename}`;
            result.transcriptText = text.length > 5000 ? text.slice(0,5000) + '\n\n...[truncated]' : text;

            try {
              const jsonFile = `${basename}.transcription.google.json`;
              fs.writeFileSync(path.join(__dirname, 'public', 'uploads', jsonFile), JSON.stringify(gbody, null, 2), 'utf8');
              result.transcriptionJsonUrl = `/uploads/${jsonFile}`;
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
                fs.writeFileSync(path.join(__dirname, 'public', 'uploads', vfn), words.join(' '), 'utf8');
                result.verbatimAvailable = true;
                result.verbatimUrl = `/uploads/${vfn}`;
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

  } catch (err) {
    console.error('Audio upload error', err);
    res.status(500).json({ error: 'Upload failed' });
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
      const resp = await axios.get(url, { responseType: 'text' });
      rawICS = resp.data;
    } else if (req.file && req.file.buffer) {
      rawICS = req.file.buffer.toString('utf8');
    } else {
      return res.status(400).send('No ICS URL or file provided');
    }

    // parse with node-ical
    const parsed = ical.sync.parseICS(rawICS);

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
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
