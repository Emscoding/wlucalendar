// UI effects: cursor glow, swipe/tilt hero motion, and help modal
(() => {
  // Cursor glow
  const glow = document.createElement('div');
  glow.className = 'cursor-glow';
  document.body.appendChild(glow);

  let mouseX = -9999, mouseY = -9999, lastX = -9999, lastY = -9999;
  let showTimeout;

  function onMove(e) {
    mouseX = e.clientX;
    mouseY = e.clientY;
    glow.style.left = mouseX + 'px';
    glow.style.top = mouseY + 'px';
    glow.style.opacity = '1';
    // scale slightly with speed
    const dx = Math.abs(mouseX - lastX);
    const dy = Math.abs(mouseY - lastY);
    const speed = Math.min(1.8, (dx + dy) / 80);
    glow.style.transform = `translate(-50%,-50%) scale(${1 + speed * 0.12})`;
    lastX = mouseX; lastY = mouseY;
    clearTimeout(showTimeout);
    showTimeout = setTimeout(()=> { glow.style.opacity = '0'; }, 800);
  }

  window.addEventListener('mousemove', onMove, {passive:true});
  window.addEventListener('pointermove', onMove, {passive:true});
  // ensure glow shows during scroll (mouse may not move during scroll)
  let scrollTimeout;
  function onScroll(e){
    // use last known position if available, otherwise center-top
    const x = (lastX > -9000) ? lastX : Math.round(window.innerWidth/2);
    const y = (lastY > -9000) ? lastY : Math.round(window.innerHeight * 0.25);
    glow.style.left = x + 'px';
    glow.style.top = y + 'px';
    glow.style.opacity = '1';
    // subtle scale while scrolling
    glow.style.transform = `translate(-50%,-50%) scale(1.12)`;
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(()=>{ glow.style.opacity = '0'; glow.style.transform = 'translate(-50%,-50%) scale(1)'; }, 700);
  }
  window.addEventListener('scroll', onScroll, {passive:true});
  // also handle wheel to add a brief direction nudge
  window.addEventListener('wheel', (ev) => {
    const dir = Math.sign(ev.deltaY || 1);
    const x = (lastX > -9000) ? lastX : Math.round(window.innerWidth/2);
    const y = (lastY > -9000) ? lastY : Math.round(window.innerHeight * 0.25);
    glow.style.left = x + 'px';
    glow.style.top = y + 'px';
    glow.style.opacity = '1';
    glow.style.transform = `translate(-50%,-50%) translateY(${dir * -12}px) scale(1.18)`;
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(()=>{ glow.style.opacity = '0'; glow.style.transform = 'translate(-50%,-50%) scale(1)'; }, 500);
  }, {passive:true});

  // Hero tilt on swipe / pointer move over hero
  const hero = document.querySelector('.hero');
  if (hero) {
    let rect = hero.getBoundingClientRect();
    let touching = false;
    let startX = 0, startY = 0;
    const maxTilt = 10; // degrees

    function updateRect(){ rect = hero.getBoundingClientRect(); }
    window.addEventListener('resize', updateRect);

    function applyTilt(x, y) {
      const cx = rect.left + rect.width/2;
      const cy = rect.top + rect.height/2;
      const dx = (x - cx) / rect.width;
      const dy = (y - cy) / rect.height;
      const rotY = dx * maxTilt * -1;
      const rotX = dy * maxTilt;
      hero.style.transform = `perspective(900px) rotateX(${rotX}deg) rotateY(${rotY}deg) translateZ(0)`;
    }

    hero.classList.add('tilt-hero');
    hero.addEventListener('pointerenter', (e) => { applyTilt(e.clientX, e.clientY); });
    hero.addEventListener('pointermove', (e) => { applyTilt(e.clientX, e.clientY); });
    hero.addEventListener('pointerleave', () => { hero.style.transform = ''; });

    // Touch swipe subtle parallax
    let lastTouchX = null;
    hero.addEventListener('touchstart', (ev) => { if (ev.touches && ev.touches[0]) lastTouchX = ev.touches[0].clientX; });
    hero.addEventListener('touchmove', (ev) => {
      if (!ev.touches || !ev.touches[0]) return;
      const tx = ev.touches[0].clientX;
      if (lastTouchX == null) lastTouchX = tx;
      const d = tx - lastTouchX;
      // move hero slightly on x
      const maxPx = 18;
      const px = Math.max(-maxPx, Math.min(maxPx, d));
      hero.style.transform = `translateX(${px}px)`;
    }, {passive:true});
    hero.addEventListener('touchend', () => { hero.style.transform = ''; lastTouchX = null; });
  }

  // Help modal open/close
  const helpBtn = document.getElementById('helpBtn');
  const helpModal = document.getElementById('helpModal');
  const helpClose = document.getElementById('helpClose');
  const helpBackdrop = document.getElementById('helpBackdrop');

  function openHelp(){
    if (!helpModal) return;
    helpModal.setAttribute('aria-hidden','false');
    // focus first interactive element
    setTimeout(()=>{ const c = helpModal.querySelector('button, a, input, textarea'); if(c) c.focus(); }, 60);
  }
  function closeHelp(){ if(!helpModal) return; helpModal.setAttribute('aria-hidden','true'); }
  if (helpBtn) helpBtn.addEventListener('click', openHelp);
  if (helpClose) helpClose.addEventListener('click', closeHelp);
  if (helpBackdrop) helpBackdrop.addEventListener('click', closeHelp);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHelp(); });

  // Link hover preview: show a small floating card when hovering resource links
  (function linkPreview(){
    const preview = document.createElement('div');
    preview.className = 'link-preview';
    preview.innerHTML = '<div class="lp-inner"><div class="lp-media"></div><div class="lp-title"></div><div class="lp-desc"></div></div>';
    document.body.appendChild(preview);

    let currentAnchor = null;

    function showPreviewFor(a, ev){
      if (!a) return hidePreview();
      currentAnchor = a;
      const title = a.textContent.trim();
      // prefer a nearby .muted sibling for description
      let desc = '';
      const li = a.closest('li');
      if (li) {
        const d = li.querySelector('.muted');
        if (d) desc = d.textContent.trim();
      }
      // if no description, try title attr
      if (!desc) desc = a.getAttribute('title') || '';

      const mediaWrap = preview.querySelector('.lp-media');
      const tEl = preview.querySelector('.lp-title');
      const dEl = preview.querySelector('.lp-desc');

      mediaWrap.innerHTML = '';
      tEl.textContent = title;
      dEl.textContent = desc;

      // if it's a youtube link, show thumbnail
      const href = (a.href || '').toString();
      const ytMatch = href.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
      if (ytMatch) {
        const id = ytMatch[1];
        const img = document.createElement('img');
        img.src = `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
        mediaWrap.appendChild(img);
      }

      // position near cursor if available
      const x = (ev && ev.clientX) ? ev.clientX : (window.innerWidth / 2);
      const y = (ev && ev.clientY) ? ev.clientY : (window.innerHeight / 2);
      const pad = 16;
      // ensure inside viewport
      let left = x + 16;
      let top = y + 12;
      if (left + 360 > window.innerWidth) left = x - 360 - 12;
      if (top + 160 > window.innerHeight) top = window.innerHeight - 180;
      preview.style.left = `${Math.max(pad, left)}px`;
      preview.style.top = `${Math.max(pad, top)}px`;
      preview.classList.add('show');
    }
    function hidePreview(){ preview.classList.remove('show'); currentAnchor = null; }

    // delegate to resource links and result cards
    function bindPreviewTargets(){
      // resource list anchors
      document.querySelectorAll('.resource-list a, .wlu-link a, #ytResults a').forEach(a => {
        if (a._hasPreviewBound) return; a._hasPreviewBound = true;
        a.addEventListener('mouseenter', (ev) => showPreviewFor(a, ev));
        a.addEventListener('mousemove', (ev) => showPreviewFor(a, ev));
        a.addEventListener('mouseleave', () => hidePreview());
        // on touch/click show briefly
        a.addEventListener('touchstart', (ev) => { showPreviewFor(a, ev.touches && ev.touches[0] ? ev.touches[0] : ev); setTimeout(hidePreview, 2200); }, {passive:true});
      });
    }

    // re-bind when results change (simple mutation observer)
    const ro = new MutationObserver((m) => { bindPreviewTargets(); });
    const results = document.getElementById('ytResults');
    if (results) ro.observe(results, { childList: true, subtree: true });
    // initial bind
    bindPreviewTargets();
  })();

  // small entrance animation for hero
  window.addEventListener('load', () => {
    if (hero) hero.classList.add('fade-in');
    // pop the cursor once
    glow.style.opacity = '0';
  });

  // Smooth, iOS-like swish scrolling (desktop only)
  (function setupSmoothScroll(){
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let enabled = window.innerWidth > 900; // only enable on larger screens
    const scroller = document.querySelector('.site-container');
    if (!scroller) return;

    let rafId = null;
    let current = 0;
    let target = 0;
    const ease = 0.09;

    function updateHeight(){
      document.body.style.height = scroller.scrollHeight + 'px';
    }

    function onResize(){
      enabled = window.innerWidth > 900;
      cancelAnimationFrame(rafId);
      // reset transforms if disabled
      if (!enabled) {
        scroller.style.position = '';
        scroller.style.top = '';
        scroller.style.left = '';
        scroller.style.width = '';
        scroller.style.transform = '';
        document.body.style.height = '';
        return;
      }
      // enable fixed scroller
      scroller.style.position = 'fixed';
      scroller.style.top = '0';
      scroller.style.left = '0';
      scroller.style.width = '100%';
      updateHeight();
      current = window.scrollY || window.pageYOffset;
      target = current;
      rafId = requestAnimationFrame(tick);
    }

    function tick(){
      target = window.scrollY || window.pageYOffset;
      current += (target - current) * ease;
      // round to avoid sub-pixel blurriness
      const y = Math.round(current * 100) / 100;
      scroller.style.transform = `translateY(${-y}px)`;
      rafId = requestAnimationFrame(tick);
    }

    // initial setup
    window.addEventListener('resize', () => { updateHeight(); onResize(); });
    // run once
    updateHeight();
    onResize();
  })();

  // Intro overlay orchestration
  (function introSequence(){
    const overlay = document.getElementById('introOverlay');
    if (!overlay) return;
    // Split title into characters for pop-in animation
    const titleEl = overlay.querySelector('.intro-title');
    if (titleEl) {
      const text = titleEl.textContent.trim();
      titleEl.textContent = '';
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const span = document.createElement('span');
        span.className = 'char';
        span.textContent = ch === ' ' ? '\u00A0' : ch;
        // stagger delay per character
        span.style.transitionDelay = `${i * 45}ms`;
        titleEl.appendChild(span);
      }
    }

    // play animation shortly after load
    setTimeout(() => {
      overlay.classList.add('play');
    }, 180);

    // after pieces assembled, hold, then fade overlay
    const totalDuration = 2200; // ms (match CSS delays)
    setTimeout(() => {
      overlay.classList.add('played');
      // completely remove after fade
      setTimeout(() => { try { overlay.remove(); } catch (e) {} }, 620);
    }, totalDuration);
  })();

})();
