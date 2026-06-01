const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Auth methods
  saveAuth: (token, user) => ipcRenderer.invoke('save-auth', token, user),
  getAuth: () => ipcRenderer.invoke('get-auth'),
  clearAuth: () => ipcRenderer.invoke('clear-auth'),
  
  // Tracker methods
  checkIn: () => ipcRenderer.invoke('check-in'),
  checkOut: () => ipcRenderer.invoke('check-out'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  
  // Events
  onScreenshotTaken: (callback) => {
    ipcRenderer.on('screenshot-taken', (event, filename) => callback(filename));
  },
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (event, status) => callback(status));
  },
  onNextScreenshot: (callback) => {
    ipcRenderer.on('next-screenshot', (event, minutes) => callback(minutes));
  },
  onSessionStarted: (callback) => {
    ipcRenderer.on('session-started', () => callback());
  },
  
  // Helper to expose ipcRenderer for overlay
  getIpcRenderer: () => ipcRenderer
});