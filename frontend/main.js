const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');
const screenshotService = require('./screenshot-service');
const dotenv = require('dotenv');

// ── dotenv: works both in dev and inside packaged asar ──────────────────────
// In production, .env is unpacked alongside the asar at resourcesPath
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', '.env')
  : path.join(__dirname, '.env');
dotenv.config({ path: envPath });

// ── Electron Store ──────────────────────────────────────────────────────────
const store = new Store({
  name: 'user-preferences',
  defaults: {
    savedToken: '',
    savedUser: null
  }
});

// ── State ───────────────────────────────────────────────────────────────────
let overlayWindow     = null;
let checkInWindow     = null;
let tray              = null;
let isMonitoring      = false;
let currentUser       = null;
let currentSessionId  = null;
let screenshotSequence = 0;
let heartbeatInterval  = null;
let nextScreenshotTimeout = null;
let authToken         = null;

const backendBaseUrl  = 'https://api.track.gridsphere.in';
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 300;
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

Menu.setApplicationMenu(null);

// ── API helper ───────────────────────────────────────────────────────────────
async function apiCall(endpoint, options = {}) {
  const url = `${backendBaseUrl}${endpoint}`;
  console.log(`🌐 API Call: ${options.method || 'GET'} ${url}`);

  try {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    const response = await fetch(url, { ...options, headers });

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await response.text();
      console.error(`❌ Non-JSON response from ${endpoint}:`, text.substring(0, 200));
      throw new Error(`Server returned ${contentType || 'unknown content type'}. Expected JSON.`);
    }

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  } catch (error) {
    console.error(`❌ API call failed (${endpoint}):`, error.message);
    throw error;
  }
}

// ── Check-in window ──────────────────────────────────────────────────────────
function createCheckInWindow() {
  if (checkInWindow && !checkInWindow.isDestroyed()) {
    checkInWindow.destroy();
  }

  checkInWindow = new BrowserWindow({
    width: 520,
    height: 620,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    resizable: false,
    frame: true,
    backgroundColor: '#0a0b0e',
    // titleBarStyle hiddenInset is Mac-only — crashes or looks broken on Windows
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    show: false
  });

  checkInWindow.loadFile(path.join(__dirname, 'index.html'));

  checkInWindow.once('ready-to-show', () => {
    checkInWindow.show();
    checkInWindow.focus();
  });

  // On Windows, closing the last visible window should NOT quit if monitoring
  // We intercept close and hide instead when a session is active
  checkInWindow.on('close', (e) => {
    if (isMonitoring) {
      e.preventDefault();
      checkInWindow.hide();
    }
  });

  checkInWindow.on('closed', () => {
    checkInWindow = null;
  });
}

// ── Overlay window ───────────────────────────────────────────────────────────
function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
  }

  overlayWindow = new BrowserWindow({
    width: 300,
    height: 90,
    x: 20,
    y: 20,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    backgroundColor: '#00000000',
    hasShadow: false,
    movable: true,
    resizable: false,
    // Required on Windows for proper transparent frameless window
    ...(IS_WIN && { type: 'toolbar' })
  });

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.setSkipTaskbar(true);
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(false);

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

