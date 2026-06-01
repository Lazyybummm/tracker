const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('api', {
  checkIn: (phone, name) => ipcRenderer.invoke('check-in', phone, name),
  checkOut: () => ipcRenderer.invoke('check-out'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  saveCredentials: (phone, name) => ipcRenderer.invoke('save-credentials', phone, name),
  getCredentials: () => ipcRenderer.invoke('get-credentials'),
  onScreenshotTaken: (callback) => {
    ipcRenderer.on('screenshot-taken', (event, filename) => callback(filename));
  },
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (event, status) => callback(status));
  },
  onNextScreenshot: (callback) => {
    ipcRenderer.on('next-screenshot', (event, minutes) => callback(minutes));
  }
});