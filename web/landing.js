// GuideBand landing — small progressive enhancements. The page works without this file.
// Light that follows the pointer across glass surfaces.
document.querySelectorAll('.glass').forEach(el => {
  el.addEventListener('pointermove', e => {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    el.style.setProperty('--my', (e.clientY - r.top) + 'px');
  });
});

// Example commands shown in the phone demo.
const scenes = {
  walk: {
    heard: '“In 30 minutes, help me walk to Safeway.”',
    reply: 'I’ll remind you in 30 minutes and prepare walking directions to Safeway.',
    title: 'Schedule your walk?'
  },
  call: {
    heard: '“Call Alex.”',
    reply: 'I’ll open the phone dialer. The call won’t begin until you confirm.',
    title: 'Call Alex?'
  },
  message: {
    heard: '“Read my WhatsApp messages.”',
    reply: 'I’ll open WhatsApp for you. Nothing is sent until you say yes.',
    title: 'Open WhatsApp?'
  },
  bridge: {
    heard: '“Start Bridge.”',
    reply: 'I’ll show large live captions and speak your typed phrases aloud.',
    title: 'Start Bridge mode?'
  }
};
const chat = document.querySelector('.chat');
const chips = document.querySelectorAll('.chip');
chips.forEach(chip => chip.addEventListener('click', () => {
  const scene = scenes[chip.dataset.scene];
  if (!scene) return;
  chips.forEach(c => c.setAttribute('aria-pressed', String(c === chip)));
  document.getElementById('demoHeard').textContent = scene.heard;
  document.getElementById('demoReply').textContent = scene.reply;
  document.getElementById('demoTitle').textContent = scene.title;
  chat.classList.remove('swap');
  void chat.offsetWidth; // restart the entrance animation
  chat.classList.add('swap');
}));