// ── System tray ──────────────────────────────────────────────────────────────
// Critical on Windows: without a tray, users have no way to quit the app
// when all windows are hidden during an active session
function createTray() {
  if (tray) return;

  // Use a small PNG as tray icon — create a 16x16 or 32x32 icon
  // Falls back to a blank image if icon file not found
  let iconPath = path.join(__dirname, 'assets', IS_WIN ? 'tray-icon.ico' : 'tray-icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    // If icon is empty (file not found), create a simple fallback
    if (icon.isEmpty()) {
      icon = nativeImage.createEmpty();
    }
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('GridTrack Monitor');
  updateTrayMenu();

  // Double-click tray icon shows the window
  tray.on('double-click', () => {
    if (checkInWindow && !checkInWindow.isDestroyed()) {
      checkInWindow.show();
      checkInWindow.focus();
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: isMonitoring ? '🟢 Session Active' : '⚪ Not Monitoring',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Show Window',
      click: () => {
        if (checkInWindow && !checkInWindow.isDestroyed()) {
          checkInWindow.show();
          checkInWindow.focus();
        } else {
          createCheckInWindow();
        }
      }
    },
    {
      label: 'End Session & Quit',
      click: async () => {
        if (isMonitoring) {
          // Try to check out gracefully before quitting
          try {
            await apiCall('/api/check-out', { method: 'POST', body: JSON.stringify({}) });
          } catch (e) {
            console.error('Checkout on quit failed:', e);
          }
        }
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

// ── Screenshot helpers ───────────────────────────────────────────────────────
async function getNewPresignedUrl(sequence) {
  console.log(`🔗 Requesting presigned URL for screenshot #${sequence}`);
  const data = await apiCall('/api/upload-request', {
    method: 'POST',
    body: JSON.stringify({ sessionId: currentSessionId, sequence })
  });
  if (data.success) return data.presignedUrl;
  throw new Error(data.error || 'Failed to get presigned URL');
}

async function uploadScreenshot(screenshotBuffer, sequence) {
  try {
    const presignedUrl = await getNewPresignedUrl(sequence);
    const response = await fetch(presignedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: screenshotBuffer
    });
    if (response.ok) {
      console.log(`✅ Screenshot #${sequence} uploaded`);
      return true;
    }
    const errorText = await response.text();
    console.error(`❌ Upload failed #${sequence}:`, response.status, errorText);
    return false;
  } catch (error) {
    console.error(`❌ Upload error #${sequence}:`, error);
    return false;
  }
}

async function sendHeartbeat() {
  if (!currentUser || !currentSessionId || !isMonitoring) return;
  try {
    await apiCall('/api/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ sessionId: currentSessionId })
    });
    console.log('💓 Heartbeat sent');
  } catch (error) {
    console.error('⚠️ Heartbeat failed:', error.message);
  }
}

function getRandomScreenshotInterval() {
  const minMs = MIN_INTERVAL_SECONDS * 1000;
  const maxMs = MAX_INTERVAL_SECONDS * 1000;
  const randomMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  const randomMinutes = (randomMs / 60000).toFixed(1);
  console.log(`📸 Next screenshot in ${randomMinutes} min`);

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('next-screenshot', randomMinutes);
  }
  return randomMs;
}

async function takeAndUploadScreenshot() {
  if (!isMonitoring) return;

  screenshotSequence++;
  console.log(`📸 Taking screenshot #${screenshotSequence}...`);

  try {
    const screenshotBuffer = await screenshotService.capture();
    if (screenshotBuffer) {
      const jpegBuffer = await screenshotService.convertToJPEG(screenshotBuffer, 75);
      const uploadSuccess = await uploadScreenshot(jpegBuffer, screenshotSequence);
      if (uploadSuccess && overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('screenshot-taken', `screenshot-${screenshotSequence}.jpg`);
      }
    } else {
      console.error('❌ Failed to capture screenshot');
    }
  } catch (error) {
    console.error('❌ Screenshot error:', error);
  }

  if (isMonitoring) {
    const nextInterval = getRandomScreenshotInterval();
    nextScreenshotTimeout = setTimeout(takeAndUploadScreenshot, nextInterval);
  }
}

// ── Monitoring control ───────────────────────────────────────────────────────
async function startMonitoring() {
  if (isMonitoring) return true;

  if (!authToken || !currentSessionId) {
    console.error('❌ Cannot start monitoring: missing token or sessionId');
    return false;
  }

  isMonitoring = true;
  screenshotSequence = 0;
  console.log('🟢 Monitoring started');
  updateTrayMenu();

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    overlayWindow.webContents.send('session-started');
  } else {
    createOverlayWindow();
    // Small delay to let window fully load before sending IPC
    setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.show();
        overlayWindow.webContents.send('session-started');
      }
    }, 600);
  }

  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(sendHeartbeat, 5 * 60 * 1000);

  const initialDelay = Math.floor(Math.random() * (90000 - 30000 + 1)) + 30000;
  console.log(`⏰ First screenshot in ${(initialDelay / 1000).toFixed(0)}s`);

  if (nextScreenshotTimeout) clearTimeout(nextScreenshotTimeout);
  nextScreenshotTimeout = setTimeout(takeAndUploadScreenshot, initialDelay);

  return true;
}

function stopMonitoring() {
  if (!isMonitoring) return;
  isMonitoring = false;

  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (nextScreenshotTimeout) { clearTimeout(nextScreenshotTimeout); nextScreenshotTimeout = null; }

  console.log('🔴 Monitoring stopped');
  updateTrayMenu();
}

