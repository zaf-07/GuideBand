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

// Device-aware download recommendation. Detection stays local in the browser.
const release = 'https://github.com/zaf-07/GuideBand/releases/download/v0.1.0/';
const osIcons = {
  android: '<svg viewBox="0 0 24 24"><path d="M6 9h12v9.5a2 2 0 01-2 2H8a2 2 0 01-2-2V9zM8 9a4 4 0 018 0M8 5.5L6.5 3.5M16 5.5l1.5-2M9 12v4M15 12v4"/></svg>',
  macos: '<svg viewBox="0 0 24 24"><path d="M16.8 12.8c0-2.5 2-3.7 2.1-3.8a4.5 4.5 0 00-3.5-1.9c-1.5-.2-2.9.9-3.7.9-.8 0-2-.9-3.3-.8A4.9 4.9 0 004.2 10c-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.5 1.3-.1 1.8-.8 3.4-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5a11 11 0 001.4-2.9 4.4 4.4 0 01-3.2-4.5zM14.4 5.5A4.3 4.3 0 0015.5 2a4.5 4.5 0 00-3 1.7 4 4 0 00-1.1 3.4 3.7 3.7 0 003-1.6z" fill="currentColor" stroke="none"/></svg>',
  windows: '<svg viewBox="0 0 24 24"><path d="M3 5.5l7.5-1v7H3v-6zM12 4.3l9-1.3v8.5h-9V4.3zM3 13h7.5v7L3 19v-6zM12 13h9v8.5l-9-1.3V13z" fill="currentColor" stroke="none"/></svg>',
  linux: '<svg viewBox="0 0 24 24"><path d="M8 17c-2 1-3.2 2.4-3 4h14c.2-1.6-1-3-3-4M9 11c-1.5 1.2-2.5 3.4-2 5.5M15 11c1.5 1.2 2.5 3.4 2 5.5"/><path d="M8.5 9.5C8.5 5.5 9.7 2 12 2s3.5 3.5 3.5 7.5c0 3-1.3 6.5-3.5 6.5s-3.5-3.5-3.5-6.5z"/><circle cx="10.7" cy="7" r=".5" fill="currentColor"/><circle cx="13.3" cy="7" r=".5" fill="currentColor"/><path d="M10.5 9.5h3L12 11z"/></svg>',
  web: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z"/></svg>'
};

const ua = navigator.userAgent || '';
const platform = navigator.userAgentData?.platform || navigator.platform || '';
const touchMac = /Mac/i.test(platform) && navigator.maxTouchPoints > 1;
let detected = 'web';
if (/Android/i.test(ua)) detected = 'android';
else if (/iPhone|iPad|iPod/i.test(ua) || touchMac) detected = 'web';
else if (/Mac/i.test(platform)) detected = 'macos';
else if (/Win/i.test(platform)) detected = 'windows';
else if (/Linux|X11/i.test(platform)) detected = 'linux';

const recommendations = {
  android: { label: 'Android detected', title: 'GuideBand for Android', detail: 'The full phone assistant with Vexo bracelet support.', button: 'Download APK · 12.9 MB', href: release + 'GuideBand-Android.apk' },
  macos: { label: 'macOS detected', title: 'GuideBand for your Mac', detail: 'One universal build for Apple silicon and Intel Macs.', button: 'Download universal DMG', href: release + 'GuideBand-0.1.0-universal.dmg' },
  windows: { label: 'Windows detected', title: 'GuideBand for Windows', detail: 'The guided x64 installer for Windows 10 and later.', button: 'Download Windows installer', href: release + 'GuideBand.Setup.0.1.0.exe' },
  linux: { label: 'Linux detected', title: 'GuideBand for Linux', detail: 'DEB for Debian and Ubuntu. AppImage is available below.', button: 'Download DEB · x64', href: release + 'guideband_0.1.0_amd64.deb' },
  web: { label: /iPhone|iPad|iPod/i.test(ua) || touchMac ? 'iPhone or iPad detected' : 'Browser detected', title: 'Open GuideBand on the web', detail: 'No native build is needed. Add it to your home screen for quick access.', button: 'Open web app', href: 'app.html' }
};
const rec = recommendations[detected];
byId('detectedIcon').innerHTML = osIcons[detected];
byId('detectedLabel').textContent = rec.label;
byId('detectedTitle').textContent = rec.title;
byId('detectedDetail').textContent = rec.detail;
byId('detectedButton').textContent = rec.button;
byId('detectedButton').href = rec.href;
if (detected !== 'web') byId('detectedButton').setAttribute('download', '');
document.querySelector(`[data-platform="${detected}"]`)?.classList.add('is-detected');

document.querySelectorAll('.os-android').forEach(el => el.innerHTML = osIcons.android);
document.querySelectorAll('.os-apple').forEach(el => el.innerHTML = osIcons.macos);
document.querySelectorAll('.os-windows').forEach(el => el.innerHTML = osIcons.windows);
document.querySelectorAll('.os-linux').forEach(el => el.innerHTML = osIcons.linux);
document.querySelectorAll('.os-web').forEach(el => el.innerHTML = osIcons.web);
