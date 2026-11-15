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
  const WINDOW = 10, WORD_VOTES = 7; // a sign must be seen in 7 of the last 10 frames, about half a second

  let detector = null, model = null, loading = null;
  let running = false, video = null, canvas = null, handlers = {}, mode = 'words';
  let lastDetect = 0;
  // letters
  let candidate = '', candidateFrames = 0, lastLetter = '', lastLetterAt = 0, lastHandAt = 0, spelled = '', wordStart = 0;
  // words
  let votes = [], lastWord = '', lastWordAt = 0, heldWord = '';

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

  // ----- words: whole-hand signs, read from how straight each finger is -----
  // A finger counts as up or folded by the bend at its joints, not by where it sits in the picture,
  // so the hand can be tilted or turned and the reading stays the same.
  const sub = (a, b) => [a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0)];
  const len = v => Math.hypot(v[0], v[1], v[2]) || 1e-6;
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const dist = (a, b) => len(sub(a, b));
  /** 1 = perfectly straight, 0 = bent at a right angle, negative = folded back. */
  function straightness(p, base, middle, tip) {
    const first = sub(p[middle], p[base]), second = sub(p[tip], p[middle]);
    return dot(first, second) / (len(first) * len(second));
  }
  function handShape(p) {
    const size = dist(p[0], p[9]); // wrist to the middle knuckle: the hand's own ruler
    const finger = (mcp, pip, dip, tip) => {
      const bend = Math.min(straightness(p, mcp, pip, dip), straightness(p, pip, dip, tip));
      const reach = dist(p[tip], p[0]) / dist(p[mcp], p[0]); // a folded finger's tip comes back to the palm
      if (bend > 0.75 && reach > 1.45) return 'up';
      if (bend < 0.35 || reach < 1.2) return 'down';
      return 'half';
    };
    const thumbStraight = straightness(p, 2, 3, 4);
    const thumbAway = dist(p[4], p[5]) / size;   // from the index knuckle
    const thumbOut = dist(p[4], p[17]) / dist(p[2], p[17]);
    let thumb = 'half';
    if (thumbStraight > 0.7 && thumbAway > 0.6 && thumbOut > 1.15) thumb = 'up';
    else if (thumbAway < 0.45 || thumbOut < 1.0) thumb = 'down';
    const direction = sub(p[4], p[2]);
    return {
      size, thumb,
      index: finger(5, 6, 7, 8), middle: finger(9, 10, 11, 12), ring: finger(13, 14, 15, 16), pinky: finger(17, 18, 19, 20),
      thumbUpward: -direction[1] / len(direction),            // 1 = pointing to the top of the picture
      pinch: dist(p[4], p[8]) / size,                          // thumb tip to index tip
    };
  }
  function readWord(p) {
    const s = handShape(p);
    const up = name => s[name] === 'up', down = name => s[name] === 'down';
    const fingersUp = ['index', 'middle', 'ring', 'pinky'].filter(up).length;
    const fingersDown = ['index', 'middle', 'ring', 'pinky'].filter(down).length;

    // Thumb and index fingertips touching, the other three fingers up.
    if (s.pinch < 0.3 && up('middle') && up('ring') && up('pinky') && !up('index')) return 'OK';
    // "I love you": thumb, index and little finger up, middle and ring folded.
    if (up('index') && up('pinky') && down('middle') && down('ring') && s.thumb !== 'down') return 'I love you';
    // A fist with only the thumb out: up is yes, down is no.
    if (fingersDown === 4 && s.thumb === 'up') {
      if (s.thumbUpward > 0.55) return 'Yes';
      if (s.thumbUpward < -0.55) return 'No';
      return '';
    }
    if (fingersUp === 4 && s.thumb === 'up') return 'Hello';
    // Four fingers up with the thumb folded across the palm: the first move of the Signal for Help.
    if (fingersUp === 4 && s.thumb === 'down') return 'Help';
    if (up('index') && up('middle') && up('ring') && down('pinky')) return 'Water';
    if (up('index') && up('middle') && down('ring') && down('pinky')) return 'Peace';
    if (up('pinky') && s.thumb === 'up' && down('index') && down('middle') && down('ring')) return 'Call me';
    if (up('index') && fingersUp === 1 && s.thumb !== 'up') return 'You';
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
    // A sign that is simply being held is said once. It may be said again only after the hand
    // has gone away or has shown something else for a moment.
    const empty = votes.filter(vote => !vote).length;
    if (!word || (word !== lastWord && count < 3 && empty >= WINDOW - 3)) heldWord = '';
    if (empty === WINDOW) { heldWord = ''; lastWord = ''; }
    if (word && count >= WORD_VOTES && word !== heldWord) {
      heldWord = word; lastWord = word; lastWordAt = now;
      spelled = (spelled + ' ' + word).trim().split(' ').slice(-12).join(' ');
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
    // The camera picture may be zoomed around its centre; draw the hand at the same zoom.
    const zoom = Number(canvas.dataset.zoom) || 1;
    const at = pt => [w / 2 + (dx + pt.x * video.videoWidth * scale - w / 2) * zoom,
      h / 2 + (dy + pt.y * video.videoHeight * scale - h / 2) * zoom];
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
    setMode(next) { mode = next; votes = []; heldWord = ''; candidate = ''; candidateFrames = 0; },
    clear() { spelled = ''; wordStart = 0; lastLetter = ''; lastWord = ''; heldWord = ''; emit('', 0, 0); },
    readWord, // exposed so the rules can be checked without a camera
  };
})();