async function resetSessionState() {
  console.log('🔄 Resetting session state...');
  stopMonitoring();
  currentSessionId = null;
  screenshotSequence = 0;

  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();

  if (checkInWindow && !checkInWindow.isDestroyed()) {
    checkInWindow.show();
    checkInWindow.focus();
    checkInWindow.webContents.send('status-update', { status: 'checked-out' });
  }
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('save-auth', async (event, token, user) => {
  authToken = token;
  currentUser = user;
  store.set('savedToken', token);
  store.set('savedUser', user);
  console.log('🔐 Auth saved');
  return { success: true };
});

ipcMain.handle('get-auth', async () => ({
  token: store.get('savedToken', ''),
  user: store.get('savedUser', null)
}));

ipcMain.handle('clear-auth', async () => {
  authToken = null;
  currentUser = null;
  await resetSessionState();
  store.set('savedToken', '');
  store.set('savedUser', null);
  return { success: true };
});

ipcMain.handle('check-in', async () => {
  console.log('📝 Check-in called');
  if (!currentUser || !authToken) {
    return { success: false, error: 'Not authenticated. Please login again.' };
  }

  // Reconnect to existing session if one is active
  try {
    const statusCheck = await apiCall('/api/user/status');
    if (statusCheck.hasActiveSession) {
      currentSessionId = statusCheck.activeSession?.session_id;
      await startMonitoring();
      if (checkInWindow && !checkInWindow.isDestroyed()) checkInWindow.hide();
      return { success: true, sessionId: currentSessionId, alreadyActive: true };
    }
  } catch (err) {
    console.log('Status check failed, proceeding with fresh check-in');
  }

  try {
    const data = await apiCall('/api/check-in', {
      method: 'POST',
      body: JSON.stringify({})
    });

    if (data.success) {
      currentSessionId = data.sessionId;
      if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
      if (checkInWindow && !checkInWindow.isDestroyed()) checkInWindow.hide();
      await startMonitoring();
      return { success: true, sessionId: currentSessionId, todayHours: data.todayHours, user: data.user };
    }
    return { success: false, error: data.error };
  } catch (error) {
    console.error('❌ Check-in error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('check-out', async () => {
  console.log('📝 Check-out called');
  if (!currentUser || !currentSessionId) {
    await resetSessionState();
    return { success: true, message: 'No active session' };
  }

  try {
    await apiCall('/api/check-out', { method: 'POST', body: JSON.stringify({}) });
    console.log('✅ Check-out API successful');
  } catch (error) {
    console.error('Check-out API error (resetting anyway):', error.message);
  }

  await resetSessionState();
  return { success: true };
});

ipcMain.handle('get-status', async () => {
  if (!currentUser || !authToken) {
    return { hasActiveSession: false, isAuthenticated: false };
  }

  try {
    const data = await apiCall('/api/user/status');
    if (data.hasActiveSession && data.activeSession?.session_id) {
      currentSessionId = data.activeSession.session_id;
    } else if (!data.hasActiveSession && currentSessionId) {
      await resetSessionState();
    }
    return { ...data, isAuthenticated: true };
  } catch (error) {
    console.error('Status fetch error:', error.message);
    return { hasActiveSession: false, isAuthenticated: true };
  }
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  console.log('🚀 App ready');
  console.log(`Platform: ${process.platform}, packaged: ${app.isPackaged}`);

  const savedToken = store.get('savedToken');
  const savedUser = store.get('savedUser');
  if (savedToken && savedUser) {
    authToken = savedToken;
    currentUser = savedUser;
    console.log('✅ Restored saved credentials');
  }

  createCheckInWindow();
  createOverlayWindow();
  createTray();
});

// Stop timers before quit so the process doesn't hang
app.on('before-quit', () => {
  console.log('👋 App quitting, stopping monitoring...');
  stopMonitoring();
  if (tray) { tray.destroy(); tray = null; }
});

app.on('window-all-closed', () => {
  // On Mac: stay alive when all windows are closed (standard Mac behaviour)
  // On Windows/Linux: only quit if NOT monitoring — if monitoring, tray keeps app alive
  if (IS_MAC) return;
  if (!isMonitoring) app.quit();
});

app.on('activate', () => {
  // Mac: re-open window when dock icon is clicked
  if (checkInWindow && !checkInWindow.isDestroyed()) {
    checkInWindow.show();
  } else {
    createCheckInWindow();
  }
});