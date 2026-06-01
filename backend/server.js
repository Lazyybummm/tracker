const path = require('path');
const dotenv = require('dotenv');

// Load .env from parent directory (root of project)
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const AWS = require('aws-sdk');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection error:', err.stack);
  } else {
    console.log('✅ Connected to PostgreSQL database');
    release();
  }
});

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// Configure R2 (S3-compatible)
const s3 = new AWS.S3({
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  signatureVersion: 'v4',
  region: 'auto'
});

// Helper: Ensure user exists (create if new)
async function ensureUserExists(phone, name) {
  const result = await pool.query(
    'SELECT phone, name FROM users WHERE phone = $1',
    [phone]
  );
  
  if (result.rows.length === 0) {
    const userName = name || phone;
    await pool.query(
      'INSERT INTO users (phone, name) VALUES ($1, $2)',
      [phone, userName]
    );
    console.log(`📝 Created new user: ${phone} (${userName})`);
    return { created: true, phone, name: userName };
  }
  
  console.log(`👤 Existing user: ${phone} (${result.rows[0].name})`);
  return { created: false, phone, name: result.rows[0].name };
}

// Helper: Get today's working hours
async function getTodayHours(phone) {
  const result = await pool.query(
    `SELECT 
      COALESCE(SUM(duration_seconds), 0) as total_seconds,
      COUNT(*) as session_count,
      COALESCE(SUM(screenshot_count), 0) as total_screenshots
     FROM work_sessions
     WHERE phone = $1 
       AND DATE(check_in_time) = CURRENT_DATE
       AND status IN ('completed', 'auto_checked_out')`,
    [phone]
  );
  
  return {
    total_seconds: parseInt(result.rows[0].total_seconds),
    total_hours: (result.rows[0].total_seconds / 3600).toFixed(2),
    session_count: parseInt(result.rows[0].session_count),
    total_screenshots: parseInt(result.rows[0].total_screenshots)
  };
}

// Helper: Get total working hours for a user (all time)
async function getTotalWorkingHours(phone) {
  const result = await pool.query(
    `SELECT 
      COALESCE(SUM(duration_seconds), 0) as total_seconds,
      COUNT(*) as session_count,
      COALESCE(SUM(screenshot_count), 0) as total_screenshots
     FROM work_sessions
     WHERE phone = $1 
       AND status IN ('completed', 'auto_checked_out')`,
    [phone]
  );
  
  return {
    total_seconds: parseInt(result.rows[0].total_seconds),
    total_hours: (result.rows[0].total_seconds / 3600).toFixed(2),
    session_count: parseInt(result.rows[0].session_count),
    total_screenshots: parseInt(result.rows[0].total_screenshots)
  };
}

// ============= API ENDPOINTS =============

// Generate presigned URL for screenshot upload
app.post('/api/upload-request', async (req, res) => {
  try {
    const { phone, sessionId, sequence, userName } = req.body;
    
    if (!phone || !sessionId) {
      return res.status(400).json({ error: 'Phone and sessionId required' });
    }
    
    // Create filename matching your pattern: screenshots/phone/sessionId/timestamp_sequence.jpg
    const timestamp = Date.now();
    const key = `screenshots/${phone}/${sessionId}/${timestamp}_${sequence}.jpg`;
    
    const params = {
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Expires: 3600,
      ContentType: 'image/jpeg'
    };
    
    const presignedUrl = await s3.getSignedUrlPromise('putObject', params);
    
    // Update screenshot count in database
    await pool.query(
      `UPDATE work_sessions 
       SET screenshot_count = screenshot_count + 1 
       WHERE session_id = $1`,
      [sessionId]
    );
    
    console.log(`📸 Generated presigned URL for ${phone} - screenshot #${sequence}`);
    console.log(`   Key: ${key}`);
    
    res.json({
      success: true,
      presignedUrl: presignedUrl,
      key: key,
      expiresIn: 3600,
      expiresAt: Date.now() + (3600 * 1000)
    });
    
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    res.status(500).json({ error: 'Failed to generate upload URL: ' + error.message });
  }
});

