const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const Store = require('electron-store');
const screenshotService = require('./screenshot-service');

// Initialize electron store for user credentials
const store = new Store({
  name: 'user-preferences',
  defaults: {
    savedPhone: '',
    savedName: ''
  }
});

let overlayWindow = null;
let checkInWindow = null;
let isMonitoring = false;
let currentPhone = null;
let currentName = null;
let currentSessionId = null;
let screenshotSequence = 0;
let heartbeatInterval = null;
let nextScreenshotTimeout = null;
let backendBaseUrl = 'http://127.0.0.1:3000'; // Make sure this matches your backend

// Random interval between MIN and MAX seconds (from env or defaults)
const MIN_INTERVAL_SECONDS = 60; // 1 minute
const MAX_INTERVAL_SECONDS = 300; // 30 minutes

// Disable default menu
Menu.setApplicationMenu(null);

// Helper function to make API calls with error handling
async function apiCall(endpoint, options = {}) {
  const url = `${backendBaseUrl}${endpoint}`;
  console.log(`🌐 API Call: ${options.method || 'GET'} ${url}`);
  
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    });
    
    // Check if response is JSON
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await response.text();
      console.error(`❌ Non-JSON response from ${endpoint}:`, text.substring(0, 200));
      throw new Error(`Server returned ${contentType || 'unknown content type'}. Expected JSON.`);
    }
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    
    return data;
  } catch (error) {
    console.error(`❌ API call failed (${endpoint}):`, error.message);
    throw error;
  }
}

// Create the main check-in window
function createCheckInWindow() {
  checkInWindow = new BrowserWindow({
    width: 520,
    height: 620,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    resizable: false,
    alwaysOnTop: true,
    frame: true,
    backgroundColor: '#0a0b0e',
    titleBarStyle: 'hiddenInset'
  });

  checkInWindow.loadFile(path.join(__dirname, 'index.html'));
  
  checkInWindow.on('closed', () => {
    checkInWindow = null;
  });
}

// Create the overlay window with draggable support
function createOverlayWindow() {
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
    resizable: false
  });

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
  overlayWindow.setSkipTaskbar(true);
  overlayWindow.setVisibleOnAllWorkspaces(true);
  
  // Make the window ignore mouse events on transparent areas
  overlayWindow.setIgnoreMouseEvents(false);
}

// Get new presigned URL for each screenshot
async function getNewPresignedUrl(sequence) {
  console.log(`🔗 Requesting new presigned URL for screenshot #${sequence}`);
  
  const data = await apiCall('/api/upload-request', {
    method: 'POST',
    body: JSON.stringify({
      phone: currentPhone,
      sessionId: currentSessionId,
      sequence: sequence,
      userName: currentName
    })
  });
  
  if (data.success) {
    console.log(`✅ Got presigned URL for screenshot #${sequence}`);
    return data.presignedUrl;
  } else {
    throw new Error(data.error || 'Failed to get presigned URL');
  }
}

// Upload screenshot to R2
async function uploadScreenshot(screenshotBuffer, sequence) {
  try {
    const presignedUrl = await getNewPresignedUrl(sequence);
    
    const response = await fetch(presignedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: screenshotBuffer
    });
    
    if (response.ok) {
      console.log(`✅ Screenshot #${sequence} uploaded successfully`);
      return true;
    } else {
      const errorText = await response.text();
      console.error(`❌ Upload failed for #${sequence}:`, response.status, errorText);
      return false;
    }
  } catch (error) {
    console.error(`❌ Upload error for #${sequence}:`, error);
    return false;
  }
}

// Send heartbeat to backend
async function sendHeartbeat() {
  if (!currentPhone || !currentSessionId) return;
  
  try {
    await apiCall('/api/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        phone: currentPhone,
        sessionId: currentSessionId
      })
    });
    console.log('💓 Heartbeat sent successfully');
  } catch (error) {
    console.error('⚠️ Heartbeat failed:', error);
  }
}

// Get random interval for next screenshot and update overlay
function getRandomScreenshotInterval() {
  const minMs = MIN_INTERVAL_SECONDS * 1000;
  const maxMs = MAX_INTERVAL_SECONDS * 1000;
  const randomMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  const randomMinutes = (randomMs / 60000).toFixed(1);
  
  // Send update to overlay
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('next-screenshot', randomMinutes);
  }
  
  console.log(`📸 Next screenshot in ${randomMinutes} minutes (${randomMs/1000} seconds)`);
  return randomMs;
}

// Take and upload screenshot
async function takeAndUploadScreenshot() {
  if (!isMonitoring) return;
  
  screenshotSequence++;
  console.log(`📸 Taking screenshot #${screenshotSequence}...`);
  
  const screenshot = await screenshotService.capture();
  
  if (screenshot) {
    const jpegBuffer = await screenshotService.convertToJPEG(screenshot, 75);
    const uploadSuccess = await uploadScreenshot(jpegBuffer, screenshotSequence);
    
    if (uploadSuccess && overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('screenshot-taken', `screenshot-${screenshotSequence}.jpg`);
    }
  }
  
  // Schedule next screenshot with random interval
  if (isMonitoring) {
    const nextInterval = getRandomScreenshotInterval();
    nextScreenshotTimeout = setTimeout(takeAndUploadScreenshot, nextInterval);
  }
}

