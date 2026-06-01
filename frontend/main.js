const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const Store = require('electron-store');
const screenshotService = require('./screenshot-service');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });

// Initialize electron store for user credentials
const store = new Store({
  name: 'user-preferences',
  defaults: {
    savedToken: '',
    savedUser: null
  }
});

let overlayWindow = null;
let checkInWindow = null;
let isMonitoring = false;
let currentUser = null;
let currentSessionId = null;
let screenshotSequence = 0;
let heartbeatInterval = null;
let nextScreenshotTimeout = null;
let backendBaseUrl = process.env.BACKEND_URL || 'http://127.0.0.1:3000';
let authToken = null;

// Random interval between 1 and 5 minutes (60-300 seconds)
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 300;

// Disable default menu
Menu.setApplicationMenu(null);

// Helper function to make API calls with authentication
async function apiCall(endpoint, options = {}) {
  const url = `${backendBaseUrl}${endpoint}`;
  console.log(`🌐 API Call: ${options.method || 'GET'} ${url}`);
  
  try {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };
    
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    
    const response = await fetch(url, {
      ...options,
      headers
    });
    
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
    titleBarStyle: 'hiddenInset',
    show: false
  });

  checkInWindow.loadFile(path.join(__dirname, 'index.html'));
  
  checkInWindow.once('ready-to-show', () => {
    checkInWindow.show();
  });
  
  checkInWindow.on('closed', () => {
    checkInWindow = null;
  });
}

// Create the overlay window
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
    resizable: false
  });

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.setSkipTaskbar(true);
  overlayWindow.setVisibleOnAllWorkspaces(true);
  overlayWindow.setIgnoreMouseEvents(false);
  
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

// Get new presigned URL for each screenshot
async function getNewPresignedUrl(sequence) {
  console.log(`🔗 Requesting new presigned URL for screenshot #${sequence}`);
  
  const data = await apiCall('/api/upload-request', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: currentSessionId,
      sequence: sequence
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
  if (!currentUser || !currentSessionId || !isMonitoring) return;
  
  try {
    await apiCall('/api/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: currentSessionId
      })
    });
    console.log('💓 Heartbeat sent successfully');
  } catch (error) {
    console.error('⚠️ Heartbeat failed:', error);
  }
}

// Get random interval for next screenshot
function getRandomScreenshotInterval() {
  const minMs = MIN_INTERVAL_SECONDS * 1000;
  const maxMs = MAX_INTERVAL_SECONDS * 1000;
  const randomMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  const randomMinutes = (randomMs / 60000).toFixed(1);
  
  console.log(`📸 Next screenshot in ${randomMinutes} minutes (${randomMs/1000} seconds)`);
  
  // Send to overlay for display
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('next-screenshot', randomMinutes);
  }
  
  return randomMs;
}

// Take and upload screenshot
async function takeAndUploadScreenshot() {
  if (!isMonitoring) {
    console.log('⚠️ Not monitoring, skipping screenshot');
    return;
  }
  
  screenshotSequence++;
  console.log(`📸 Taking screenshot #${screenshotSequence}...`);
  
  try {
    const screenshotBuffer = await screenshotService.capture();
    
    if (screenshotBuffer) {
      const jpegBuffer = await screenshotService.convertToJPEG(screenshotBuffer, 75);
      const uploadSuccess = await uploadScreenshot(jpegBuffer, screenshotSequence);
      
      if (uploadSuccess && overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('screenshot-taken', `screenshot-${screenshotSequence}.jpg`);
      } else if (!uploadSuccess) {
        console.error(`❌ Failed to upload screenshot #${screenshotSequence}`);
      }
    } else {
      console.error('❌ Failed to capture screenshot');
    }
  } catch (error) {
    console.error('❌ Screenshot error:', error);
  }
  
  // Schedule next screenshot if still monitoring
  if (isMonitoring) {
    const nextInterval = getRandomScreenshotInterval();
    nextScreenshotTimeout = setTimeout(() => {
      takeAndUploadScreenshot();
    }, nextInterval);
  }
}

