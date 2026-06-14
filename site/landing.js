// ============================================
// Cykel landing — tiny, no dependencies, no tracking.
// ============================================

// --- Mockup calendar (drawn here so the markup stays clean) ---
const cal = document.getElementById('mini-cal');
if (cal) {
  const flow = new Set([2, 3, 4, 5]);
  const fert = new Set([11, 12, 13]);
  const pred = new Set([17, 18, 19, 20]);
  const blanks = 3; // start offset
  const frag = document.createDocumentFragment();
  for (let i = 0; i < blanks; i++) frag.appendChild(document.createElement('span'));
  for (let d = 1; d <= 30; d++) {
    const c = document.createElement('span');
    c.textContent = d;
    if (flow.has(d)) c.className = 'flow';
    else if (pred.has(d)) c.className = 'pred';
    else if (fert.has(d)) c.className = 'fert';
    frag.appendChild(c);
  }
  cal.appendChild(frag);
}

// --- Scroll reveal (respects reduced motion) ---
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const reveals = document.querySelectorAll('.reveal');
if (reduce || !('IntersectionObserver' in window)) {
  reveals.forEach(el => el.classList.add('in'));
} else {
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  reveals.forEach(el => io.observe(el));
}

// --- Platform-aware install copy ---
const ua = navigator.userAgent || '';
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);

const step2Title = document.getElementById('step2-title');
const step2Desc = document.getElementById('step2-desc');
const howSub = document.getElementById('how-sub');
const ctaNote = document.getElementById('cta-note');

if (isIOS) {
  if (step2Title) step2Title.textContent = 'Tap Share → Add to Home Screen';
  if (step2Desc) step2Desc.textContent = 'In Safari, tap the share icon, then “Add to Home Screen.”';
  if (howSub) howSub.textContent = 'On iPhone, Cykel installs straight from Safari — no App Store, no Apple ID.';
  if (ctaNote) ctaNote.textContent = 'free · works offline · add from Safari';
} else if (isAndroid) {
  if (step2Title) step2Title.textContent = 'Tap “Install”';
  if (step2Desc) step2Desc.textContent = 'Your browser will offer to install Cykel — accept it. No Play Store needed.';
  if (howSub) howSub.textContent = 'On Android, Cykel installs in one tap — no Play Store, no Google account.';
  if (ctaNote) ctaNote.textContent = 'free · works offline · one-tap install';
} else {
  if (step2Title) step2Title.textContent = 'Install it (optional)';
  if (step2Desc) step2Desc.textContent = 'Use it right in your browser, or click the install icon in the address bar.';
  if (howSub) howSub.textContent = 'On your computer, use Cykel in any browser — or install it like a native app.';
}
