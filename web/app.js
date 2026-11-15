// GuideBand Modern Desktop Application Controller
(() => {
  const $ = s => document.querySelector(s);
  const API = 'http://localhost:8000';

  // --- Clock ---
  function updateClock() {
    const d = new Date();
    const dayStr = d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
    const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const pill = $('#clockPill');
    if (pill) pill.innerHTML = `<span class="dot"></span>${dayStr} · ${timeStr}`;
  }
  updateClock();
  setInterval(updateClock, 1000);

  // --- Speech Out (Deepgram Aura TTS with Web Speech fallback) ---
  const player = new Audio();
  async function speak(text) {
    if (!text) return;
    try {
      const body = new FormData();
      body.append('text', text);
      const res = await fetch(`${API}/speech`, { method: 'POST', body });
      if (res.ok) {
        const url = URL.createObjectURL(await res.blob());
        player.src = url;
        player.play();
        return;
      }
    } catch (_) {}
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0;
      window.speechSynthesis.speak(u);
    }
  }

  // --- Vexo Band Status Poller ---
  let bandConnected = false;
  async function pollWearableStatus() {
    try {
      const res = await fetch(`${API}/wearable/status`);
      if (res.ok) {
        const data = await res.json();
        bandConnected = Boolean(data.connected);
        const name = data.band_name || 'Vexo-HACK-20';
        const batt = data.battery?.percent != null ? `${data.battery.percent}%` : '95%';
        const transport = (data.transport || 'ble').toUpperCase();

        const dot = $('#bandDot');
        const bandName = $('#bandName');
        const bandBattery = $('#bandBattery');
        const bandBtn = $('#bandListenBtn');

        if (dot && bandName && bandBattery) {
          if (bandConnected) {
            dot.className = 'dot';
            bandName.textContent = name;
            bandBattery.textContent = `${batt} (${transport})`;
            if (bandBtn) bandBtn.style.display = 'inline-flex';
          } else {
            dot.className = 'dot dot-searching';
            bandName.textContent = name;
            bandBattery.textContent = 'Searching BLE...';
          }
        }
      }
    } catch (_) {
      // Backend might be offline
      const dot = $('#bandDot');
      if (dot) dot.className = 'dot dot-searching';
    }
  }
  pollWearableStatus();
  setInterval(pollWearableStatus, 4000);

  // --- Camera Frame Snapshot Helper ---
  async function getCameraFrameBlob() {
    const video = $('#appVideo');
    if (!camStream || !video || video.readyState < 2 || !video.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(video.videoWidth, 640);
    canvas.height = Math.round(canvas.width * (video.videoHeight / video.videoWidth));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  }

  // --- Vexo Band Voice Listening (BLE -> Deepgram Nova-3 -> Assistant) ---
  let isListeningBand = false;
  async function listenThroughBand(seconds = 6) {
    if (isListeningBand) return;
    isListeningBand = true;

    const btn = $('#bandListenBtn');
    const orb = $('#talkOrb');
    const stateLabel = $('#talkState');
    const heardEl = $('#heardText');
    const replyEl = $('#replyText');

    if (btn) {
      btn.classList.add('listening');
      $('#bandBtnText').textContent = 'Listening…';
    }
    if (orb) orb.classList.add('listening');
    if (stateLabel) stateLabel.textContent = 'Listening to Vexo-HACK-20 over Bluetooth (Opus)…';
    if (heardEl) heardEl.textContent = 'Streaming audio to Deepgram Nova-3…';

    try {
      const frameBlob = await getCameraFrameBlob();
      const body = new FormData();
      body.append('seconds', String(seconds));
      body.append('language', 'en');
      if (frameBlob) {
        body.append('image', frameBlob, 'frame.jpg');
      }

      const res = await fetch(`${API}/wearable/listen`, {
        method: 'POST',
        body
      });
      if (res.ok) {
        const data = await res.json();
        if (data.ok && data.text) {
          heardEl.textContent = `“${data.text}”`;
          replyEl.textContent = data.say || 'Understood.';
          speak(data.say);
        } else {
          heardEl.textContent = 'No speech detected on band.';
          replyEl.textContent = data.say || 'Try speaking closer to your wrist or hold to talk.';
        }
      } else {
        heardEl.textContent = 'Could not stream band audio.';
        replyEl.textContent = 'Check that the band is powered on and near your Mac.';
      }
    } catch (err) {
      heardEl.textContent = 'Connection error with GuideBand backend.';
      replyEl.textContent = String(err);
    } finally {
      isListeningBand = false;
      if (btn) {
        btn.classList.remove('listening');
        $('#bandBtnText').textContent = 'Listen on Band';
      }
      if (orb) orb.classList.remove('listening');
      if (stateLabel) stateLabel.textContent = 'Tap or hold to speak';
    }
  }

  const bandBtn = $('#bandListenBtn');
  if (bandBtn) bandBtn.onclick = () => listenThroughBand(6);

  // --- Talk Orb: Band BLE or Browser Mic fallback ---
  const orb = $('#talkOrb');
  if (orb) {
    orb.onclick = () => {
      if (bandConnected) {
        listenThroughBand(6);
      } else {
        browserListen();
      }
    };
  }

  // --- Browser Speech Recognition Fallback ---
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  function browserListen() {
    if (!SpeechRec) {
      $('#heardText').textContent = 'Speech recognition unavailable.';
      return;
    }
    const r = new SpeechRec();
    r.lang = 'en-US';
    r.interimResults = true;
    const orb = $('#talkOrb');
    const stateLabel = $('#talkState');
    if (orb) orb.classList.add('listening');
    if (stateLabel) stateLabel.textContent = 'Listening through Mac microphone…';

    r.onresult = async e => {
      const text = [...e.results].map(x => x[0].transcript).join('');
      $('#heardText').textContent = `“${text}”`;
      if (e.results[e.results.length - 1].isFinal) {
        sendAssistantCommand(text);
      }
    };
    r.onerror = e => {
      if (stateLabel) stateLabel.textContent = `Microphone: ${e.error}`;
    };
    r.onend = () => {
      if (orb) orb.classList.remove('listening');
      if (stateLabel) stateLabel.textContent = 'Tap or hold to speak';
    };
    r.start();
  }

  // --- Send Command to Assistant ---
  async function sendAssistantCommand(text) {
    try {
      const frameBlob = await getCameraFrameBlob();
      const body = new FormData();
      body.append('text', text);
      if (frameBlob) {
        body.append('image', frameBlob, 'frame.jpg');
      }
      const res = await fetch(`${API}/assistant`, { method: 'POST', body });
      if (res.ok) {
        const data = await res.json();
        $('#replyText').textContent = data.say || 'Action complete.';
        speak(data.say);
      }
    } catch (_) {}
  }

  // --- Quick Command Chips ---
  document.querySelectorAll('[data-command]').forEach(btn => {
    btn.onclick = () => {
      const cmd = btn.dataset.command;
      $('#heardText').textContent = `“${cmd}”`;
      sendAssistantCommand(cmd);
    };
  });

  // --- Micro-Whisper Tactile Cue Demo ---
  const whisperBtn = $('#whisperBtn');
  if (whisperBtn) {
    whisperBtn.onclick = async () => {
      const cues = [
        { word: 'Ле-во', delay: 1600 },
        { word: 'Пря-мо', delay: 1600 },
        { word: 'Пра-во', delay: 1600 },
        { word: 'Стоп!', delay: 2000 }
      ];
      $('#heardText').textContent = 'Micro-whisper haptic directional cues';
      for (const cue of cues) {
        $('#replyText').textContent = `Haptic audio cue: “${cue.word}”`;
        speak(cue.word);
        await new Promise(r => setTimeout(r, cue.delay));
      }
      $('#replyText').textContent = 'Cues complete.';
    };
  }

  // --- Live Camera Preview & Radar ---
  let camStream = null;
  const camBtn = $('#camToggleBtn');
  if (camBtn) {
    camBtn.onclick = async () => {
      const video = $('#appVideo');
      const emptyMsg = $('#camEmptyMsg');
      if (camStream) {
        camStream.getTracks().forEach(t => t.stop());
        camStream = null;
        if (video) video.style.display = 'none';
        if (emptyMsg) emptyMsg.style.display = 'block';
        camBtn.textContent = 'Turn Camera On';
      } else {
        try {
          camStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } } });
          if (video) {
            video.srcObject = camStream;
            video.style.display = 'block';
            video.play();
          }
          if (emptyMsg) emptyMsg.style.display = 'none';
          camBtn.textContent = 'Turn Camera Off';
        } catch (err) {
          alert('Could not access camera: ' + err.message);
        }
      }
    };
  }

  // --- Bridge Dialog ---
  const bridgeDialog = $('#bridgeDialog');
  const bridgeBtn = $('#bridgeBtn');
  if (bridgeBtn && bridgeDialog) {
    bridgeBtn.onclick = () => bridgeDialog.showModal();
    $('#bridgeSpeakBtn').onclick = () => speak($('#bridgeInput').value);
  }

  // --- Guardian Toggle ---
  const guardian = $('#guardianToggle');
  if (guardian) {
    guardian.onchange = e => {
      const label = $('#guardianStatusLabel');
      if (e.target.checked) {
        if (label) label.textContent = 'Live Sharing Active';
        speak('Guardian live sharing enabled for this journey.');
      } else {
        if (label) label.textContent = 'Off';
        speak('Guardian sharing disabled.');
      }
    };
  }
})();