// Start monitoring
async function startMonitoring() {
  if (isMonitoring) {
    console.log('⚠️ Already monitoring');
    return true;
  }
  
  console.log('🔍 startMonitoring() called');
  console.log(`🔍 authToken exists: ${!!authToken}`);
  console.log(`🔍 currentSessionId: ${currentSessionId}`);
  
  if (!authToken) {
    console.error('❌ Cannot start monitoring: No auth token');
    return false;
  }
  
  if (!currentSessionId) {
    console.error('❌ Cannot start monitoring: No session ID');
    return false;
  }
  
  isMonitoring = true;
  screenshotSequence = 0;
  console.log('🟢 Monitoring started');
  console.log(`⏱️ Screenshot interval: ${MIN_INTERVAL_SECONDS}-${MAX_INTERVAL_SECONDS} seconds`);
  
  // Show overlay window
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    // Notify overlay that session started (timer reset)
    overlayWindow.webContents.send('session-started');
  } else {
    console.error('❌ Overlay window not available');
    createOverlayWindow();
    setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.show();
        overlayWindow.webContents.send('session-started');
      }
    }, 500);
  }
  
  // Send heartbeat every 5 minutes
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    sendHeartbeat();
  }, 5 * 60 * 1000);
  
  // Calculate initial delay (30-90 seconds)
  const initialDelay = Math.floor(Math.random() * (90000 - 30000 + 1)) + 30000;
  const initialMinutes = (initialDelay / 60000).toFixed(1);
  console.log(`⏰ First screenshot in ${(initialDelay/1000).toFixed(0)} seconds (${initialMinutes} minutes)`);
  
  // Schedule first screenshot
  if (nextScreenshotTimeout) clearTimeout(nextScreenshotTimeout);
  nextScreenshotTimeout = setTimeout(() => {
    console.log('🎯 First screenshot timeout triggered');
    takeAndUploadScreenshot();
  }, initialDelay);
  
  return true;
}

// Stop monitoring
function stopMonitoring() {
  if (!isMonitoring) {
    console.log('⚠️ Monitoring not active');
    return;
  }
  
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

// Reset session state
async function resetSessionState() {
  console.log('🔄 Resetting session state...');
  stopMonitoring();
  currentSessionId = null;
  screenshotSequence = 0;
  
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
  }
  
  if (checkInWindow && !checkInWindow.isDestroyed()) {
    checkInWindow.show();
    // Send status update to refresh the UI
    checkInWindow.webContents.send('status-update', { status: 'checked-out' });
  }
}

// ============= IPC HANDLERS =============

// Save auth token
ipcMain.handle('save-auth', async (event, token, user) => {
  console.log('🔐 SAVE-AUTH called');
  authToken = token;
  currentUser = user;
  store.set('savedToken', token);
  store.set('savedUser', user);
  console.log('🔐 Auth saved, ready for check-in');
  return { success: true };
});

// Get saved auth
ipcMain.handle('get-auth', async () => {
  return {
    token: store.get('savedToken', ''),
    user: store.get('savedUser', null)
  };
});

// Clear auth
ipcMain.handle('clear-auth', async () => {
  console.log('🔐 CLEAR-AUTH called');
  authToken = null;
  currentUser = null;
  await resetSessionState();
  store.set('savedToken', '');
  store.set('savedUser', null);
  return { success: true };
});

