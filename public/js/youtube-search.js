// Minimal YouTube search + embed UI
// - Requires a YouTube Data API key (v3). The page provides an input so you can paste one.
// - For quick demos the "Use sample key" button will populate a short-lived demo key if you want to try locally (it may not work long-term).

(function () {
  const qEl = document.getElementById('ytQuery');
  const keyEl = null; // no in-page api key input; server proxy used instead
  const resultsEl = document.getElementById('ytResults');
  const searchBtn = document.getElementById('ytSearch');
  const playerWrap = document.getElementById('playerWrap');
  const transcriptArea = document.getElementById('transcriptArea');
  const closePlayer = document.getElementById('closePlayer');
  const floatToggle = document.getElementById('floatToggle');
  const currentTitle = document.getElementById('currentTitle');
  const videoFileInput = document.getElementById('videoFile');
  const uploadVideoBtn = document.getElementById('uploadVideoBtn');
  const verbatimToggle = document.getElementById('verbatimToggle');
  const clientExtractToggle = document.getElementById('clientExtractToggle');
  let ffmpegReady = false;
  let ffmpegInstance = null;

  // Lazy-load ffmpeg.wasm when user first opts in
  async function ensureFFmpeg() {
    if (ffmpegReady) return ffmpegInstance;
    // SharedArrayBuffer is required by many ffmpeg.wasm builds. Detect and
    // fail early with a helpful message if it's not available.
    if (typeof SharedArrayBuffer === 'undefined') {
      throw new Error('SharedArrayBuffer is not defined. To use ffmpeg.wasm the page must be cross-origin isolated (set Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp). Alternatively host ffmpeg assets locally and enable COOP/COEP on the server or disable client-side extraction.');
    }

    if (!window.FFmpeg && !window.createFFmpeg) {
      console.info('FFmpeg wasm not found - loading from CDN');
      // try a list of CDN hosts in order to be more robust
      // Prefer a local vendor copy (avoid CDN + cross-origin issues). Then
      // fall back to several CDN hosts.
      const cdnCandidates = [
        '/vendor/ffmpeg/ffmpeg.min.js',
        'https://unpkg.com/@ffmpeg/ffmpeg@0.11.9/dist/ffmpeg.min.js',
        'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.11.9/dist/ffmpeg.min.js',
        'https://unpkg.com/@ffmpeg/ffmpeg@0.11.5/dist/ffmpeg.min.js'
      ];
      let loaded = false;
      let lastErr = null;
      for (const src of cdnCandidates) {
        try {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => resolve();
            s.onerror = (ev) => reject(new Error('Failed to load ffmpeg.wasm script from ' + src + ': ' + (ev && ev.type ? ev.type : ev)));
            document.head.appendChild(s);
          });
          loaded = true;
          console.info('Loaded ffmpeg.wasm from', src);
          break;
        } catch (e) {
          lastErr = e;
          console.warn('ffmpeg load failed from', src, e && (e.message || e));
        }
      }
      if (!loaded) {
        console.error('Could not load ffmpeg.wasm from any CDN', lastErr && (lastErr.message || lastErr));
        const err = new Error('Could not load ffmpeg.wasm from CDN. Check your network, disable client-side extraction, or host ffmpeg assets locally under /public/vendor/ffmpeg and reload.');
        err.cause = lastErr;
        throw err;
      }
    }

    // obtain createFFmpeg and fetchFile regardless of how the library exposes them
    const create = (typeof FFmpeg !== 'undefined' && FFmpeg.createFFmpeg) ? FFmpeg.createFFmpeg : (window.createFFmpeg || null);
    const fetchFile = (typeof FFmpeg !== 'undefined' && FFmpeg.fetchFile) ? FFmpeg.fetchFile : (window.fetchFile || null);
    if (!create) throw new Error('ffmpeg wasm createFFmpeg not available after load');

    ffmpegInstance = create({ log: false });

    // show progress during load and conversion if supported
    if (ffmpegInstance.setProgress) {
      ffmpegInstance.setProgress(({ ratio }) => {
        const pct = Math.round((ratio || 0) * 100);
        if (uploadVideoBtn) uploadVideoBtn.textContent = `Processing audio... ${pct}%`;
      });
    }

    try {
      await ffmpegInstance.load();
    } catch (e) {
      console.error('ffmpeg.wasm load failed', e && (e.message || e));
      throw e;
    }
    ffmpegReady = true;
    return { ffmpeg: ffmpegInstance, fetchFile };
  }

  let isFloating = false;

  function createCard(item) {
    const vidId = item.id.videoId;
    const thumb = item.snippet.thumbnails?.medium?.url || '';
    const title = item.snippet.title || '';
    const channel = item.snippet.channelTitle || '';

  const card = document.createElement('div');
  card.className = 'result-card';

  const img = document.createElement('img');
  img.src = thumb;
  img.alt = title;
  img.style.cursor = 'pointer';

  const meta = document.createElement('div');
  meta.className = 'meta';

  const h = document.createElement('div');
  h.className = 'title';
  h.textContent = title;

  const ch = document.createElement('div');
  ch.className = 'channel';
  ch.textContent = channel;

  img.addEventListener('click', () => loadVideo(vidId, title));

  meta.appendChild(h);
  meta.appendChild(ch);
  card.appendChild(img);
  card.appendChild(meta);
  return card;
  }

  function renderResults(items) {
    resultsEl.innerHTML = '';
    if (!items || items.length === 0) {
      resultsEl.innerHTML = '<div style="color:#666">No results</div>';
      return;
    }
    items.forEach(i => resultsEl.appendChild(createCard(i)));
  }

  async function searchYouTube(query) {
    // Proxy request to server so API key is not exposed client-side
    try {
      const res = await fetch('/youtube/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query })
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(res.status + ' ' + t);
      }
      const data = await res.json();
      renderResults((data && data.items) || []);
    } catch (err) {
      console.error('YouTube search error', err);
      alert('Search failed: ' + (err.message || err));
    }
  }

  function loadVideo(idOrUrl, title) {
    currentTitle.textContent = title || '';
    playerWrap.innerHTML = '';

    // if this looks like a URL or an uploads path, play as a local video
    if (typeof idOrUrl === 'string' && (idOrUrl.startsWith('http://') || idOrUrl.startsWith('https://') || idOrUrl.startsWith('/'))) {
      const video = document.createElement('video');
      video.src = idOrUrl;
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.style.width = '100%';
      video.style.maxHeight = '480px';
      video.setAttribute('webkit-playsinline', '');
      video.setAttribute('allow', 'autoplay; picture-in-picture');
      // double-click to request native PiP if supported
      video.addEventListener('dblclick', async () => {
        try { if (video.requestPictureInPicture) await video.requestPictureInPicture(); } catch (e) { /* ignore */ }
      });
      playerWrap.appendChild(video);
      video.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    // otherwise assume a YouTube id and embed
    const iframe = document.createElement('iframe');
    iframe.width = '100%';
    iframe.height = '480';
    iframe.src = `https://www.youtube.com/embed/${idOrUrl}?rel=0&modestbranding=1`;
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.style.border = 'none';
    playerWrap.appendChild(iframe);
    // ensure player is visible
    playerWrap.scrollIntoView({ behavior: 'smooth' });
  }

  function toggleFloat() {
    isFloating = !isFloating;
    const cont = document.getElementById('playerContainer');
    if (isFloating) {
      cont.style.position = 'fixed';
      cont.style.right = '12px';
      cont.style.bottom = '12px';
      cont.style.width = '360px';
      cont.style.zIndex = 9999;
      cont.style.boxShadow = '0 6px 20px rgba(0,0,0,0.15)';
      cont.style.background = '#fff';
      floatToggle.textContent = 'Dock';
    } else {
      cont.style.position = '';
      cont.style.right = '';
      cont.style.bottom = '';
      cont.style.width = '';
      cont.style.boxShadow = '';
      cont.style.background = '';
      floatToggle.textContent = 'Float';
    }
  }

  function closeCurrent() {
    playerWrap.innerHTML = '';
    currentTitle.textContent = '';
  }

  searchBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const q = qEl.value && qEl.value.trim();
    if (!q) return;
    searchYouTube(q);
  });

  // Upload & play a local video file
  if (uploadVideoBtn && videoFileInput) {
    uploadVideoBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const file = videoFileInput.files && videoFileInput.files[0];
      if (!file) return alert('Please pick a video file first');

      // If client extraction is requested, run ffmpeg.wasm to extract WAV and upload the audio instead
      if (clientExtractToggle && clientExtractToggle.checked) {
        try {
          uploadVideoBtn.disabled = true;
          uploadVideoBtn.textContent = 'Preparing extraction...';
          const { ffmpeg, fetchFile } = await ensureFFmpeg();
          const inName = `in_${Date.now()}.${file.name.split('.').pop()}`;
          const outName = `out_${Date.now()}.wav`;
          try {
            ffmpeg.FS('writeFile', inName, await fetchFile(file));
          } catch (werr) {
            console.error('ffmpeg FS write failed', werr && (werr.message || werr));
            throw new Error('Could not write file into ffmpeg filesystem: ' + (werr && (werr.message || werr)));
          }
          uploadVideoBtn.textContent = 'Extracting audio...';
          try {
            await ffmpeg.run('-y', '-i', inName, '-vn', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', outName);
          } catch (runErr) {
            console.error('ffmpeg run error', runErr && (runErr.message || runErr));
            throw new Error('ffmpeg failed to extract audio: ' + (runErr && (runErr.message || runErr)));
          }
          let wavData;
          try { wavData = ffmpeg.FS('readFile', outName); } catch (rerr) { console.error('ffmpeg readFile failed', rerr && (rerr.message || rerr)); throw new Error('Could not read output audio from ffmpeg: ' + (rerr && (rerr.message || rerr))); }
          const wavBlob = new Blob([wavData.buffer], { type: 'audio/wav' });
          // cleanup
          try { ffmpeg.FS('unlink', inName); } catch(e){}
          try { ffmpeg.FS('unlink', outName); } catch(e){}

          const afd = new FormData();
          afd.append('audio', wavBlob, file.name.replace(/\.[^/.]+$/, '') + '.wav');
          if (verbatimToggle && verbatimToggle.checked) afd.append('verbatim', '1');
          uploadVideoBtn.textContent = 'Uploading audio...';
          const resp = await fetch('/upload/audio', { method: 'POST', body: afd });
          if (!resp.ok) {
            const t = await resp.text().catch(()=>null);
            throw new Error('Upload failed: ' + resp.status + (t ? ' - ' + t : ''));
          }
          const uploadResult = await resp.json().catch(()=>null);
          if (uploadResult && uploadResult.url) {
            loadVideo(uploadResult.url, file.name);
            // show transcripts like before
            transcriptArea.innerHTML = '';
              if (uploadResult.transcriptAvailable && uploadResult.transcriptUrl) {
              const dl = document.createElement('a'); dl.href = uploadResult.transcriptUrl; dl.textContent = 'Download Transcript'; dl.target = '_blank'; dl.rel='noopener'; dl.style.display='block'; dl.style.marginTop='8px'; transcriptArea.appendChild(dl);
              if (uploadResult.transcriptText) { const pre = document.createElement('pre'); pre.style.maxHeight='240px'; pre.style.overflow='auto'; pre.style.background='#fafafa'; pre.style.padding='8px'; pre.style.borderRadius='6px'; pre.style.marginTop='8px'; pre.textContent = uploadResult.transcriptText; transcriptArea.appendChild(pre); }
              if (uploadResult.verbatimAvailable && uploadResult.verbatimUrl) { const vdl = document.createElement('a'); vdl.href = uploadResult.verbatimUrl; vdl.textContent='Download Transcript'; vdl.target='_blank'; vdl.rel='noopener'; vdl.style.display='block'; vdl.style.marginTop='8px'; transcriptArea.appendChild(vdl); if (uploadResult.verbatimText) { const vpre = document.createElement('pre'); vpre.style.maxHeight='240px'; vpre.style.overflow='auto'; vpre.style.background='#fffaf0'; vpre.style.padding='8px'; vpre.style.borderRadius='6px'; vpre.style.marginTop='8px'; vpre.textContent = uploadResult.verbatimText; transcriptArea.appendChild(vpre); } }
            } else if (uploadResult && uploadResult.message) { const note = document.createElement('div'); note.style.color='#666'; note.style.marginTop='8px'; note.textContent = uploadResult.message; transcriptArea.appendChild(note); }
          } else { throw new Error('No URL returned from upload'); }
        } catch (err) {
          console.error('Client extraction/upload failed', err && (err.message || err));
          alert('Client extraction/upload failed: ' + (err && (err.message || err)));
        } finally {
          uploadVideoBtn.disabled = false;
          uploadVideoBtn.textContent = 'Upload & Play';
        }
        return;
      }

      const fd = new FormData();
      fd.append('video', file);
      // append verbatim flag if user requested a word-for-word transcript
      try {
        if (verbatimToggle && verbatimToggle.checked) fd.append('verbatim', '1');
      } catch (e) {}
      try {
        uploadVideoBtn.disabled = true;
        uploadVideoBtn.textContent = 'Uploading...';
        const resp = await fetch('/upload/video', { method: 'POST', body: fd });
        if (!resp.ok) {
          const t = await resp.text();
          throw new Error(resp.status + ' ' + t);
        }
        const data = await resp.json();
        if (data && data.url) {
          loadVideo(data.url, file.name);
          // show transcript download / preview if available
          if (transcriptArea) {
            transcriptArea.innerHTML = '';
                if (data.transcriptAvailable && data.transcriptUrl) {
                const dl = document.createElement('a');
                dl.href = data.transcriptUrl;
                dl.textContent = 'Download transcript';
                dl.target = '_blank';
                dl.rel = 'noopener';
                dl.style.display = 'block';
                dl.style.marginTop = '8px';
                transcriptArea.appendChild(dl);

                if (data.transcriptText) {
                  const pre = document.createElement('pre');
                  pre.style.maxHeight = '240px';
                  pre.style.overflow = 'auto';
                  pre.style.background = '#fafafa';
                  pre.style.padding = '8px';
                  pre.style.borderRadius = '6px';
                  pre.style.marginTop = '8px';
                  pre.textContent = data.transcriptText;
                  transcriptArea.appendChild(pre);
                }
                // verbatim transcript if available
                if (data.verbatimAvailable && data.verbatimUrl) {
                  const vdl = document.createElement('a');
                  vdl.href = data.verbatimUrl;
                  vdl.textContent = 'Download Transcript';
                  vdl.target = '_blank';
                  vdl.rel = 'noopener';
                  vdl.style.display = 'block';
                  vdl.style.marginTop = '8px';
                  transcriptArea.appendChild(vdl);

                  if (data.verbatimText) {
                    const vpre = document.createElement('pre');
                    vpre.style.maxHeight = '240px';
                    vpre.style.overflow = 'auto';
                    vpre.style.background = '#fffaf0';
                    vpre.style.padding = '8px';
                    vpre.style.borderRadius = '6px';
                    vpre.style.marginTop = '8px';
                    vpre.textContent = data.verbatimText;
                    transcriptArea.appendChild(vpre);
                  }
                }
            } else if (data.message) {
              const note = document.createElement('div');
              note.style.color = '#666';
              note.style.marginTop = '8px';
              note.textContent = data.message;
              transcriptArea.appendChild(note);
            }
          }
        } else {
          throw new Error('No URL returned from upload');
        }
      } catch (err) {
        console.error('Upload failed', err);
        alert('Upload failed: ' + (err.message || err));
      } finally {
        uploadVideoBtn.disabled = false;
        uploadVideoBtn.textContent = 'Upload & Play';
      }
    });
  }

  floatToggle.addEventListener('click', (e) => { e.preventDefault(); toggleFloat(); });
  closePlayer.addEventListener('click', (e) => { e.preventDefault(); closeCurrent(); });

  // Allow Enter to trigger search
  qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchBtn.click(); } });

})();
