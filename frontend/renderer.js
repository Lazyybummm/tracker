/**
 * renderer.js — GridTrack
 *
 * FIX: actionBtn was left disabled after a failed check-in/out.
 *      Also: after checkout the full UI state is reset so a new
 *      session can always be started.
 */

console.log('GridTrack renderer loaded');

const isOverlay = window.location.pathname.includes('overlay.html');

/* ══════════════════════════════════════════════════
   OVERLAY WINDOW
══════════════════════════════════════════════════ */
if (isOverlay) {

  const checkoutBtn = document.getElementById('checkoutBtn');

  // Screenshot notification
  if (window.api?.onScreenshotTaken) {
    window.api.onScreenshotTaken((filename) => {
      const container = document.getElementById('notificationContainer');
      if (!container) return;
      const n = document.createElement('div');
      n.className = 'notification';
      n.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#C9922A" stroke-width="2">
          <rect x="2" y="4" width="20" height="16" rx="2"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
        <span>${filename}</span>`;
      container.appendChild(n);
      setTimeout(() => {
        n.style.opacity = '0';
        n.style.transform = 'translateX(12px)';
        setTimeout(() => n.remove(), 300);
      }, 3000);
    });
  }

  checkoutBtn?.addEventListener('click', async () => {
    if (window.api?.checkOut) {
      await window.api.checkOut();
    }
  });

/* ══════════════════════════════════════════════════
   CHECK-IN WINDOW
══════════════════════════════════════════════════ */
} else {

  const actionBtn         = document.getElementById('actionBtn');
  const btnLabel          = document.getElementById('btnLabel');
  const btnIcon           = document.getElementById('btnIcon');
  const nameInput         = document.getElementById('nameInput');
  const phoneInput        = document.getElementById('phoneInput');
  const statusCard        = document.getElementById('statusCard');
  const statusDot         = document.getElementById('statusDot');
  const statusText        = document.getElementById('statusText');
  const headerStatusDot   = document.getElementById('headerStatusDot');
  const headerStatusText  = document.getElementById('headerStatusText');
  const todayHoursElem    = document.getElementById('todayHours');
  const todaySessionsElem = document.getElementById('todaySessions');
  const todayScreenshotsElem = document.getElementById('todayScreenshots');

  let isCheckedIn = false;

  // ── Icon SVGs ─────────────────────────────────────
  const ICON_PLAY = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><polygon points="5,3 13,8 5,13" fill="currentColor"/></svg>`;
  const ICON_STOP = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>`;
  const ICON_SPIN = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="animation:spin 0.8s linear infinite"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" stroke-dasharray="20 18"/></svg>`;

  // ── Set button state ──────────────────────────────
  function setBtn(state) {
    // state: 'start' | 'stop' | 'loading-in' | 'loading-out'
    actionBtn.disabled = (state === 'loading-in' || state === 'loading-out');
    actionBtn.dataset.state = (state === 'stop') ? 'stop' : 'start';

    if (state === 'start') {
      btnIcon.innerHTML = ICON_PLAY;
      btnLabel.textContent = 'Start Session';
      actionBtn.dataset.state = 'start';
    } else if (state === 'stop') {
      btnIcon.innerHTML = ICON_STOP;
      btnLabel.textContent = 'End Session';
      actionBtn.dataset.state = 'stop';
    } else if (state === 'loading-in') {
      btnIcon.innerHTML = ICON_SPIN;
      btnLabel.textContent = 'Starting…';
    } else if (state === 'loading-out') {
      btnIcon.innerHTML = ICON_SPIN;
      btnLabel.textContent = 'Ending…';
    }
  }

  // ── Update UI from status ─────────────────────────
  async function updateStatus() {
    try {
      const status = await window.api.getStatus();

      if (status.hasActiveSession) {
        isCheckedIn = true;
        setBtn('stop');
        statusCard.style.display = 'block';
        statusDot.className = 'status-dot active';
        statusText.textContent = 'Currently Working';
        if (headerStatusDot) {
          headerStatusDot.className = 'live-dot online';
          if (headerStatusText) headerStatusText.textContent = 'ACTIVE';
        }
        todayHoursElem.textContent    = status.todayHours?.total_hours    ?? '0.0';
        todaySessionsElem.textContent = status.todayHours?.session_count  ?? '0';
        todayScreenshotsElem.textContent = status.todayHours?.total_screenshots ?? '0';
        nameInput.disabled  = true;
        phoneInput.disabled = true;
      } else {
        // ── KEY FIX: fully reset state so button is never stuck disabled ──
        isCheckedIn = false;
        setBtn('start');                      // always re-enables the button
        statusCard.style.display = 'none';
        statusDot.className = 'status-dot';
        statusText.textContent = 'Not checked in';
        if (headerStatusDot) {
          headerStatusDot.className = 'live-dot';
          if (headerStatusText) headerStatusText.textContent = 'READY';
        }
        nameInput.disabled  = false;
        phoneInput.disabled = false;
      }
    } catch (err) {
      // If status fetch fails, still unlock the button so user isn't stuck
      console.error('getStatus error:', err);
      isCheckedIn = false;
      setBtn('start');
      nameInput.disabled  = false;
      phoneInput.disabled = false;
    }
  }

  // ── Check in ─────────────────────────────────────
  async function checkIn() {
    const name  = nameInput.value.trim();
    const phone = phoneInput.value.trim();

    if (!name || !phone) {
      // Shake the empty fields instead of alert
      [name ? null : nameInput, phone ? null : phoneInput].forEach(el => {
        if (!el) return;
        el.style.borderColor = 'var(--red)';
        el.style.boxShadow   = '0 0 0 3px var(--red-dim)';
        setTimeout(() => { el.style.borderColor = ''; el.style.boxShadow = ''; }, 1800);
      });
      return;
    }

    setBtn('loading-in');

    try {
      const result = await window.api.checkIn(phone, name);
      if (result.success) {
        await updateStatus();
      } else {
        console.error('Check-in failed:', result.error);
        setBtn('start'); // ← re-enable on failure
      }
    } catch (err) {
      console.error('Check-in error:', err);
      setBtn('start'); // ← re-enable on error
    }
  }

  // ── Check out ────────────────────────────────────
  async function checkOut() {
    setBtn('loading-out');

    try {
      const result = await window.api.checkOut();
      if (result.success) {
        await updateStatus(); // this will call setBtn('start') and re-enable
      } else {
        console.error('Check-out failed');
        setBtn('stop'); // keep stop state but re-enable so user can retry
      }
    } catch (err) {
      console.error('Check-out error:', err);
      setBtn('stop'); // re-enable on error
    }
  }

  // ── Main action handler ───────────────────────────
  actionBtn.addEventListener('click', () => {
    if (isCheckedIn) checkOut();
    else checkIn();
  });

  // ── Init ─────────────────────────────────────────
  (async () => {
    try {
      const creds = await window.api.getCredentials();
      if (creds.phone) phoneInput.value = creds.phone;
      if (creds.name)  nameInput.value  = creds.name;
    } catch {}
    await updateStatus();
  })();

  // Listen for main-process status pushes
  window.api?.onStatusUpdate?.(() => updateStatus());
}

/* ── Spinner keyframe injected at runtime ──────────── */
const style = document.createElement('style');
style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
document.head.appendChild(style);