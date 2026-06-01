const screenshot = require('screenshot-desktop');
const sharp = require('sharp');

class ScreenshotService {
  async capture() {
    try {
      // Capture screenshot as buffer
      const imgBuffer = await screenshot();
      return imgBuffer;
    } catch (error) {
      console.error('Screenshot failed:', error);
      return null;
    }
  }
  
  async convertToJPEG(buffer, quality = 75) {
    try {
      const jpegBuffer = await sharp(buffer)
        .jpeg({ quality: quality, progressive: true })
        .toBuffer();
      return jpegBuffer;
    } catch (error) {
      console.error('JPEG conversion failed:', error);
      return buffer;
    }
  }
}

module.exports = new ScreenshotService();