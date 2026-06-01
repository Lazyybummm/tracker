/**
 * renderer.js — GridTrack
 */

console.log('GridTrack renderer loaded');

const isOverlay = window.location.pathname.includes('overlay.html');

/* ══════════════════════════════════════════════════
   OVERLAY WINDOW
══════════════════════════════════════════════════ */
if (isOverlay) {
  const checkoutBtn = document.getElementById('checkoutBtn');

  if (window.api?.onScreenshotTaken) {
    window.api.onScreenshotTaken((filename) => {
      const container = document.getElementById('notificationContainer');
      if (!container) return;
      const n = document.createElement('div');
      n.className = 'notification';
      n.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
          <rect x="1.5" y="3" width="11" height="8.5" rx="1.5" stroke="#C9922A" stroke-width="1.2"/>
          <circle cx="7" cy="7.2" r="2" stroke="#C9922A" stroke-width="1.2"/>
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
    if (window.api?.checkOut) await window.api.checkOut();
  });

/* ══════════════════════════════════════════════════
   CHECK-IN WINDOW
══════════════════════════════════════════════════ */
} else {
  const actionBtn         = document.getElementById('actionBtn');
  const btnLabel          = document.getElementById('btnLabel');
  const btnIcon           = document.getElementById('btnIcon');
  const statusCard        = document.getElementById('statusCard');
  const statusDot         = document.getElementById('statusDot');
  const statusText        = document.getElementById('statusText');
  const headerStatusDot   = document.getElementById('headerStatusDot');
  const headerStatusText  = document.getElementById('headerStatusText');
  const todayHoursElem    = document.getElementById('todayHours');
  const todaySessionsElem = document.getElementById('todaySessions');
  const todayScreenshotsElem = document.getElementById('todayScreenshots');

  let isCheckedIn = false;

  const ICON_PLAY = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><polygon points="5,3 13,8 5,13" fill="currentColor"/></svg>`;
  const ICON_STOP = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>`;
  const ICON_SPIN = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="animation:spin 0.8s linear infinite"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" stroke-dasharray="20 18"/></svg>`;

  function setBtn(state) {
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

  async function updateUIFromStatus() {
    try {
      const status = await window.api.getStatus();
      
      if (status.hasActiveSession) {
        isCheckedIn = true;
        setBtn('stop');
        statusCard.style.display = 'block';
        statusDot.className = 'status-dot active';
        statusText.textContent = 'Currently Working';
        if (headerStatusDot) headerStatusDot.className = 'live-dot online';
        if (headerStatusText) headerStatusText.textContent = 'ACTIVE';
        todayHoursElem.textContent = status.todayHours?.total_hours ?? '0.0';
        todaySessionsElem.textContent = status.todayHours?.session_count ?? '0';
        todayScreenshotsElem.textContent = status.todayHours?.total_screenshots ?? '0';
      } else {
        isCheckedIn = false;
        setBtn('start');
        statusCard.style.display = 'none';
        statusDot.className = 'status-dot';
        statusText.textContent = 'Not checked in';
        if (headerStatusDot) headerStatusDot.className = 'live-dot';
        if (headerStatusText) headerStatusText.textContent = 'READY';
      }
    } catch (err) {
      console.error('Status update error:', err);
      isCheckedIn = false;
      setBtn('start');
    }
  }

  async function checkIn() {
    setBtn('loading-in');
    try {
      const result = await window.api.checkIn();
      if (result.success) {
        await updateUIFromStatus();
      } else {
        console.error('Check-in failed:', result.error);
        setBtn('start');
      }
    } catch (err) {
      console.error('Check-in error:', err);
      setBtn('start');
    }
  }

  async function checkOut() {
    setBtn('loading-out');
    try {
      const result = await window.api.checkOut();
      if (result.success) {
        await updateUIFromStatus();
      } else {
        console.error('Check-out failed');
        setBtn('stop');
      }
    } catch (err) {
      console.error('Check-out error:', err);
      setBtn('stop');
    }
  }

  actionBtn.addEventListener('click', () => {
    if (isCheckedIn) checkOut();
    else checkIn();
  });

  window.api?.onStatusUpdate?.(() => updateUIFromStatus());
  
  // Initial load
  updateUIFromStatus();
}

const style = document.createElement('style');
style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
document.head.appendChild(style);