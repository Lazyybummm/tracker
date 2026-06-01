const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const AWS = require('aws-sdk');
const { Pool } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection error:', err.stack);
  } else {
    console.log('✅ Connected to database');
    release();
  }
});

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// Configure R2
const s3 = new AWS.S3({
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  signatureVersion: 'v4',
  region: 'auto'
});

// JWT
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key';
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000;

function generateSessionToken(user) {
  const payload = {
    user_id: user.id,
    email: user.email,
    role: user.role,
    tenant_id: user.tenant_id,
    dept_id: user.dept_id,
    exp: Date.now() + TOKEN_EXPIRY
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(encoded).digest('hex');
  return `${encoded}.${signature}`;
}

function verifySessionToken(token) {
  try {
    const [encoded, signature] = token.split('.');
    const expectedSignature = crypto.createHmac('sha256', JWT_SECRET).update(encoded).digest('hex');
    if (signature !== expectedSignature) return null;
    const payload = JSON.parse(Buffer.from(encoded, 'base64').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function getUserByIdentifier(identifier) {
  const result = await pool.query(
    `SELECT id, email, name, employee_code, password_hash, role, tenant_id, dept_id, is_active 
     FROM users WHERE email = $1 OR employee_code = $1`,
    [identifier]
  );
  return result.rows[0];
}

async function getUserById(userId) {
  const result = await pool.query(
    `SELECT id, email, name, employee_code, role, tenant_id, dept_id, is_active FROM users WHERE id = $1`,
    [userId]
  );
  return result.rows[0];
}

async function verifyPassword(plainPassword, hashedPassword) {
  if (!hashedPassword) return false;
  if (hashedPassword.startsWith('$2b$') || hashedPassword.startsWith('$2a$') || hashedPassword.startsWith('$2y$')) {
    try {
      return await bcrypt.compare(plainPassword, hashedPassword);
    } catch { return false; }
  } else {
    const hash = crypto.createHash('sha256').update(plainPassword).digest('hex');
    return hash === hashedPassword;
  }
}

// Role-based authentication middleware
async function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.substring(7);
  const payload = verifySessionToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
  
  const user = await getUserById(payload.user_id);
  if (!user || !user.is_active) return res.status(401).json({ error: 'User not found or inactive' });
  
  req.user = user;
  req.tenant_id = payload.tenant_id;
  req.dept_id = payload.dept_id;
  req.user_role = payload.role;
  next();
}

// Helper functions
async function getTodayHours(userId, tenantId) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(duration_seconds), 0) as total_seconds,
            COUNT(*) as session_count,
            COALESCE(SUM(screenshot_count), 0) as total_screenshots
     FROM work_sessions
     WHERE user_id = $1 AND tenant_id = $2
       AND DATE(check_in_time) = CURRENT_DATE
       AND status IN ('completed', 'auto_checked_out')`,
    [userId, tenantId]
  );
  return {
    total_seconds: parseInt(result.rows[0].total_seconds),
    total_hours: (result.rows[0].total_seconds / 3600).toFixed(2),
    session_count: parseInt(result.rows[0].session_count),
    total_screenshots: parseInt(result.rows[0].total_screenshots)
  };
}

async function getTotalWorkingHours(userId, tenantId) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(duration_seconds), 0) as total_seconds,
            COUNT(*) as session_count,
            COALESCE(SUM(screenshot_count), 0) as total_screenshots
     FROM work_sessions
     WHERE user_id = $1 AND tenant_id = $2
       AND status IN ('completed', 'auto_checked_out')`,
    [userId, tenantId]
  );
  return {
    total_seconds: parseInt(result.rows[0].total_seconds),
    total_hours: (result.rows[0].total_seconds / 3600).toFixed(2),
    session_count: parseInt(result.rows[0].session_count),
    total_screenshots: parseInt(result.rows[0].total_screenshots)
  };
}

// ============= PUBLIC ROUTES =============

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const user = await getUserByIdentifier(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (!user.is_active) return res.status(401).json({ error: 'Account deactivated' });
    const isValid = await verifyPassword(password, user.password_hash);
    if (!isValid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = generateSessionToken(user);
    res.json({
      success: true,
      token: token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        employee_code: user.employee_code,
        role: user.role,
        tenant_id: user.tenant_id,
        dept_id: user.dept_id
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/verify', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const payload = verifySessionToken(token);
    if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
    const user = await getUserById(payload.user_id);
    if (!user || !user.is_active) return res.status(401).json({ error: 'User not found or inactive' });
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString(), database: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'error', database: 'disconnected', error: error.message });
  }
});

// ============= TRACKER ROUTES (require auth) =============

async function authenticateTracker(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.substring(7);
  const payload = verifySessionToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
  const user = await getUserById(payload.user_id);
  if (!user || !user.is_active) return res.status(401).json({ error: 'User not found or inactive' });
  req.user = user;
  req.tenant_id = payload.tenant_id;
  next();
}

