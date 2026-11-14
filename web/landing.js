// GuideBand landing — small progressive enhancements. The page works without this file.

// Light that follows the pointer across glass surfaces.
document.querySelectorAll('.glass').forEach(el => {
  el.addEventListener('pointermove', e => {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    el.style.setProperty('--my', (e.clientY - r.top) + 'px');
  });
});

// Examples shown in the phone demo. `confirm` shows the yes / not-now buttons.
const scenes = {
  see: {
    heard: '“What’s in front of me?”',
    reply: 'Chair ahead, slightly left. The doorway is clear beyond it.',
    eyebrow: 'Detected on device',
    title: 'Chair · ahead, left',
    detail: 'Processed locally. No video stored.'
  },
  remember: {
    heard: '“Where did I leave my keys?”',
    reply: 'On the kitchen counter, next to the kettle. I saw them 20 minutes ago.',
    eyebrow: 'From your memory',
    title: 'Keys · kitchen counter',
    detail: 'Last seen 20 minutes ago.'
  },
  act: {
    heard: '“Buy me a coffee.”',
    reply: 'One medium latte for $4.50. Should I pay?',
    eyebrow: 'Please confirm',
    title: 'Pay $4.50 for a latte?',
    confirm: true
  },
  bridge: {
    heard: '“Start Bridge.”',
    reply: 'I’ll speak signed phrases aloud and show replies as large captions.',
    eyebrow: 'Coming soon',
    title: 'Bridge mode',
    detail: 'Sign language, voiced.'
  }
};
const byId = id => document.getElementById(id);
const chat = document.querySelector('.chat');
const chips = document.querySelectorAll('.chip');
chips.forEach(chip => chip.addEventListener('click', () => {
  const scene = scenes[chip.dataset.scene];
  if (!scene) return;
  chips.forEach(c => c.setAttribute('aria-pressed', String(c === chip)));
  byId('demoHeard').textContent = scene.heard;
  byId('demoReply').textContent = scene.reply;
  byId('demoEyebrow').textContent = scene.eyebrow;
  byId('demoTitle').textContent = scene.title;
  byId('demoDetail').textContent = scene.detail || '';
  byId('demoDetail').hidden = !scene.detail;
  byId('demoActions').hidden = !scene.confirm;
  chat.classList.remove('swap');
  void chat.offsetWidth; // restart the entrance animation
  chat.classList.add('swap');
}));
