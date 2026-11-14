// GuideBand sign reading, fully on-device.
// MediaPipe finds 21 hand landmarks per frame; a small linear model (trained for
// GuideLens) classifies ASL fingerspelling letters from them, and a few simple
// finger-shape rules recognise whole-hand signs. Nothing leaves the browser.
window.GuideSigns = (() => {
  const BUNDLE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/vision_bundle.mjs';
  const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm';
  const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
  const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

  const MIN_LETTER_CONFIDENCE = 0.62, HOLD_FRAMES = 6, REPEAT_MS = 1200, SPACE_MS = 1800;
  const WINDOW = 8, WORD_VOTES = 6, WORD_REPEAT_MS = 3000;

  let detector = null, model = null, loading = null;
  let running = false, video = null, canvas = null, handlers = {}, mode = 'words';
  let lastDetect = 0;
  // letters
  let candidate = '', candidateFrames = 0, lastLetter = '', lastLetterAt = 0, lastHandAt = 0, spelled = '', wordStart = 0;
  // words
  let votes = [], lastWord = '', lastWordAt = 0;

  function load() {
    loading ||= (async () => {
      const [vision, json] = await Promise.all([
        import(BUNDLE),
        fetch('models/asl_fingerspelling_landmarks.json').then(r => r.json()),
      ]);
      model = json;
      const files = await vision.FilesetResolver.forVisionTasks(WASM);
      detector = await vision.HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO', numHands: 1,
      });
    })().catch(error => { loading = null; throw error; });
    return loading;
  }

  // ----- letters: same normalisation and linear model as the GuideLens training pipeline -----
  function classifyLetter(points, handedness) {
    const left = handedness.toLowerCase() === 'left';
    const p = points.map(pt => [left ? 1 - pt.x : pt.x, pt.y, pt.z || 0]);
    const scale = Math.hypot(p[9][0] - p[0][0], p[9][1] - p[0][1]);
    if (scale < 1e-5) return null;
    const x = new Float32Array(63);
    for (let i = 0; i < 21; i++) for (let k = 0; k < 3; k++) {
      const j = i * 3 + k;
      x[j] = ((p[i][k] - p[0][k]) / scale - model.scaler.mean[j]) / (model.scaler.scale[j] || 1);
    }
    const logits = model.classifier.coef.map((row, c) => row.reduce((sum, w, j) => sum + w * x[j], model.classifier.intercept[c]));
    const max = Math.max(...logits);
    const exps = logits.map(v => Math.exp(v - max));
    const total = exps.reduce((a, b) => a + b, 0);
    const best = exps.indexOf(Math.max(...exps));
    return { label: model.labels[best], confidence: exps[best] / total };
  }

  // ----- words: whole-hand shapes from which fingers are extended -----
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function handShape(p) {
    const size = dist(p[0], p[9]);
    const up = (tip, pip) => dist(p[tip], p[0]) > dist(p[pip], p[0]) * 1.15;
    const thumb = dist(p[4], p[17]) > dist(p[2], p[17]) * 1.2 && dist(p[4], p[5]) > size * 0.45;
    return { thumb, index: up(8, 6), middle: up(12, 10), ring: up(16, 14), pinky: up(20, 18), size };
  }
  function readWord(p) {
    const s = handShape(p);
    const fingers = [s.index, s.middle, s.ring, s.pinky].filter(Boolean).length;
    if (s.thumb && fingers === 4) return 'Hello';
    if (s.thumb && s.index && s.pinky && !s.middle && !s.ring) return 'I love you';
    if (s.index && s.middle && !s.ring && !s.pinky) return 'Peace';
    if (s.thumb && fingers === 0) {
      if (p[4].y < p[2].y - s.size * 0.35) return 'Yes';
      if (p[4].y > p[2].y + s.size * 0.35) return 'No';
    }
    return '';
  }

  function emit(current, confidence, progress) {
    handlers.onUpdate?.({ mode, current, confidence, progress, text: spelled });
  }

  function stepLetters(points, handedness, now) {
    if (!points) {
      // A pause with no hand in view ends the word: say it.
      if (spelled.length > wordStart && now - lastHandAt > SPACE_MS) {
        handlers.onWord?.(spelled.slice(wordStart).trim(), null);
        spelled += ' ';
        wordStart = spelled.length;
        lastLetter = '';
      }
      candidateFrames = Math.max(0, candidateFrames - 1);
      return emit('', 0, 0);
    }
    lastHandAt = now;
    const guess = classifyLetter(points, handedness);
    if (!guess || guess.confidence < MIN_LETTER_CONFIDENCE) {
      candidateFrames = Math.max(0, candidateFrames - 1);
      return emit(guess?.label || '', guess?.confidence || 0, 0);
    }
    if (guess.label === candidate) candidateFrames++; else { candidate = guess.label; candidateFrames = 1; }
    if (candidateFrames >= HOLD_FRAMES && (candidate !== lastLetter || now - lastLetterAt >= REPEAT_MS)) {
      spelled += candidate;
      lastLetter = candidate; lastLetterAt = now; candidateFrames = 0;
      handlers.onLetter?.(candidate);
    }
    emit(guess.label, guess.confidence, Math.min(1, candidateFrames / HOLD_FRAMES));
  }

  function stepWords(points, now) {
    votes.push(points ? readWord(points) : '');
    if (votes.length > WINDOW) votes.shift();
    const counts = {};
    for (const vote of votes) if (vote) counts[vote] = (counts[vote] || 0) + 1;
    const [word, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || ['', 0];
    const confidence = count / WINDOW;
    if (word && count >= WORD_VOTES && (word !== lastWord || now - lastWordAt > WORD_REPEAT_MS)) {
      lastWord = word; lastWordAt = now;
      spelled = (spelled + ' ' + word).trim();
      handlers.onWord?.(word, confidence);
    }
    emit(word, confidence, Math.min(1, count / WORD_VOTES));
  }

  function draw(points) {
    const stage = canvas.parentElement;
    const w = canvas.width = stage.clientWidth, h = canvas.height = stage.clientHeight;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (!points || !video.videoWidth) return;
    // Same mapping as object-fit: cover on the video element.
    const scale = Math.max(w / video.videoWidth, h / video.videoHeight);
    const dx = (w - video.videoWidth * scale) / 2, dy = (h - video.videoHeight * scale) / 2;
    const at = pt => [dx + pt.x * video.videoWidth * scale, dy + pt.y * video.videoHeight * scale];
    ctx.strokeStyle = '#d8ff70'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    for (const [a, b] of BONES) { ctx.beginPath(); ctx.moveTo(...at(points[a])); ctx.lineTo(...at(points[b])); ctx.stroke(); }
    ctx.fillStyle = '#ffffff';
    for (const pt of points) { ctx.beginPath(); ctx.arc(...at(pt), 4, 0, Math.PI * 2); ctx.fill(); }
  }

  function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    const now = performance.now();
    if (!detector || video.readyState < 2 || now - lastDetect < 60) return; // about 15 frames a second
    lastDetect = now;
    let result;
    try { result = detector.detectForVideo(video, now); } catch { return; }
    const points = result.landmarks?.[0] || null;
    const handedness = (result.handednesses || result.handedness)?.[0]?.[0]?.categoryName || 'Right';
    draw(points);
    if (mode === 'letters') stepLetters(points, handedness, Date.now()); else stepWords(points, Date.now());
  }

  return {
    get running() { return running; },
    async start(videoElement, canvasElement, callbacks) {
      video = videoElement; canvas = canvasElement; handlers = callbacks || {};
      if (running) return;
      running = true;
      try { await load(); } catch (error) { running = false; throw error; }
      if (running) loop();
    },
    stop() {
      running = false;
      canvas?.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    },
    setMode(next) { mode = next; votes = []; candidate = ''; candidateFrames = 0; },
    clear() { spelled = ''; wordStart = 0; lastLetter = ''; lastWord = ''; emit('', 0, 0); },
  };
})();