app.get('/api/user/status', authenticateTracker, async (req, res) => {
  try {
    const userId = req.user.id;
    const tenantId = req.tenant_id;
    
    const activeSession = await pool.query(
      `SELECT session_id, check_in_time, screenshot_count, last_heartbeat
       FROM work_sessions WHERE user_id = $1 AND tenant_id = $2 AND status = 'active'`,
      [userId, tenantId]
    );
    
    const todayHours = await getTodayHours(userId, tenantId);
    
    res.json({
      success: true,
      hasActiveSession: activeSession.rows.length > 0,
      activeSession: activeSession.rows[0] || null,
      todayHours: todayHours,
      user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role }
    });
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/check-in', authenticateTracker, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id;
    const userName = req.user.name;
    const userEmail = req.user.email;
    const userEmployeeCode = req.user.employee_code;
    const tenantId = req.tenant_id;
    
    const activeCheck = await client.query(
      `SELECT session_id FROM work_sessions WHERE user_id = $1 AND tenant_id = $2 AND status = 'active'`,
      [userId, tenantId]
    );
    
    if (activeCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Active session exists. Check out first.' });
    }
    
    const now = new Date();
    const sessionId = `${tenantId}_${userId}_${now.getTime()}`;
    
    await client.query(
      `INSERT INTO work_sessions (user_id, user_email, user_name, employee_code, session_id, tenant_id, check_in_time, status, last_heartbeat)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [userId, userEmail, userName, userEmployeeCode, sessionId, tenantId, now, 'active', now]
    );
    
    const todayHours = await getTodayHours(userId, tenantId);
    
    res.json({
      success: true,
      sessionId: sessionId,
      checkInTime: now.toISOString(),
      todayHours: todayHours,
      user: { id: userId, name: userName, email: userEmail }
    });
  } catch (error) {
    console.error('Check-in error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post('/api/check-out', authenticateTracker, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id;
    const tenantId = req.tenant_id;
    
    const activeSession = await client.query(
      `SELECT session_id, check_in_time FROM work_sessions WHERE user_id = $1 AND tenant_id = $2 AND status = 'active'`,
      [userId, tenantId]
    );
    
    if (activeSession.rows.length === 0) {
      return res.status(400).json({ error: 'No active session found' });
    }
    
    const session = activeSession.rows[0];
    const now = new Date();
    const checkInTime = new Date(session.check_in_time);
    const durationSeconds = Math.floor((now - checkInTime) / 1000);
    
    await client.query(
      `UPDATE work_sessions SET check_out_time = $1, duration_seconds = $2, status = 'completed'
       WHERE session_id = $3 AND user_id = $4 AND tenant_id = $5`,
      [now, durationSeconds, session.session_id, userId, tenantId]
    );
    
    const todayHours = await getTodayHours(userId, tenantId);
    
    res.json({
      success: true,
      sessionId: session.session_id,
      checkOutTime: now.toISOString(),
      durationSeconds: durationSeconds,
      durationHours: (durationSeconds / 3600).toFixed(2),
      todayHours: todayHours
    });
  } catch (error) {
    console.error('Check-out error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post('/api/heartbeat', authenticateTracker, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const userId = req.user.id;
    const tenantId = req.tenant_id;
    
    if (!sessionId) return res.status(400).json({ error: 'SessionId required' });
    
    await pool.query(
      `UPDATE work_sessions SET last_heartbeat = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND session_id = $2 AND tenant_id = $3 AND status = 'active'`,
      [userId, sessionId, tenantId]
    );
    
    res.json({ success: true, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Heartbeat error:', error);
    res.status(500).json({ error: 'Heartbeat failed' });
  }
});

app.post('/api/upload-request', authenticateTracker, async (req, res) => {
  try {
    const { sessionId, sequence } = req.body;
    const userId = req.user.id;
    const tenantId = req.tenant_id;
    
    if (!sessionId) return res.status(400).json({ error: 'SessionId required' });
    
    const timestamp = Date.now();
    const key = `screenshots/${tenantId}/${userId}/${sessionId}/${timestamp}_${sequence}.jpg`;
    
    const params = {
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Expires: 3600,
      ContentType: 'image/jpeg'
    };
    
    const presignedUrl = await s3.getSignedUrlPromise('putObject', params);
    
    await pool.query(
      `UPDATE work_sessions SET screenshot_count = screenshot_count + 1 
       WHERE session_id = $1 AND user_id = $2 AND tenant_id = $3`,
      [sessionId, userId, tenantId]
    );
    
    res.json({ success: true, presignedUrl: presignedUrl, key: key });
  } catch (error) {
    console.error('Upload request error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/user/screenshots', authenticateTracker, async (req, res) => {
  try {
    const userId = req.user.id;
    const tenantId = req.tenant_id;
    
    const params = {
      Bucket: process.env.R2_BUCKET_NAME,
      Prefix: `screenshots/${tenantId}/${userId}/`,
    };
    
    const listedObjects = await s3.listObjectsV2(params).promise();
    const screenshots = [];
    
    if (listedObjects.Contents) {
      for (const obj of listedObjects.Contents) {
        const signedUrl = await s3.getSignedUrlPromise('getObject', {
          Bucket: process.env.R2_BUCKET_NAME,
          Key: obj.Key,
          Expires: 3600
        });
        screenshots.push({ url: signedUrl, key: obj.Key, timestamp: obj.LastModified });
      }
    }
    
    screenshots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ success: true, screenshots: screenshots });
  } catch (error) {
    console.error('Screenshots error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/user/history', authenticateTracker, async (req, res) => {
  try {
    const userId = req.user.id;
    const tenantId = req.tenant_id;
    const { days = 30 } = req.query;
    
    const sessions = await pool.query(
      `SELECT session_id, check_in_time, check_out_time, duration_seconds, status, screenshot_count
       FROM work_sessions
       WHERE user_id = $1 AND tenant_id = $2 
         AND status IN ('completed', 'auto_checked_out')
         AND check_in_time > NOW() - INTERVAL '${days} days'
       ORDER BY check_in_time DESC`,
      [userId, tenantId]
    );
    
    res.json({ success: true, sessions: sessions.rows });
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============= ADMIN ROUTES (Role-based filtering) =============

app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
  try {
    const userRole = req.user_role;
    const tenantId = req.tenant_id;
    const deptId = req.dept_id;
    
    let query = `
      SELECT id, email, name, employee_code, role, tenant_id, dept_id, is_active, created_at 
      FROM users 
      WHERE is_active = true
    `;
    const params = [];
    let paramIndex = 1;
    
    // Role-based filtering
    if (userRole === 'super_admin') {
      // Super admin sees all users across all tenants
      query += ` ORDER BY created_at DESC`;
    } 
    else if (userRole === 'admin' || userRole === 'tenant_admin') {
      // Tenant admin sees all users in their tenant
      query += ` AND tenant_id = $${paramIndex++}`;
      params.push(tenantId);
      query += ` ORDER BY created_at DESC`;
    } 
    else if (userRole === 'org_admin') {
      // Org admin only sees users in their department
      query += ` AND tenant_id = $${paramIndex++} AND dept_id = $${paramIndex++}`;
      params.push(tenantId, deptId);
      query += ` ORDER BY created_at DESC`;
    }
    else {
      // Regular employees see only themselves
      query += ` AND id = $${paramIndex++}`;
      params.push(req.user.id);
    }
    
    const usersResult = await pool.query(query, params);
    
    const users = [];
    for (const user of usersResult.rows) {
      const activeSession = await pool.query(
        `SELECT session_id FROM work_sessions WHERE user_id = $1 AND tenant_id = $2 AND status = 'active'`,
        [user.id, user.tenant_id || tenantId]
      );
      const totalHours = await getTotalWorkingHours(user.id, user.tenant_id || tenantId);
      const todayHours = await getTodayHours(user.id, user.tenant_id || tenantId);
      
      users.push({
        id: user.id,
        name: user.name || user.email,
        email: user.email,
        employee_code: user.employee_code,
        role: user.role,
        tenant_id: user.tenant_id,
        dept_id: user.dept_id,
        hasActiveSession: activeSession.rows.length > 0,
        totalWorkingHours: parseFloat(totalHours.total_hours),
        todayHours: parseFloat(todayHours.total_hours),
        screenshotCount: totalHours.total_screenshots,
        sessionCount: totalHours.session_count,
        joinedAt: user.created_at
      });
    }
    
    res.json({ 
      success: true, 
      users: users, 
      count: users.length,
      user_role: userRole,
      tenant_id: tenantId,
      dept_id: deptId
    });
  } catch (error) {
    console.error('Admin users error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/user/:userId', authenticateAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const requestingUserRole = req.user_role;
    const requestingUserTenantId = req.tenant_id;
    const requestingUserDeptId = req.dept_id;
    
    // First get the target user
    const targetUserResult = await pool.query(
      `SELECT id, email, name, employee_code, role, tenant_id, dept_id, is_active, created_at 
       FROM users WHERE id = $1`,
      [userId]
    );
    
    if (targetUserResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const targetUser = targetUserResult.rows[0];
    
    // Check permissions based on role
    let hasAccess = false;
    
    if (requestingUserRole === 'super_admin') {
      hasAccess = true;
    } 
    else if (requestingUserRole === 'admin' || requestingUserRole === 'tenant_admin') {
      // Tenant admin can only access users in their tenant
      hasAccess = targetUser.tenant_id === requestingUserTenantId;
    } 
    else if (requestingUserRole === 'org_admin') {
      // Org admin can only access users in their department
      hasAccess = targetUser.tenant_id === requestingUserTenantId && targetUser.dept_id === requestingUserDeptId;
    }
    else {
      // Regular employees can only access themselves
      hasAccess = targetUser.id === req.user.id;
    }
    
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied: You do not have permission to view this user' });
    }
    
    const sessionsResult = await pool.query(
      `SELECT session_id, check_in_time, check_out_time, duration_seconds, status, screenshot_count
       FROM work_sessions WHERE user_id = $1 AND tenant_id = $2 ORDER BY check_in_time DESC`,
      [userId, targetUser.tenant_id]
    );
    
    const totalHours = await getTotalWorkingHours(userId, targetUser.tenant_id);
    const todayHours = await getTodayHours(userId, targetUser.tenant_id);
    
    const activeSession = await pool.query(
      `SELECT session_id, check_in_time, screenshot_count FROM work_sessions 
       WHERE user_id = $1 AND tenant_id = $2 AND status = 'active'`,
      [userId, targetUser.tenant_id]
    );
    
    res.json({
      success: true,
      user: {
        id: targetUser.id,
        name: targetUser.name || targetUser.email,
        email: targetUser.email,
        employee_code: targetUser.employee_code,
        role: targetUser.role,
        tenant_id: targetUser.tenant_id,
        dept_id: targetUser.dept_id,
        joinedAt: targetUser.created_at
      },
      statistics: {
        totalWorkingHours: parseFloat(totalHours.total_hours),
        todayWorkingHours: parseFloat(todayHours.total_hours),
        totalSessions: totalHours.session_count,
        totalScreenshots: totalHours.total_screenshots
      },
      activeSession: activeSession.rows[0] || null,
      sessions: sessionsResult.rows.map(s => ({
        sessionId: s.session_id,
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

app.get('/api/admin/screenshots/:userId', authenticateAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const requestingUserRole = req.user_role;
    const requestingUserTenantId = req.tenant_id;
    const requestingUserDeptId = req.dept_id;
    
    // Get target user info
    const targetUserResult = await pool.query(
      `SELECT tenant_id, dept_id FROM users WHERE id = $1`,
      [userId]
    );
    
    if (targetUserResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const targetTenantId = targetUserResult.rows[0].tenant_id;
    const targetDeptId = targetUserResult.rows[0].dept_id;
    
    // Check permissions
    let hasAccess = false;
    
    if (requestingUserRole === 'super_admin') {
      hasAccess = true;
    } 
    else if (requestingUserRole === 'admin' || requestingUserRole === 'tenant_admin') {
      hasAccess = targetTenantId === requestingUserTenantId;
    } 
    else if (requestingUserRole === 'org_admin') {
      hasAccess = targetTenantId === requestingUserTenantId && targetDeptId === requestingUserDeptId;
    }
    else {
      hasAccess = parseInt(userId) === req.user.id;
    }
    
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied: You do not have permission to view these screenshots' });
    }
    
    const params = { 
      Bucket: process.env.R2_BUCKET_NAME, 
      Prefix: `screenshots/${targetTenantId}/${userId}/` 
    };
    
    const listedObjects = await s3.listObjectsV2(params).promise();
    const screenshots = [];
    
    if (listedObjects.Contents) {
      for (const obj of listedObjects.Contents) {
        const signedUrl = await s3.getSignedUrlPromise('getObject', { 
          Bucket: process.env.R2_BUCKET_NAME, 
          Key: obj.Key, 
          Expires: 3600 
        });
        screenshots.push({ 
          url: signedUrl, 
          key: obj.Key, 
          timestamp: obj.LastModified 
        });
      }
    }
    
    screenshots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ success: true, screenshots: screenshots });
  } catch (error) {
    console.error('Admin screenshots error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`\n✅ PUBLIC ENDPOINTS:`);
  console.log(`   POST /api/auth/login`);
  console.log(`   POST /api/auth/verify`);
  console.log(`   GET  /api/health`);
  console.log(`\n🔒 AUTHENTICATED ADMIN ENDPOINTS (Role-based filtering):`);
  console.log(`   GET  /api/admin/users`);
  console.log(`   GET  /api/admin/user/:userId`);
  console.log(`   GET  /api/admin/screenshots/:userId`);
  console.log(`\n🔒 AUTHENTICATED TRACKER ENDPOINTS (Bearer Token Required):`);
  console.log(`   POST /api/check-in`);
  console.log(`   POST /api/check-out`);
  console.log(`   POST /api/upload-request`);
  console.log(`   POST /api/heartbeat`);
  console.log(`   GET  /api/user/status`);
  console.log(`   GET  /api/user/history`);
  console.log(`   GET  /api/user/screenshots`);
});