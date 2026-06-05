const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Auth
  saveAuth:  (token, user) => ipcRenderer.invoke('save-auth', token, user),
  getAuth:   ()            => ipcRenderer.invoke('get-auth'),
  clearAuth: ()            => ipcRenderer.invoke('clear-auth'),

  // Session
  checkIn:   () => ipcRenderer.invoke('check-in'),
  checkOut:  () => ipcRenderer.invoke('check-out'),
  getStatus: () => ipcRenderer.invoke('get-status'),

  // Main → Renderer events
  // Each listener is registered once and returns a cleanup function
  onScreenshotTaken: (cb) => {
    const handler = (_, filename) => cb(filename);
    ipcRenderer.on('screenshot-taken', handler);
    return () => ipcRenderer.removeListener('screenshot-taken', handler);
  },
  onStatusUpdate: (cb) => {
    const handler = (_, status) => cb(status);
    ipcRenderer.on('status-update', handler);
    return () => ipcRenderer.removeListener('status-update', handler);
  },
  onNextScreenshot: (cb) => {
    const handler = (_, minutes) => cb(minutes);
    ipcRenderer.on('next-screenshot', handler);
    return () => ipcRenderer.removeListener('next-screenshot', handler);
  },
  onSessionStarted: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('session-started', handler);
    return () => ipcRenderer.removeListener('session-started', handler);
  }
});