// Start monitoring
async function startMonitoring() {
  if (isMonitoring) return;
  
  isMonitoring = true;
  screenshotSequence = 0;
  console.log('🟢 Monitoring started');
  console.log(`⏱️ Screenshot interval: ${MIN_INTERVAL_SECONDS}-${MAX_INTERVAL_SECONDS} seconds`);
  
  // Send initial next screenshot time to overlay
  const initialDelay = Math.floor(Math.random() * (90000 - 30000 + 1)) + 30000;
  const initialMinutes = (initialDelay / 60000).toFixed(1);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('next-screenshot', initialMinutes);
  }
  
  // Send heartbeat every 5 minutes
  heartbeatInterval = setInterval(() => {
    sendHeartbeat();
  }, 5 * 60 * 1000);
  
  // Start screenshot loop with random initial delay (between 30-90 seconds)
  console.log(`⏰ First screenshot in ${(initialDelay/1000).toFixed(0)} seconds`);
  
  setTimeout(() => {
    takeAndUploadScreenshot();
  }, initialDelay);
}

// Stop monitoring
function stopMonitoring() {
  isMonitoring = false;
  
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  
  if (nextScreenshotTimeout) {
    clearTimeout(nextScreenshotTimeout);
    nextScreenshotTimeout = null;
  }
  
  console.log('🔴 Monitoring stopped');
}

// IPC handlers
ipcMain.handle('save-credentials', async (event, phone, name) => {
  store.set('savedPhone', phone);
  store.set('savedName', name);
  return { success: true };
});

ipcMain.handle('get-credentials', async () => {
  return {
    phone: store.get('savedPhone', ''),
    name: store.get('savedName', '')
  };
});

ipcMain.handle('check-in', async (event, phone, name) => {
  console.log('📝 Check-in clicked for:', phone, name);
  
  currentPhone = phone;
  currentName = name;
  
  // Save credentials
  store.set('savedPhone', phone);
  store.set('savedName', name);
  
  try {
    // Call backend check-in
    const data = await apiCall('/api/check-in', {
      method: 'POST',
      body: JSON.stringify({ phone: currentPhone, name: currentName })
    });
    
    if (data.success) {
      currentSessionId = data.sessionId;
      
      // Hide check-in window
      if (checkInWindow && !checkInWindow.isDestroyed()) {
        checkInWindow.hide();
      }
      
      // Create and show overlay window
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.destroy();
      }
      
      createOverlayWindow();
      
      overlayWindow.once('ready-to-show', () => {
        overlayWindow.show();
      });
      
      // Start monitoring
      startMonitoring();
      
      return { success: true, sessionId: currentSessionId, todayHours: data.todayHours };
    } else {
      return { success: false, error: data.error };
    }
  } catch (error) {
    console.error('Check-in failed:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('check-out', async () => {
  console.log('📝 Check-out clicked');
  
  try {
    // Call backend check-out
    if (currentPhone) {
      await apiCall('/api/check-out', {
        method: 'POST',
        body: JSON.stringify({ phone: currentPhone })
      });
    }
  } catch (error) {
    console.error('Check-out API error:', error);
  }
  
  stopMonitoring();
  
  // Hide overlay and show check-in window
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
  }
  
  if (checkInWindow && !checkInWindow.isDestroyed()) {
    checkInWindow.show();
    checkInWindow.webContents.send('status-update', { status: 'checked-out' });
  }
  
  currentSessionId = null;
  screenshotSequence = 0;
  
  return { success: true };
});

ipcMain.handle('get-status', async () => {
  if (!currentPhone) {
    return { hasActiveSession: false };
  }
  
  try {
    const data = await apiCall(`/api/user/${currentPhone}/status`);
    return data;
  } catch (error) {
    console.error('Status fetch error:', error);
    return { hasActiveSession: false };
  }
});

// Handle overlay position persistence (optional)
ipcMain.handle('save-overlay-position', async (event, bounds) => {
  store.set('overlayPosition', bounds);
  return { success: true };
});

ipcMain.handle('get-overlay-position', async () => {
  return store.get('overlayPosition', { x: 20, y: 20 });
});

// App lifecycle
app.whenReady().then(() => {
  // Load saved credentials
  const savedPhone = store.get('savedPhone');
  const savedName = store.get('savedName');
  if (savedPhone) {
    currentPhone = savedPhone;
    currentName = savedName;
  }
  
  createCheckInWindow();
  createOverlayWindow();
  
  // Load saved overlay position if exists
  const savedPosition = store.get('overlayPosition');
  if (savedPosition && overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setPosition(savedPosition.x, savedPosition.y);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});