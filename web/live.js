// GuideBand live demo: camera + voice in the browser, talking to the GuideBand service.
(() => {
  const el = id => document.getElementById(id);
  if (!el('live')) return;

  // ---------- Service connection ----------
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const sameOrigin = location.port === '8000'; // page is served by the service itself
  let api = (store.get('guideband_api') ?? (sameOrigin ? '' : 'http://localhost:8000')).replace(/\/$/, '');
  const session = Math.random().toString(36).slice(2, 12);
  let online = false;

  el('apiInput').value = api || location.origin;

  async function call(path, options = {}) {
    const response = await fetch(api + path, options);
    if (!response.ok) {
      const detail = await response.json().then(d => d.detail).catch(() => '');
      throw new Error(typeof detail === 'string' && detail ? detail : 'The service returned an error (' + response.status + ').');
    }
    return response.json();
  }

  async function checkService() {
    try {
      const s = await call('/system/status');
      online = true;
      const cloud = s.vision.cloud_providers.length ? 'Gemini connected' : 'no cloud model (local answers only)';
      const detector = s.vision.detector.state === 'unavailable' ? 'detector unavailable' : 'on-device detector';
      const pay = s.payments.mode === 'stripe_test' ? 'Stripe test mode' : 'simulated payments';
      el('liveStatus').textContent = 'Connected · ' + detector + ' · ' + cloud + ' · ' + pay;
      el('liveDot').className = 'dot';
    } catch {
      online = false;
      el('liveStatus').textContent = 'Not connected to the GuideBand service';
      el('liveDot').className = 'dot dot-bad';
    }
    el('liveOffline').hidden = online;
  }
  el('retryBtn').onclick = checkService;
  el('apiForm').onsubmit = e => {
    e.preventDefault();
    const value = el('apiInput').value.trim().replace(/\/$/, '');
    api = value === location.origin ? '' : value;
    store.set('guideband_api', api);
    checkService();
  };

  // ---------- Speech out ----------
  let lastReplyAt = 0;
  function speak(text, { warning = false, force = false } = {}) {
    if (!('speechSynthesis' in window) || !text) return;
    if (warning) {
      // Warnings never talk over an answer.
      if (!el('hazardToggle').checked || speechSynthesis.speaking || Date.now() - lastReplyAt < 1500) return;
    } else {
      if (!force && !el('voiceToggle').checked) return;
      speechSynthesis.cancel();
      lastReplyAt = Date.now();
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = warning ? 1.08 : 1;
    speechSynthesis.speak(utterance);
  }

  // ---------- Camera ----------
  const video = el('liveVideo'), overlay = el('liveOverlay'), stage = video.parentElement;
  const grab = document.createElement('canvas');
  let stream = null;

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open the camera here. Use Chrome on localhost or HTTPS.');
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 960 } }, audio: false });
    video.srcObject = stream;
    await video.play();
    stage.classList.add('on');
    el('camBtn').textContent = 'Turn camera off';
    hazardLoop();
  }
  function stopCamera() {
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    stage.classList.remove('on');
    el('camBtn').textContent = 'Turn camera on';
    el('liveWarning').textContent = '';
    overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
  }
  el('camBtn').onclick = async () => {
    if (stream) return stopCamera();
    try { await startCamera(); } catch (error) {
      addMessage('error', error.name === 'NotAllowedError' ? 'Camera permission was denied. Allow the camera for this page and try again.' : error.message);
    }
  };

  /** Current frame as a JPEG blob, or null when the camera is off. */
  function frame() {
    if (!stream || !video.videoWidth) return Promise.resolve(null);
    const scale = Math.min(1, 640 / video.videoWidth);
    grab.width = Math.round(video.videoWidth * scale);
    grab.height = Math.round(video.videoHeight * scale);
    grab.getContext('2d').drawImage(video, 0, 0, grab.width, grab.height);
    return new Promise(resolve => grab.toBlob(resolve, 'image/jpeg', 0.72));
  }

  function drawBoxes(detections) {
    const w = overlay.width = stage.clientWidth, h = overlay.height = stage.clientHeight;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (!video.videoWidth) return;
    // The video is shown with object-fit: cover, so map boxes through the same crop.
    const scale = Math.max(w / video.videoWidth, h / video.videoHeight);
    const dx = (w - video.videoWidth * scale) / 2, dy = (h - video.videoHeight * scale) / 2;
    ctx.lineWidth = 3; ctx.font = '600 14px system-ui, sans-serif'; ctx.textBaseline = 'top';
    for (const d of detections) {
      const x = dx + d.box[0] * video.videoWidth * scale, y = dy + d.box[1] * video.videoHeight * scale;
      const bw = (d.box[2] - d.box[0]) * video.videoWidth * scale, bh = (d.box[3] - d.box[1]) * video.videoHeight * scale;
      ctx.strokeStyle = '#d8ff70'; ctx.strokeRect(x, y, bw, bh);
      const label = d.label + ' ' + Math.round(d.confidence * 100) + '%';
      ctx.fillStyle = '#d8ff70'; ctx.fillRect(x, Math.max(0, y - 20), ctx.measureText(label).width + 10, 20);
      ctx.fillStyle = '#07120f'; ctx.fillText(label, x + 5, Math.max(0, y - 20) + 3);
    }
  }

  // ---------- See: continuous local hazard warnings ----------
  const spokenAt = new Map();
  let looping = false;
  async function hazardLoop() {
    if (looping) return;
    looping = true;
    while (stream) {
      const started = Date.now();
      if (online && !document.hidden) {
        try {
          const blob = await frame();
          if (blob) {
            const body = new FormData();
            body.append('image', blob, 'frame.jpg');
            body.append('describe', 'false');
            const scene = await call('/vision/analyze', { method: 'POST', body });
            if (!stream) break;
            drawBoxes(scene.detections);
            el('liveWarning').textContent = scene.warnings.join(' ');
            const fresh = scene.warnings.find(w => Date.now() - (spokenAt.get(w) || 0) > 8000);
            if (fresh) { spokenAt.set(fresh, Date.now()); speak(fresh, { warning: true }); }
          }
        } catch { online = false; checkService(); }
      }
      await new Promise(r => setTimeout(r, Math.max(150, 700 - (Date.now() - started))));
    }
    looping = false;
  }

  // ---------- Assistant ----------
  const log = el('liveLog');
  function addMessage(kind, text, meta) {
    const item = document.createElement('li');
    item.className = 'msg msg-' + kind;
    const p = document.createElement('p');
    p.textContent = text;
    item.append(p);
    if (meta) { const small = document.createElement('small'); small.textContent = meta; item.append(small); }
    log.append(item);
    log.scrollTop = log.scrollHeight;
    return item;
  }

  const sources = { gemini: 'Gemini', groq: 'Groq', local: 'on-device' };
  let busy = false;
  async function ask(text) {
    text = text.trim();
    if (!text || busy) return;
    if (!online) { await checkService(); if (!online) return addMessage('error', 'I can’t reach the GuideBand service. Start it, then try again.'); }
    busy = true;
    addMessage('user', text);
    const pendingItem = addMessage('guide', 'Thinking');
    pendingItem.classList.add('thinking');
    try {
      const body = new FormData();
      body.append('text', text);
      body.append('session', session);
      const blob = await frame();
      if (blob) body.append('image', blob, 'frame.jpg');
      const reply = await call('/assistant', { method: 'POST', body });
      pendingItem.remove();
      const meta = reply.provider ? sources[reply.provider] + ' · ' + (reply.latency_ms / 1000).toFixed(1) + ' s' : '';
      addMessage('guide', reply.say, meta);
      speak(reply.say);
      const waiting = reply.order && (reply.intent === 'pay_quote' || reply.intent === 'pay_waiting');
      el('confirmBar').hidden = !waiting;
      if (waiting) el('confirmText').textContent = 'Pay ' + reply.order.price + ' for one ' + reply.order.item + '?';
      if (reply.intent === 'bridge') selectTab('bridge');
      if (['remember', 'forget', 'see', 'pay_confirm'].includes(reply.intent)) loadMemory();
    } catch (error) {
      pendingItem.remove();
      addMessage('error', error.message || 'Something went wrong.');
    }
    busy = false;
  }
  el('askForm').onsubmit = e => { e.preventDefault(); const input = el('askInput'); ask(input.value); input.value = ''; };
  document.querySelectorAll('#live [data-say]').forEach(button => button.onclick = () => ask(button.dataset.say));

  // ---------- Speech in ----------
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let listening = null;
  function listen({ continuous, onText, onEnd }) {
    listening?.abort();
    speechSynthesis?.cancel();
    const r = new Recognition();
    r.lang = 'en-US'; r.interimResults = true; r.continuous = continuous;
    r.onresult = e => {
      const text = [...e.results].map(x => x[0].transcript).join(' ').trim();
      onText(text, e.results[e.results.length - 1].isFinal);
    };
    r.onerror = e => { if (e.error === 'not-allowed') addMessage('error', 'Microphone permission was denied. You can still type.'); };
    r.onend = () => { if (listening === r) listening = null; onEnd(); };
    listening = r;
    r.start();
    return r;
  }
  if (!Recognition) {
    el('micBtn').hidden = true;
    el('captionBtn').disabled = true;
    el('micHint').textContent = 'Voice input isn’t available in this browser — type instead, or use Chrome.';
  } else {
    el('micBtn').onclick = () => {
      if (el('micBtn').getAttribute('aria-pressed') === 'true') return listening?.stop();
      let heard = '';
      el('micBtn').setAttribute('aria-pressed', 'true');
      el('askInput').placeholder = 'Listening…';
      listen({
        continuous: false,
        onText: text => { heard = text; el('askInput').value = text; },
        onEnd: () => {
          el('micBtn').setAttribute('aria-pressed', 'false');
          el('askInput').placeholder = 'Tap the mic, or type here';
          el('askInput').value = '';
          if (heard) ask(heard);
        },
      });
    };
  }

  // ---------- Bridge ----------
  const caption = el('bridgeCaption');
  let captioning = false;
  function captionLoop() {
    listen({
      continuous: true,
      onText: text => { caption.textContent = text; caption.scrollTop = caption.scrollHeight; },
      onEnd: () => { if (captioning) captionLoop(); }, // recognition stops itself after a pause
    });
  }
  el('captionBtn').onclick = () => {
    captioning = !captioning;
    el('captionBtn').setAttribute('aria-pressed', String(captioning));
    el('captionBtn').textContent = captioning ? 'Stop live captions' : 'Start live captions';
    if (captioning) { caption.textContent = 'Listening…'; captionLoop(); } else listening?.stop();
  };
  el('speakForm').onsubmit = e => {
    e.preventDefault();
    const text = el('speakInput').value.trim();
    if (!text) return;
    caption.textContent = text;
    speak(text, { force: true });
    el('speakInput').value = '';
  };
  el('signBtn').onclick = async () => {
    if (!stream) return void (caption.textContent = 'Turn the camera on first, then sign towards it.');
    el('signBtn').disabled = true;
    caption.textContent = 'Watching… sign now.';
    try {
      const body = new FormData();
      for (let i = 0; i < 3; i++) {
        body.append('images', await frame(), 'frame' + i + '.jpg');
        if (i < 2) await new Promise(r => setTimeout(r, 600));
      }
      caption.textContent = 'Reading…';
      const reading = await call('/bridge/sign', { method: 'POST', body });
      if (reading.text) { caption.textContent = reading.text; speak(reading.text, { force: true }); }
      else caption.textContent = 'I couldn’t read that sign with confidence. Try again, closer and well lit.';
    } catch (error) { caption.textContent = error.message; }
    el('signBtn').disabled = false;
  };

  // ---------- Memory ----------
  function ago(seconds) {
    if (seconds < 45) return 'just now';
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? minutes + ' min ago' : Math.round(minutes / 60) + ' h ago';
  }
  async function loadMemory() {
    if (!online) return;
    try {
      const data = await call('/memory');
      const list = el('memoryList'), nowSeconds = Date.now() / 1000;
      list.replaceChildren();
      const add = (text, meta) => {
        const item = document.createElement('li'), small = document.createElement('small');
        item.textContent = text; small.textContent = meta; item.append(small); list.append(item);
      };
      data.notes.forEach(n => add(n.text, n.kind + ' · ' + ago(nowSeconds - n.created)));
      data.objects.forEach(o => add(o.label + ' — ' + o.position, 'detector · ' + ago(nowSeconds - o.last_seen)));
      if (!list.children.length) { const empty = document.createElement('li'); empty.className = 'memory-empty'; empty.textContent = 'Nothing remembered yet.'; list.append(empty); }
    } catch {}
  }
  el('memoryRefresh').onclick = loadMemory;
  el('memoryClear').onclick = async () => {
    if (!confirm('Erase everything GuideBand remembers? This cannot be undone.')) return;
    try { await call('/memory', { method: 'DELETE' }); loadMemory(); } catch (error) { addMessage('error', error.message); }
  };
  setInterval(async () => {
    if (!el('autoRemember').checked || !stream || !online || busy) return;
    const blob = await frame();
    if (!blob) return;
    const body = new FormData();
    body.append('image', blob, 'frame.jpg');
    call('/memory/observe', { method: 'POST', body }).then(loadMemory).catch(() => {});
  }, 20000);

  // ---------- Tabs ----------
  const tabs = [...document.querySelectorAll('#live .tab')];
  function selectTab(name) {
    tabs.forEach(tab => {
      const selected = tab.id === 'tab-' + name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      el(tab.getAttribute('aria-controls')).hidden = !selected;
    });
    if (name === 'memory') loadMemory();
  }
  tabs.forEach((tab, index) => {
    tab.onclick = () => selectTab(tab.id.slice(4));
    tab.onkeydown = e => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      const next = tabs[(index + step + tabs.length) % tabs.length];
      selectTab(next.id.slice(4)); next.focus();
    };
  });

  checkService();
})();
