// GuideBand live demo: camera + voice in the browser, talking to the GuideBand service.
(() => {
  const el = id => document.getElementById(id);
  if (!el('live')) return;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  // ---------- Service connection ----------
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const sameOrigin = location.port === '8000'; // page is served by the service itself
  let api = (store.get('guideband_api') ?? (sameOrigin ? '' : 'http://localhost:8000')).replace(/\/$/, '');
  const session = Math.random().toString(36).slice(2, 12);
  let online = false, activeTab = 'assistant';

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
      cloudVoice = Boolean(s.speech?.voice && s.speech.voice !== 'browser');
      el('liveStatus').textContent = 'Connected · ' + detector + ' · ' + cloud + ' · ' + (cloudVoice ? 'ElevenLabs voice' : 'browser voice') + ' · ' + pay;
      el('liveDot').className = 'dot';
      el('qrLink').href = api + '/pay/qr.png?item=Coffee&amount=4.50';
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
  // Replies use the ElevenLabs voice when the service has one. Hazard warnings
  // always use the browser's local voice: instant, and no network to wait for.
  let lastReplyAt = 0, lastSpeechEnd = 0, cloudVoice = false, cloudPlaying = false, cloudVoiceRetryAt = 0;
  const buzz = pattern => { try { navigator.vibrate?.(pattern); } catch {} };
  const player = new Audio();
  const isSpeaking = () => cloudPlaying || speechSynthesis.speaking;
  function stopSpeaking() {
    speechSynthesis.cancel();
    player.pause();
    cloudPlaying = false;
  }
  async function speakCloud(text) {
    const body = new FormData();
    body.append('text', text);
    const response = await fetch(api + '/speech', { method: 'POST', body });
    if (!response.ok) throw new Error('voice unavailable');
    const url = URL.createObjectURL(await response.blob());
    const done = () => { cloudPlaying = false; lastSpeechEnd = Date.now(); URL.revokeObjectURL(url); };
    player.onended = done;
    player.onerror = done;
    player.src = url;
    cloudPlaying = true;
    try { await player.play(); } catch (error) { done(); throw error; }
  }
  function speakLocal(text, warning) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = warning ? 1.08 : 1;
    utterance.onend = () => { lastSpeechEnd = Date.now(); };
    speechSynthesis.speak(utterance);
  }
  const plain = text => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const recentlySpoken = [];
  /** True when the microphone just heard GuideBand's own voice coming out of the speakers. */
  function isEcho(heard) {
    const text = plain(heard), now = Date.now();
    return text.length >= 4 && recentlySpoken.some(item => now - item.at < 20000 && item.text.includes(text));
  }
  function speak(text, { warning = false, force = false } = {}) {
    if (!('speechSynthesis' in window) || !text) return;
    recentlySpoken.push({ text: plain(text), at: Date.now() });
    if (recentlySpoken.length > 6) recentlySpoken.shift();
    if (warning) {
      // Warnings never talk over an answer, and stay quiet during a Bridge conversation.
      if (!el('hazardToggle').checked || activeTab === 'bridge' || isSpeaking() || Date.now() - lastReplyAt < 1500) return;
    } else {
      if (!force && !el('voiceToggle').checked) return;
      stopSpeaking();
      lastReplyAt = Date.now();
      if (cloudVoice && Date.now() > cloudVoiceRetryAt) {
        // If the voice service fails (for example, out of credits), use the local voice and retry later.
        return void speakCloud(text).catch(() => { cloudVoiceRetryAt = Date.now() + 120000; speakLocal(text, false); });
      }
    }
    speakLocal(text, warning);
  }

  // ---------- Camera ----------
  const video = el('liveVideo'), overlay = el('liveOverlay'), stage = video.parentElement;
  const grab = document.createElement('canvas');
  let stream = null, facing = 'environment';

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open the camera here. Use Chrome on localhost or HTTPS.');
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 960 } }, audio: false });
    video.srcObject = stream;
    await video.play();
    stage.classList.add('on');
    el('camBtn').textContent = 'Turn camera off';
    hazardLoop();
    syncSigns();
  }
  function stopCamera() {
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    stage.classList.remove('on');
    el('camBtn').textContent = 'Turn camera on';
    el('liveWarning').textContent = '';
    overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
    syncSigns();
  }
  const cameraError = error => addMessage('error', error.name === 'NotAllowedError'
    ? 'Camera permission was denied. Allow the camera for this page and try again.' : error.message);
  el('camBtn').onclick = async () => {
    if (stream) return stopCamera();
    try { await startCamera(); } catch (error) { cameraError(error); }
  };
  el('flipBtn').onclick = async () => {
    facing = facing === 'environment' ? 'user' : 'environment';
    if (!stream) return;
    stopCamera();
    try { await startCamera(); } catch (error) { cameraError(error); }
  };

  /** Current frame as a JPEG blob, or null when the camera is off. */
  function frame(maxWidth = 640) {
    if (!stream || !video.videoWidth) return Promise.resolve(null);
    const scale = Math.min(1, maxWidth / video.videoWidth);
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
      ctx.fillStyle = '#d8ff70'; ctx.fillRect(x, Math.max(0, y - 20), ctx.measureText(d.label).width + 10, 20);
      ctx.fillStyle = '#07120f'; ctx.fillText(d.label, x + 5, Math.max(0, y - 20) + 3);
    }
  }

  // ---------- See: continuous local hazard warnings ----------
  const sources = { gemini: 'Gemini', groq: 'Groq', local: 'on-device' };
  const spokenAt = new Map(), seenAt = new Map(), waiting = new Set();
  let looping = false, busy = false, personSeenAt = 0;
  let candidateKey = '', stable = 0, narratedKey = '', narratedAt = 0;

  async function narrate(blob) {
    try {
      const body = new FormData();
      body.append('image', blob, 'frame.jpg');
      body.append('question', 'The scene just changed. In one short sentence, tell me what is in front of me now.');
      body.append('remember', 'true');
      addLocation(body);
      const scene = await call('/vision/analyze', { method: 'POST', body });
      if (scene.provider && scene.provider !== 'local' && !busy && !isSpeaking()) {
        addMessage('guide', scene.description, 'automatic · ' + sources[scene.provider]);
        speak(scene.description);
      }
    } catch {}
  }

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
            if (activeTab !== 'bridge') drawBoxes(scene.detections); // Bridge draws the hand instead
            if (scene.detections.some(d => d.label === 'person')) personSeenAt = Date.now();
            el('liveWarning').textContent = activeTab === 'bridge' ? '' : scene.warnings.join(' ');
            // Speak a warning when it first appears (or returns after being gone), then stay quiet about it.
            const nowMs = Date.now();
            for (const warning of scene.warnings) {
              const gone = nowMs - (seenAt.get(warning) || 0) > 6000;
              if (gone || nowMs - (spokenAt.get(warning) || 0) > 60000) waiting.add(warning);
              seenAt.set(warning, nowMs);
            }
            for (const warning of [...waiting]) if (!scene.warnings.includes(warning)) waiting.delete(warning);
            const fresh = [...waiting][0];
            if (fresh && activeTab !== 'bridge' && el('hazardToggle').checked && !isSpeaking() && nowMs - lastReplyAt > 1500) {
              waiting.delete(fresh); spokenAt.set(fresh, nowMs);
              speak(fresh, { warning: true }); buzz(400);
            }
            // Narrate only when what is in view has changed and stayed changed.
            const key = [...new Set(scene.detections.filter(d => d.area >= 0.02).map(d => d.label))].sort().join(',');
            if (key === candidateKey) stable++; else { candidateKey = key; stable = 0; }
            if (el('autoDescribe').checked && activeTab !== 'bridge' && key && stable >= 2 && key !== narratedKey
                && Date.now() - narratedAt > 12000 && !busy && !isSpeaking()) {
              narratedKey = key; narratedAt = Date.now();
              narrate(blob);
            }
          }
        } catch { online = false; checkService(); }
      }
      await wait(Math.max(150, 700 - (Date.now() - started)));
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

  let queued = '';
  async function ask(text) {
    text = text.trim();
    if (!text) return;
    if (busy) { queued = text; return; }
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
      addLocation(body);
      const reply = await call('/assistant', { method: 'POST', body });
      pendingItem.remove();
      let meta = reply.provider ? sources[reply.provider] + ' · ' + (reply.latency_ms / 1000).toFixed(1) + ' s' : '';
      if (reply.intent === 'pay_confirm' && reply.order) {
        meta = reply.order.mode === 'stripe_test' ? 'Stripe test payment · ' + reply.order.status + ' · ' + reply.order.payment_id : 'Simulated payment';
      }
      const item = addMessage('guide', reply.say, meta);
      speak(reply.say);
      el('confirmBar').hidden = !reply.confirm;
      if (reply.confirm) { el('confirmText').textContent = reply.confirm; buzz([80, 80, 80]); }
      if (reply.open_url) {
        // WhatsApp only sends when the person presses Send, so hand them the prepared chat.
        const link = document.createElement('a');
        link.className = 'btn btn-primary btn-small msg-link';
        link.href = reply.open_url; link.target = '_blank'; link.rel = 'noopener';
        link.textContent = 'Open WhatsApp';
        item.append(link);
        window.open(reply.open_url, '_blank', 'noopener');
      }
      if (reply.intent === 'nav_stop' || (reply.intent === 'navigate' && !reply.navigating)) el('navStatus').textContent = '';
      if (reply.navigating) el('navStatus').textContent = 'Directions are on. Keep walking — I will speak each turn.';
      if (reply.intent === 'bridge') selectTab('bridge');
      if (activeTab === 'memory') loadMemory();
    } catch (error) {
      pendingItem.remove();
      addMessage('error', error.message || 'Something went wrong.');
    }
    busy = false;
    if (queued) { const next = queued; queued = ''; ask(next); }
  }
  el('askForm').onsubmit = e => { e.preventDefault(); const input = el('askInput'); ask(input.value); input.value = ''; };
  document.querySelectorAll('#live [data-say]').forEach(button => button.onclick = () => ask(button.dataset.say));

  // ---------- Speech in: one microphone listener that is always on ----------
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const WAKE = /^(?:hey |okay |ok )?(?:guide|guides|guyed|guy|god)\b[\s,.!?]*(.*)$/i;
  let recognizer = null, micBlocked = false;

  function micState(text, kind) {
    el('micState').textContent = text;
    el('micState').dataset.state = kind;
  }
  let interimTimer = null, handledText = '', handledAt = 0;
  function heardNote(text, note) {
    micState('Heard: “' + text + '”' + (note ? ' — ' + note : ''), 'on');
  }
  function onInterim(text) {
    clearTimeout(interimTimer);
    if (!text) return;
    if (activeTab === 'bridge') el('bridgeCaption').textContent = text;
    else el('askInput').placeholder = 'Hearing: ' + text;
    // In a noisy room the browser may never decide that the sentence has ended. Decide for it.
    interimTimer = setTimeout(() => { handleSpeech(text); recognizer?.abort(); }, 1400);
  }
  function onFinal(text) {
    clearTimeout(interimTimer);
    handleSpeech(text);
  }
  function handleSpeech(text) {
    el('askInput').placeholder = micPlaceholder();
    if (!text) return;
    const key = plain(text);
    if (key === handledText && Date.now() - handledAt < 6000) return; // the same sentence, delivered twice
    handledText = key; handledAt = Date.now();
    if (isEcho(text)) return heardNote(text, 'ignored, that was my own voice');
    const wake = text.match(WAKE);
    const command = wake ? wake[1].trim() : '';
    if (activeTab === 'bridge') {
      // In a Bridge conversation everything said becomes text and signs for the other person.
      showSpeech(text);
      if (command) ask(command);
      return;
    }
    const answering = !el('confirmBar').hidden && /^(yes|yeah|yep|no|nope|cancel)\b/i.test(text);
    if (command) { heardNote(text); stopSpeaking(); buzz(60); return ask(command); }
    if (answering) { heardNote(text); stopSpeaking(); buzz(60); return ask(text); }
    if (el('wakeToggle').checked) return heardNote(text, 'waiting for “Guide”');
    if (text.split(/\s+/).length < 2) return heardNote(text, 'too short');
    heardNote(text); stopSpeaking(); buzz(60);
    ask(text);
  }
  const micPlaceholder = () => el('wakeToggle').checked ? 'Say “Guide, …” or type here' : 'Just talk, or type here';
  function startMic() {
    if (el('micSource').value) return void startDeviceMic(); // a chosen microphone, e.g. the bracelet
    if (!Recognition || recognizer || micBlocked || !el('micToggle').checked) return;
    const r = new Recognition();
    r.lang = 'en-US'; r.continuous = true; r.interimResults = true;
    r.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript.trim();
        if (e.results[i].isFinal) onFinal(text); else interim += text + ' ';
      }
      onInterim(interim.trim());
    };
    r.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        micBlocked = true;
        micState('Microphone blocked — click anywhere here, then allow it', 'off');
      }
    };
    // The browser stops listening after a pause; start again so the microphone stays on.
    r.onend = () => { if (recognizer === r) recognizer = null; if (!micBlocked) setTimeout(startMic, 250); };
    recognizer = r;
    try {
      r.start();
      if (el('micState').dataset.state !== 'on') micState('Microphone on — listening', 'on'); // keep the last "Heard" note
    } catch { recognizer = null; }
  }
  function stopMic() {
    stopDeviceMic();
    const r = recognizer;
    recognizer = null;
    if (r) { r.onend = null; r.abort(); }
    micState('Microphone off', 'off');
  }
  // ----- A chosen microphone (the Vexo bracelet, a headset…) -----
  // The browser's own speech recognition can only use the default microphone, so audio from a
  // chosen one is cut into sentences here by loudness and transcribed by the service (Deepgram).
  let capture = null;
  function stopDeviceMic() {
    if (!capture) return;
    clearInterval(capture.timer);
    capture.stream.getTracks().forEach(track => track.stop());
    capture.context.close();
    capture = null;
  }
  async function sendClip(blob) {
    try {
      const body = new FormData();
      body.append('audio', blob, 'speech.webm');
      const result = await call('/speech/transcribe', { method: 'POST', body });
      if (result.text) handleSpeech(result.text); else micState('Listening through ' + sourceName(), 'on');
    } catch (error) { micState('Could not transcribe: ' + error.message, 'off'); }
  }
  const sourceName = () => el('micSource').selectedOptions[0]?.textContent || 'the chosen microphone';
  async function startDeviceMic() {
    if (capture || !el('micToggle').checked) return;
    const deviceId = el('micSource').value;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true } });
    } catch { return micState('Could not open that microphone', 'off'); }
    if (capture || el('micSource').value !== deviceId) return stream.getTracks().forEach(track => track.stop());
    const context = new AudioContext(), analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let recorder = null, chunks = [], startedAt = 0, lastLoudAt = 0, floor = 0.01;
    capture = { stream, context, timer: setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) sum += value * value;
      const level = Math.sqrt(sum / samples.length), now = performance.now();
      const loud = level > Math.max(0.015, floor * 3) && !isSpeaking();
      if (!recorder) floor = floor * 0.97 + level * 0.03; // follow the room noise while nobody talks
      if (loud) {
        lastLoudAt = now;
        if (!recorder) {
          chunks = []; startedAt = now;
          recorder = new MediaRecorder(stream);
          recorder.ondataavailable = event => chunks.push(event.data);
          recorder.start();
          micState('Hearing you through ' + sourceName() + '…', 'on');
        }
      } else if (recorder && (now - lastLoudAt > 900 || now - startedAt > 15000)) {
        const finished = recorder, spoke = lastLoudAt - startedAt;
        recorder = null;
        finished.onstop = () => { if (spoke > 350) sendClip(new Blob(chunks, { type: finished.mimeType })); };
        finished.stop();
      }
    }, 50) };
    micState('Listening through ' + sourceName(), 'on');
  }
  async function listMicrophones() {
    try {
      // Device names are only shown after the microphone permission has been given once.
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach(track => track.stop());
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
      const select = el('micSource'), current = select.value;
      select.length = 1;
      for (const device of devices) select.add(new Option(device.label || 'Microphone', device.deviceId));
      const bracelet = devices.find(d => /vexo|hack/i.test(d.label));
      select.value = bracelet ? bracelet.deviceId : (devices.some(d => d.deviceId === current) ? current : '');
      if (bracelet) addMessage('guide', 'I found the bracelet microphone (' + bracelet.label + ') and I am listening through it.');
      el('micSource').onchange();
    } catch { micState('Microphone permission is needed to list microphones', 'off'); }
  }
  el('micRefresh').onclick = listMicrophones;
  el('micSource').onchange = () => {
    // Switch between the browser's recognition and the chosen microphone.
    const r = recognizer;
    recognizer = null;
    if (r) { r.onend = null; r.abort(); }
    stopDeviceMic();
    micState('Microphone off', 'off');
    if (el('micToggle').checked) startMic();
  };

  if (!Recognition) {
    el('micToggle').checked = false;
    el('micToggle').disabled = true;
    micState('Voice input isn’t available in this browser — type instead, or use Chrome', 'off');
  } else {
    el('micToggle').onchange = () => { micBlocked = false; el('micToggle').checked ? startMic() : stopMic(); };
    // A first click anywhere in the demo is enough for the browser to allow the microphone.
    el('live').addEventListener('click', () => { if (micBlocked) { micBlocked = false; startMic(); } });
    startMic();
  }

  // ---------- Bridge: signs are read on this device and spoken; speech becomes text and fingerspelling ----------
  const signHandlers = {
    onUpdate: state => {
      el('signLive').textContent = state.current
        ? state.current + ' · ' + Math.round(state.confidence * 100) + '% sure'
        : 'No sign in view';
      el('signMeter').style.width = Math.round(state.progress * 100) + '%';
      el('signOut').textContent = state.text.trim() || '—';
    },
    onWord: word => { if (word) { speak(word.toLowerCase(), { force: true }); buzz(60); } },
  };
  async function syncSigns() {
    if (activeTab !== 'bridge' || !stream) {
      if (GuideSigns.running) GuideSigns.stop();
      if (activeTab === 'bridge') el('bridgeState').textContent = 'Turn the camera on so I can see signs.';
      return;
    }
    el('bridgeState').textContent = 'Loading the sign reader…';
    try {
      await GuideSigns.start(video, overlay, signHandlers);
      el('bridgeState').textContent = 'Reading signs live, on this device.';
    } catch {
      el('bridgeState').textContent = 'The sign reader could not load. Check the internet connection and reopen Bridge.';
    }
  }
  document.querySelectorAll('#live [name="signMode"]').forEach(radio => {
    radio.onchange = () => { GuideSigns.setMode(radio.value); GuideSigns.clear(); };
  });
  el('signClear').onclick = () => GuideSigns.clear();

  // Speech to sign: show what was said as ASL fingerspelling, one handshape per letter.
  const signImage = letter => 'https://commons.wikimedia.org/wiki/Special:FilePath/Sign_language_' + letter + '.svg';
  let spellRun = 0;
  async function fingerspell(text) {
    const run = ++spellRun, strip = el('spellOut');
    const words = text.replace(/[^A-Za-z' ]/g, '').split(/ +/).filter(Boolean).slice(0, 14);
    strip.replaceChildren();
    for (const word of words) {
      // Each word gets its own line: the word itself, then one handshape per letter.
      const line = document.createElement('div'), label = document.createElement('span'), group = document.createElement('span');
      line.className = 'spell-line';
      label.className = 'spell-label';
      label.textContent = word;
      group.className = 'spell-word';
      line.append(label, group);
      strip.append(line);
      for (const letter of word.toUpperCase().replace(/[^A-Z]/g, '')) {
        if (run !== spellRun) return; // something newer was said
        const card = document.createElement('figure'), image = new Image(), caption = document.createElement('figcaption');
        card.className = 'spell-card';
        image.alt = '';
        image.onerror = () => image.remove(); // the letter itself still shows
        image.src = signImage(letter);
        caption.textContent = letter;
        card.append(image, caption);
        group.append(card);
        strip.scrollTop = strip.scrollHeight;
        await wait(300);
      }
      await wait(250);
    }
  }
  // Big view to turn towards the other person: only what you said, as large as the screen allows.
  const facingView = el('facing');
  el('facingBtn').onclick = () => {
    const open = !facingView.classList.contains('facing-open');
    facingView.classList.toggle('facing-open', open);
    el('facingBtn').textContent = open ? 'Close big view' : 'Show them — big view';
    if (open) facingView.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen();
  };
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && facingView.classList.contains('facing-open')) {
      facingView.classList.remove('facing-open');
      el('facingBtn').textContent = 'Show them — big view';
    }
  });
  function showSpeech(text) {
    el('bridgeCaption').textContent = text;
    fingerspell(text);
  }
  el('speakForm').onsubmit = e => {
    e.preventDefault();
    const text = el('speakInput').value.trim();
    if (!text) return;
    showSpeech(text);
    speak(text, { force: true });
    el('speakInput').value = '';
  };

  // ---------- Location and directions ----------
  let position = null, lastSent = 0, watchId = null;
  function addLocation(body) {
    if (position) { body.append('lat', position.lat); body.append('lon', position.lon); }
  }
  function onPosition(fix) {
    position = { lat: fix.coords.latitude, lon: fix.coords.longitude };
    if (!online || Date.now() - lastSent < 4000) return;
    lastSent = Date.now();
    const body = new FormData();
    addLocation(body);
    body.append('session', session);
    call('/location', { method: 'POST', body }).then(nav => {
      if (nav.active) el('navStatus').textContent = 'Walking to ' + nav.destination + ' · ' + nav.remaining + ' to go';
      else if (nav.say) el('navStatus').textContent = '';
      if (nav.say) { addMessage('guide', nav.say, 'directions'); speak(nav.say); buzz([200, 100, 200]); }
    }).catch(() => {});
  }
  el('locationToggle').onchange = () => {
    if (!el('locationToggle').checked) {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null; position = null; el('navStatus').textContent = '';
      return;
    }
    if (!navigator.geolocation) { el('locationToggle').checked = false; return addMessage('error', 'This browser cannot share location.'); }
    watchId = navigator.geolocation.watchPosition(onPosition, () => {
      el('locationToggle').checked = false; watchId = null;
      addMessage('error', 'Location permission was denied. Directions need it.');
    }, { enableHighAccuracy: true, maximumAge: 2000 });
  };

  // ---------- Family contacts ----------
  async function loadContacts() {
    if (!online) return;
    try {
      const contacts = await call('/contacts');
      const list = el('contactList');
      list.replaceChildren();
      for (const contact of contacts) {
        const item = document.createElement('li'), small = document.createElement('small'), remove = document.createElement('button');
        item.textContent = contact.name;
        small.textContent = '+' + contact.phone;
        remove.type = 'button'; remove.className = 'link-button'; remove.textContent = 'Remove';
        remove.setAttribute('aria-label', 'Remove ' + contact.name);
        remove.onclick = () => call('/contacts/' + encodeURIComponent(contact.name), { method: 'DELETE' }).then(loadContacts).catch(() => {});
        item.append(small, remove);
        list.append(item);
      }
      if (!contacts.length) { const empty = document.createElement('li'); empty.className = 'memory-empty'; empty.textContent = 'No contacts yet.'; list.append(empty); }
    } catch {}
  }
  el('contactForm').onsubmit = async e => {
    e.preventDefault();
    const body = new FormData();
    body.append('name', el('contactName').value);
    body.append('phone', el('contactPhone').value);
    try {
      await call('/contacts', { method: 'POST', body });
      el('contactName').value = ''; el('contactPhone').value = ''; el('contactHint').textContent = '';
      loadContacts();
    } catch (error) { el('contactHint').textContent = error.message; }
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
    addLocation(body);
    call('/memory/observe', { method: 'POST', body }).then(() => { if (activeTab === 'memory') loadMemory(); }).catch(() => {});
  }, 20000);

  // ---------- Tabs ----------
  const tabs = [...document.querySelectorAll('#live .tab')];
  function selectTab(name) {
    activeTab = name;
    tabs.forEach(tab => {
      const selected = tab.id === 'tab-' + name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      el(tab.getAttribute('aria-controls')).hidden = !selected;
    });
    el('askInput').placeholder = micPlaceholder();
    if (name === 'memory') loadMemory();
    if (name === 'family') loadContacts();
    if (name === 'bridge') el('liveWarning').textContent = '';
    syncSigns();
    startMic(); // switching tabs never leaves the microphone off
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