// Check-in - MAIN IPC HANDLER
ipcMain.handle('check-in', async () => {
  console.log('📝 Check-in IPC handler called');
  console.log(`🔑 Current user: ${currentUser?.name || currentUser?.email}`);
  console.log(`🔑 Auth token exists: ${!!authToken}`);
  
  if (!currentUser || !authToken) {
    console.error('❌ Check-in failed: Not authenticated');
    return { success: false, error: 'Not authenticated. Please login again.' };
  }
  
  // Check if already has active session
  try {
    const statusCheck = await apiCall('/api/user/status');
    if (statusCheck.hasActiveSession) {
      console.log('⚠️ User already has active session, reconnecting');
      currentSessionId = statusCheck.activeSession?.session_id;
      
      // Start monitoring with existing session
      const monitoringStarted = await startMonitoring();
      
      // Hide check-in window
      if (checkInWindow && !checkInWindow.isDestroyed()) {
        checkInWindow.hide();
      }
      
      return { 
        success: true, 
        sessionId: currentSessionId,
        alreadyActive: true,
        message: 'Reconnected to active session'
      };
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
      console.log('✅ Check-in successful, sessionId:', currentSessionId);
      
      // Ensure overlay window exists
      if (!overlayWindow || overlayWindow.isDestroyed()) {
        createOverlayWindow();
      }
      
      // Hide check-in window
      if (checkInWindow && !checkInWindow.isDestroyed()) {
        checkInWindow.hide();
      }
      
      // Start monitoring (this will show the overlay)
      const monitoringStarted = await startMonitoring();
      
      if (!monitoringStarted) {
        console.error('⚠️ Monitoring failed to start');
      }
      
      return { 
        success: true, 
        sessionId: currentSessionId, 
        todayHours: data.todayHours,
        user: data.user
      };
    } else {
      console.error('❌ Check-in failed:', data.error);
      return { success: false, error: data.error };
    }
  } catch (error) {
    console.error('❌ Check-in error:', error);
    return { success: false, error: error.message };
  }
});

// Check-out - MAIN IPC HANDLER
ipcMain.handle('check-out', async () => {
  console.log('📝 Check-out IPC handler called');
  console.log(`Current sessionId: ${currentSessionId}`);
  console.log(`Current user: ${currentUser?.name}`);
  
  if (!currentUser || !currentSessionId) {
    console.log('⚠️ No active session to check out');
    await resetSessionState();
    return { success: true, message: 'No active session' };
  }
  
  try {
    // Call the check-out API
    const result = await apiCall('/api/check-out', {
      method: 'POST',
      body: JSON.stringify({})
    });
    console.log('✅ Check-out API call successful:', result);
  } catch (error) {
    console.error('Check-out API error:', error);
    // Still reset state even if API fails
  }
  
  // Reset all session state
  await resetSessionState();
  
  return { success: true };
});

// Get user status
ipcMain.handle('get-status', async () => {
  console.log('📊 get-status called');
  console.log(`Has authToken: ${!!authToken}`);
  console.log(`Has currentSessionId: ${!!currentSessionId}`);
  
  if (!currentUser || !authToken) {
    return { hasActiveSession: false, isAuthenticated: false };
  }
  
  try {
    const data = await apiCall('/api/user/status');
    // Update currentSessionId if we have an active session from the server
    if (data.hasActiveSession && data.activeSession?.session_id) {
      currentSessionId = data.activeSession.session_id;
      console.log(`Updated currentSessionId from status: ${currentSessionId}`);
    } else if (!data.hasActiveSession) {
      // If server says no active session, clear our local state
      if (currentSessionId) {
        console.log('Server reports no active session, clearing local state');
        await resetSessionState();
      }
    }
    return { ...data, isAuthenticated: true };
  } catch (error) {
    console.error('Status fetch error:', error);
    return { hasActiveSession: false, isAuthenticated: true };
  }
});

// App lifecycle
app.whenReady().then(() => {
  console.log('🚀 App ready, loading saved credentials...');
  
  const savedToken = store.get('savedToken');
  const savedUser = store.get('savedUser');
  
  if (savedToken && savedUser) {
    authToken = savedToken;
    currentUser = savedUser;
    console.log('✅ Loaded saved auth token and user');
  } else {
    console.log('⚠️ No saved credentials found');
  }
  
  createCheckInWindow();
  createOverlayWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});