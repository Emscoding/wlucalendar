// Script to transcribe existing video files in public/uploads.
// NOTE: OpenAI support has been removed from this project per configuration.
// If you want to transcribe files using Google Speech-to-Text, update this
// script to use GOOGLE_API_KEY and the Google Speech APIs (synchronous or
// longrunningrecognize) or extract audio to WAV and upload via the app UI.
// This script is intentionally left as a guide and will exit immediately.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const UPLOADS = path.join(__dirname, '..', 'public', 'uploads');
console.error('This helper script is deprecated: OpenAI transcription removed. Use client-side extraction or implement a Google transcription flow.');
process.exit(1);

function listVideoFiles() {
  const exts = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.mpg', '.mpeg'];
  return fs.readdirSync(UPLOADS).filter(f => exts.includes(path.extname(f).toLowerCase()));
}

async function extractAudio(videoFile, outWav) {
  return new Promise((resolve, reject) => {
    const fullIn = path.join(UPLOADS, videoFile);
    const fullOut = outWav;
    const ff = spawn('ffmpeg', ['-y', '-i', fullIn, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', fullOut]);
    let stderr = '';
    ff.stderr.on('data', d => stderr += d.toString());
    ff.on('error', (err) => reject(err));
    ff.on('close', code => {
      if (code === 0) resolve(fullOut);
      else reject(new Error('ffmpeg failed: ' + stderr.split('\n').slice(0,5).join('\n')));
    });
  });
}

async function transcribeWav(wavPath) {
  const fd = new FormData();
  fd.append('file', fs.createReadStream(wavPath));
  fd.append('model', 'whisper-1');
  try {
    const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', fd, {
      headers: Object.assign({ Authorization: `Bearer ${OPENAI_KEY}` }, fd.getHeaders()),
      maxBodyLength: Infinity,
      timeout: 120000
    });
    return resp.data && (resp.data.text || '');
  } catch (err) {
    throw err;
  }
}

(async function main(){
  const videos = listVideoFiles();
  if (videos.length === 0) {
    console.log('No video files found in', UPLOADS);
    return;
  }

  for (const v of videos) {
    try {
      const basename = v.replace(/\.[^/.]+$/, '');
      const wavPath = path.join(UPLOADS, basename + '.wav');
      const txtPath = path.join(UPLOADS, basename + '.txt');
      if (fs.existsSync(txtPath)) {
        console.log('Skipping', v, '- transcript already exists at', txtPath);
        continue;
      }

      console.log('Extracting audio from', v);
      await extractAudio(v, wavPath);
      console.log('Transcribing', wavPath);
      const text = await transcribeWav(wavPath);
      fs.writeFileSync(txtPath, text, 'utf8');
      console.log('Wrote transcript to', txtPath);
      // remove wav to save space
      try { fs.unlinkSync(wavPath); } catch(e){}
    } catch (err) {
      console.error('Error processing', v, err && err.response ? err.response.data || err.response.statusText : err.message || err);
    }
  }
})();