// Get screenshots for a user (returns signed URLs for viewing)
app.get('/api/user/:phone/screenshots', async (req, res) => {
  try {
    const { phone } = req.params;
    
    // List files from R2 with the screenshots/phone/ prefix
    const params = {
      Bucket: process.env.R2_BUCKET_NAME,
      Prefix: `screenshots/${phone}/`,
    };
    
    const listedObjects = await s3.listObjectsV2(params).promise();
    
    const screenshots = [];
    
    if (listedObjects.Contents && listedObjects.Contents.length > 0) {
      for (const obj of listedObjects.Contents) {
        // Generate signed URL for each screenshot
        const signedUrlParams = {
          Bucket: process.env.R2_BUCKET_NAME,
          Key: obj.Key,
          Expires: 3600 // 1 hour
        };
        
        const signedUrl = await s3.getSignedUrlPromise('getObject', signedUrlParams);
        
        // Extract session ID and sequence from key
        // Key format: screenshots/phone/sessionId/timestamp_sequence.jpg
        const parts = obj.Key.split('/');
        const sessionId = parts[2];
        const filename = parts[3];
        
        // Extract sequence number from filename
        const sequenceMatch = filename ? filename.match(/(\d+)\.jpg$/) : null;
        const sequence = sequenceMatch ? parseInt(sequenceMatch[1]) : 0;
        
        screenshots.push({
          url: signedUrl,
          key: obj.Key,
          sessionId: sessionId,
          filename: filename,
          sequence: sequence,
          timestamp: obj.LastModified
        });
      }
    }
    
    // Sort by last modified (newest first)
    screenshots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    console.log(`📸 Found ${screenshots.length} screenshots for ${phone}`);
    
    res.json({
      success: true,
      phone: phone,
      screenshots: screenshots,
      count: screenshots.length
    });
    
  } catch (error) {
    console.error('Screenshots error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get a single screenshot by key (alternative endpoint)
app.get('/api/screenshot/:phone/:sessionId/:sequence', async (req, res) => {
  try {
    const { phone, sessionId, sequence } = req.params;
    
    const params = {
      Bucket: process.env.R2_BUCKET_NAME,
      Prefix: `screenshots/${phone}/${sessionId}/`,
    };
    
    const listedObjects = await s3.listObjectsV2(params).promise();
    
    if (listedObjects.Contents && listedObjects.Contents.length > 0) {
      for (const obj of listedObjects.Contents) {
        const filename = obj.Key.split('/').pop();
        if (filename && filename.includes(`_${sequence}.jpg`)) {
          const signedUrlParams = {
            Bucket: process.env.R2_BUCKET_NAME,
            Key: obj.Key,
            Expires: 3600
          };
          const signedUrl = await s3.getSignedUrlPromise('getObject', signedUrlParams);
          
          return res.json({
            success: true,
            url: signedUrl,
            key: obj.Key
          });
        }
      }
    }
    
    res.status(404).json({ error: 'Screenshot not found' });
    
  } catch (error) {
    console.error('Screenshot error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check-in
app.post('/api/check-in', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { phone, name } = req.body;
    
    if (!phone) {
      return res.status(400).json({ error: 'Phone number required' });
    }
    
    const user = await ensureUserExists(phone, name);
    
    const activeCheck = await client.query(
      `SELECT session_id FROM work_sessions 
       WHERE phone = $1 AND status = 'active'`,
      [phone]
    );
    
    if (activeCheck.rows.length > 0) {
      return res.status(400).json({ 
        error: 'Active session exists. Check out first.',
        activeSession: activeCheck.rows[0].session_id
      });
    }
    
    const now = new Date();
    const sessionId = `${phone}_${now.getTime()}`;
    
    await client.query(
      `INSERT INTO work_sessions (phone, user_name, session_id, check_in_time, status, last_heartbeat)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [phone, user.name, sessionId, now, 'active', now]
    );
    
    const todayHours = await getTodayHours(phone);
    
    console.log(`✅ ${phone} (${user.name}) checked in at ${now.toISOString()}`);
    
    res.json({
      success: true,
      sessionId: sessionId,
      checkInTime: now.toISOString(),
      todayHours: todayHours,
      user: {
        phone: phone,
        name: user.name
      },
      message: 'Checked in successfully'
    });
    
  } catch (error) {
    console.error('Check-in error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Check-out
app.post('/api/check-out', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { phone } = req.body;
    
    if (!phone) {
      return res.status(400).json({ error: 'Phone number required' });
    }
    
    const activeSession = await client.query(
      `SELECT session_id, check_in_time FROM work_sessions 
       WHERE phone = $1 AND status = 'active'`,
      [phone]
    );
    
    if (activeSession.rows.length === 0) {
      return res.status(400).json({ error: 'No active session found' });
    }
    
    const session = activeSession.rows[0];
    const now = new Date();
    const checkInTime = new Date(session.check_in_time);
    const durationSeconds = Math.floor((now - checkInTime) / 1000);
    
    await client.query(
      `UPDATE work_sessions 
       SET check_out_time = $1, duration_seconds = $2, status = 'completed'
       WHERE session_id = $3`,
      [now, durationSeconds, session.session_id]
    );
    
    const todayHours = await getTodayHours(phone);
    
    console.log(`✅ ${phone} checked out. Duration: ${(durationSeconds / 3600).toFixed(2)} hours`);
    
    res.json({
      success: true,
      sessionId: session.session_id,
      checkOutTime: now.toISOString(),
      durationSeconds: durationSeconds,
      durationHours: (durationSeconds / 3600).toFixed(2),
      todayHours: todayHours,
      message: 'Checked out successfully'
    });
    
  } catch (error) {
    console.error('Check-out error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Heartbeat endpoint
app.post('/api/heartbeat', async (req, res) => {
  try {
    const { phone, sessionId } = req.body;
    
    if (!phone || !sessionId) {
      return res.status(400).json({ error: 'Phone and sessionId required' });
    }
    
    await pool.query(
      `UPDATE work_sessions 
       SET last_heartbeat = CURRENT_TIMESTAMP
       WHERE phone = $1 AND session_id = $2 AND status = 'active'`,
      [phone, sessionId]
    );
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      message: 'Heartbeat received'
    });
    
  } catch (error) {
    console.error('Heartbeat error:', error);
    res.status(500).json({ error: 'Heartbeat failed' });
  }
});

// Get user status
app.get('/api/user/:phone/status', async (req, res) => {
  try {
    const { phone } = req.params;
    
    const activeSession = await pool.query(
      `SELECT session_id, check_in_time, screenshot_count, last_heartbeat
       FROM work_sessions
       WHERE phone = $1 AND status = 'active'`,
      [phone]
    );
    
    const todayHours = await getTodayHours(phone);
    
    res.json({
      success: true,
      hasActiveSession: activeSession.rows.length > 0,
      activeSession: activeSession.rows[0] || null,
      todayHours: todayHours
    });
    
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user work history
app.get('/api/user/:phone/history', async (req, res) => {
  try {
    const { phone } = req.params;
    const { days = 7 } = req.query;
    
    const sessions = await pool.query(
      `SELECT 
        session_id,
        check_in_time,
        check_out_time,
        duration_seconds,
        status,
        screenshot_count,
        DATE(check_in_time) as work_date
       FROM work_sessions
       WHERE phone = $1 
         AND status IN ('completed', 'auto_checked_out')
         AND check_in_time > NOW() - INTERVAL '${days} days'
       ORDER BY check_in_time DESC`,
      [phone]
    );
    
    const dailyAggregates = await pool.query(
      `SELECT 
        DATE(check_in_time) as work_date,
        SUM(duration_seconds) as total_seconds,
        COUNT(*) as session_count,
        SUM(screenshot_count) as total_screenshots
       FROM work_sessions
       WHERE phone = $1 
         AND status IN ('completed', 'auto_checked_out')
         AND check_in_time > NOW() - INTERVAL '${days} days'
       GROUP BY DATE(check_in_time)
       ORDER BY work_date DESC`,
      [phone]
    );
    
    res.json({
      success: true,
      phone: phone,
      sessions: sessions.rows,
      dailySummary: dailyAggregates.rows,
      totalHours: dailyAggregates.rows.reduce((sum, day) => sum + (day.total_seconds / 3600), 0).toFixed(2)
    });
    
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============= ADMIN ENDPOINTS =============

// Get all users (admin)
app.get('/api/admin/users', async (req, res) => {
  try {
    const usersResult = await pool.query(
      `SELECT phone, name, created_at 
       FROM users 
       ORDER BY created_at DESC`
    );
    
    const users = [];
    
    for (const user of usersResult.rows) {
      const activeSession = await pool.query(
        `SELECT session_id, check_in_time, screenshot_count 
         FROM work_sessions 
         WHERE phone = $1 AND status = 'active'`,
        [user.phone]
      );
      
      const totalHours = await getTotalWorkingHours(user.phone);
      const todayHours = await getTodayHours(user.phone);
      
      let activeScreenshotCount = 0;
      if (activeSession.rows.length > 0) {
        activeScreenshotCount = parseInt(activeSession.rows[0].screenshot_count) || 0;
      }
      
      const totalScreenshots = totalHours.total_screenshots + activeScreenshotCount;
      
      users.push({
        phone: user.phone,
        name: user.name || user.phone,
        hasActiveSession: activeSession.rows.length > 0,
        activeSession: activeSession.rows[0] || null,
        totalWorkingHours: parseFloat(totalHours.total_hours),
        todayHours: parseFloat(todayHours.total_hours),
        screenshotCount: totalScreenshots,
        sessionCount: totalHours.session_count + (activeSession.rows.length > 0 ? 1 : 0),
        joinedAt: user.created_at
      });
    }
    
    res.json({
      success: true,
      users: users,
      count: users.length,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Admin users error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single user details (admin)
app.get('/api/admin/user/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    
    const userResult = await pool.query(
      `SELECT phone, name, created_at FROM users WHERE phone = $1`,
      [phone]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userResult.rows[0];
    
    const sessionsResult = await pool.query(
      `SELECT 
        id, session_id, user_name, check_in_time, check_out_time, 
        duration_seconds, status, screenshot_count, created_at
       FROM work_sessions
       WHERE phone = $1
       ORDER BY check_in_time DESC`,
      [phone]
    );
    
    const totalHours = await getTotalWorkingHours(phone);
    const todayHours = await getTodayHours(phone);
    
    const activeSession = await pool.query(
      `SELECT session_id, check_in_time, screenshot_count, last_heartbeat
       FROM work_sessions
       WHERE phone = $1 AND status = 'active'`,
      [phone]
    );
    
    res.json({
      success: true,
      user: {
        phone: user.phone,
        name: user.name || user.phone,
        joinedAt: user.created_at
      },
      statistics: {
        totalWorkingHours: parseFloat(totalHours.total_hours),
        todayWorkingHours: parseFloat(todayHours.total_hours),
        totalSessions: totalHours.session_count,
        totalScreenshots: totalHours.total_screenshots,
        todaySessions: todayHours.session_count,
        todayScreenshots: todayHours.total_screenshots
      },
      activeSession: activeSession.rows[0] || null,
      sessions: sessionsResult.rows.map(s => ({
        sessionId: s.session_id,
        userName: s.user_name || user.name || user.phone,
        checkInTime: s.check_in_time,
        checkOutTime: s.check_out_time,
        durationSeconds: s.duration_seconds,
        durationHours: (s.duration_seconds / 3600).toFixed(2),
        status: s.status,
        screenshotCount: s.screenshot_count
      }))
    });
    
  } catch (error) {
    console.error('Admin user error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      database: 'connected'
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error.message
    });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`🗄️  R2 Bucket: ${process.env.R2_BUCKET_NAME}`);
  console.log(`💾 PostgreSQL: Connected`);
  console.log(`✅ Available endpoints:`);
  console.log(`   POST /api/check-in`);
  console.log(`   POST /api/check-out`);
  console.log(`   POST /api/upload-request`);
  console.log(`   POST /api/heartbeat`);
  console.log(`   GET  /api/user/:phone/status`);
  console.log(`   GET  /api/user/:phone/history`);
  console.log(`   GET  /api/user/:phone/screenshots`);
  console.log(`   GET  /api/admin/users`);
  console.log(`   GET  /api/admin/user/:phone`);
  console.log(`   GET  /api/health`);
});