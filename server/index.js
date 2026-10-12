require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const seedData = require('./data/seedData');
const { initDatabase, dbService, checkConnection, isDbConnected } = require('./db');
const { isSmtpConfigured, sendPasswordResetOtpEmail } = require('./utils/emailService');
const healthcareDataProvider = require('./integrations/healthcare/healthcareDataProvider');
const resourceMapper = require('./integrations/healthcare/resourceMapper');

const app = express();
const PORT = process.env.PORT || 5000;
const AUTH_SECRET = process.env.AUTH_SECRET || 'mediflow_jwt_secure_key_2026_change_in_production';

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// HTTP Defense-in-Depth Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' http://localhost:5000 http://localhost:5173 ws://localhost:5173 https://mediflow-web-3q7j.onrender.com;");
  next();
});

// Real-time SSE Clients
let sseClients = [];

function broadcastEvent(type, data) {
  const payload = `data: ${JSON.stringify({ type, data, timestamp: new Date().toISOString() })}\n\n`;
  sseClients.forEach(client => {
    try {
      client.res.write(payload);
    } catch (err) {
      console.error('Error writing to SSE client:', err);
    }
  });
}

// SSE Subscription Endpoint
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });

  const clientId = Date.now() + Math.random().toString(36).substr(2, 9);
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  // Send initial handshake
  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// ==========================================
// AUTHENTICATION HELPERS & MIDDLEWARE
// ==========================================

function generateToken(payload) {
  return jwt.sign({
    ...payload,
    tokenVersion: payload.tokenVersion || 1
  }, AUTH_SECRET, { expiresIn: '7d' });
}

function setAuthCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });
}

function clearAuthCookie(res) {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  });
}

// Authentication Middleware with Session Invalidation Check
function authenticateToken(req, res, next) {
  let token = req.cookies ? req.cookies.token : null;

  if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    req.user = null;
    return next();
  }

  jwt.verify(token, AUTH_SECRET, async (err, decoded) => {
    if (err) {
      req.user = null;
      return next();
    }

    if (decoded && decoded.id && decoded.tokenVersion) {
      try {
        const u = await dbService.findUserById(decoded.id);
        if (u && (u.tokenVersion || 1) !== decoded.tokenVersion) {
          req.user = null;
          return next();
        }
      } catch (e) {
        // Fall back gracefully
      }
    }

    req.user = decoded;
    next();
  });
}


app.use(authenticateToken);

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required. Please sign in.' });
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    if (req.user.role !== role) {
      return res.status(403).json({ success: false, message: `Access denied. ${role.toUpperCase()} role required.` });
    }
    next();
  };
}

// Queue Calculation Helper
async function getDoctorQueueStats(doctorId) {
  const doctor = await dbService.getDoctorById(doctorId);
  const avgDuration = doctor ? doctor.averageDurationMinutes : 15;
  const docApts = await dbService.getAppointments({ doctorId, date: "2026-10-05" });

  const nowConsulting = docApts.find(a => a.status === 'now_consulting' || a.queueState === 'IN_CONSULTATION') || null;
  const calledPatient = docApts.find(a => a.queueState === 'CALLED') || null;
  const waitingList = docApts
    .filter(a => a.status === 'waiting' && a.queueState !== 'IN_CONSULTATION' && a.queueState !== 'COMPLETED')
    .sort((a, b) => a.queuePosition - b.queuePosition);

  // Update dynamic queueState for waiting patients
  waitingList.forEach((apt, idx) => {
    if (apt.queueState !== 'CALLED') {
      apt.queueState = (idx === 0) ? 'NEAR_TURN' : 'WAITING';
    }
  });

  const completedToday = docApts.filter(a => a.status === 'completed' || a.queueState === 'COMPLETED').length;
  const totalToday = docApts.length;

  let doctorStatus = '🟢 Doctor is available';
  if (nowConsulting) {
    doctorStatus = '🟢 Currently consulting';
  } else if (calledPatient) {
    doctorStatus = '🟡 Patient called into chamber';
  }

  return {
    doctorId,
    doctorName: doctor ? doctor.name : '',
    specialty: doctor ? doctor.specialty : '',
    hospital: doctor ? doctor.hospital : '',
    location: doctor ? doctor.location : '',
    avgDuration,
    doctorStatus,
    nowConsulting,
    calledPatient,
    waitingList,
    waitingCount: waitingList.length,
    completedToday,
    totalToday,
    totalEstimatedWaitMinutes: (waitingList.length + (nowConsulting ? 1 : 0)) * avgDuration
  };
}

// Trigger Notifications
async function createNotification({ userId, patientId, title, message, type = 'System', relatedId = null }) {
  const notif = {
    id: `notif-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    userId: userId || 'usr-patient-1',
    patientId: patientId || 'pat-1',
    title,
    message,
    time: 'Just now',
    read: false,
    type,
    relatedId
  };
  await dbService.createNotification(notif);
  broadcastEvent('notification_received', { notification: notif });
  return notif;
}

// ==========================================
// DATABASE & SYSTEM HEALTHCHECK API
// ==========================================

app.get('/api/health', async (req, res) => {
  const dbStatus = await checkConnection();
  res.json({
    status: 'healthy',
    service: 'MediFlow Web API',
    timestamp: new Date().toISOString(),
    database: {
      connected: dbStatus.connected,
      configured: dbStatus.configured,
      driver: 'PostgreSQL (pg)',
      serverTime: dbStatus.serverTime || null,
      name: dbStatus.database || null
    },
    fhir: healthcareDataProvider.getStatus()
  });
});

app.get('/api/health/database', async (req, res) => {
  const dbStatus = await checkConnection();
  res.json({
    success: dbStatus.connected,
    configured: dbStatus.configured,
    connected: dbStatus.connected,
    mode: dbStatus.connected ? 'postgresql' : (dbStatus.configured ? 'error' : 'in-memory-fallback'),
    database: dbStatus.database || null,
    serverTime: dbStatus.serverTime || null,
    stage: dbStatus.stage || (dbStatus.connected ? 'connected' : 'unknown'),
    code: dbStatus.code || null,
    error: dbStatus.connected ? null : (dbStatus.error || dbStatus.reason || 'Database unavailable')
  });
});

// ==========================================
// 1. AUTHENTICATION API
// ==========================================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, phone, password, name, role = 'patient', age, gender, bloodGroup } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ success: false, message: 'Name, email, and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    const existingUser = await dbService.findUserByEmailOrPhone(cleanEmail);
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'An account with this email already exists.' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const patientId = `pat-${Date.now()}`;
    const userId = `usr-${Date.now()}`;

    const newUser = await dbService.createUser({
      id: userId,
      email: cleanEmail,
      phone: phone ? phone.trim() : "+91 98765 00000",
      passwordHash,
      role: role === 'doctor' ? 'doctor' : 'patient',
      name: name.trim(),
      patientId: role === 'patient' ? patientId : null,
      doctorId: role === 'doctor' ? 'doc-1' : null
    });

    let createdPatient = null;
    if (newUser.role === 'patient') {
      createdPatient = await dbService.updatePatientProfile({
        id: patientId,
        userId: newUser.id,
        name: newUser.name,
        age: parseInt(age) || 28,
        gender: gender || "Female",
        phone: newUser.phone,
        email: newUser.email,
        bloodGroup: bloodGroup || "O+",
        address: "Bangalore, India",
        emergencyContact: "Family Contact - +91 98123 45678",
        medicalAlerts: ["None reported"]
      });
    }

    const token = generateToken({
      id: newUser.id,
      email: newUser.email,
      role: newUser.role,
      name: newUser.name,
      patientId: newUser.patientId,
      doctorId: newUser.doctorId,
      tokenVersion: newUser.tokenVersion || 1
    });

    setAuthCookie(res, token);

    res.status(201).json({
      success: true,
      message: 'Account created successfully!',
      token,
      user: {
        id: newUser.id,
        email: newUser.email,
        role: newUser.role,
        name: newUser.name,
        patientId: newUser.patientId,
        doctorId: newUser.doctorId
      },
      patient: createdPatient
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ success: false, message: 'Registration failed. Please try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, requestedRole } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const user = await dbService.findUserByEmailOrPhone(email);

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const isPasswordValid = bcrypt.compareSync(password, user.passwordHash);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // Check role compatibility if specified
    if (requestedRole && user.role !== requestedRole) {
      return res.status(403).json({ 
        success: false, 
        message: `Account is registered as ${user.role.toUpperCase()}. Please use the ${user.role} sign-in tab.` 
      });
    }

    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      patientId: user.patientId,
      doctorId: user.doctorId,
      tokenVersion: user.tokenVersion || 1
    });

    setAuthCookie(res, token);


    const [patientData, doctorData] = await Promise.all([
      user.role === 'patient' ? dbService.getPatientProfile(user.patientId || user.id) : null,
      user.role === 'doctor' ? dbService.getDoctorById(user.doctorId || 'doc-1') : null
    ]);

    res.status(200).json({
      success: true,
      message: 'Signed in successfully!',
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
        patientId: user.patientId,
        doctorId: user.doctorId
      },
      patient: patientData,
      doctor: doctorData
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.status(200).json({ success: true, message: 'Logged out successfully.' });
});

app.get('/api/auth/me', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const user = await dbService.findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const [patientData, doctorData] = await Promise.all([
      user.role === 'patient' ? dbService.getPatientProfile(user.patientId || user.id) : null,
      user.role === 'doctor' ? dbService.getDoctorById(user.doctorId || 'doc-1') : null
    ]);

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
        patientId: user.patientId,
        doctorId: user.doctorId
      },
      patient: patientData,
      doctor: doctorData
    });
  } catch (err) {
    console.error('Auth /me error:', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ==========================================
// 1.1 PASSWORD RECOVERY & MANAGEMENT APIS
// ==========================================

// 1. Request Password Reset (Send 6-digit OTP)
app.post('/api/auth/forgot-password', async (req, res) => {
  const reqStart = Date.now();
  const reqIso = new Date().toISOString();
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address format.' });
    }

    const masked = cleanEmail.replace(/(.{3}).*(@.*)/, '$1***$2');
    console.log(`[OTP-Trace] [${reqIso}] 📥 Request received for: ${masked}`);

    // Rate Limiting: Max 3 requests per 15 minutes per email
    const tRateStart = Date.now();
    const allowed = await dbService.checkResetRateLimit(cleanEmail, 3, 15);
    const rateCheckMs = Date.now() - tRateStart;

    if (!allowed) {
      console.warn(`[OTP-Trace] [${new Date().toISOString()}] ⚠️ Rate limited for: ${masked} (Checked in ${rateCheckMs}ms)`);
      return res.status(429).json({
        success: false,
        message: 'Too many recovery attempts. For your security, please wait 15 minutes before requesting another code.'
      });
    }

    // Check user existence
    const tUserStart = Date.now();
    const user = await dbService.findUserByEmailOrPhone(cleanEmail);
    const userLookupMs = Date.now() - tUserStart;

    if (!user) {
      console.log(`[OTP-Trace] [${new Date().toISOString()}] ℹ️ Non-existent email requested (Anti-enumeration triggered in ${userLookupMs}ms)`);
      return res.status(200).json({
        success: true,
        message: 'If an account exists with this email, a 6-digit verification code has been sent.'
      });
    }

    // Generate cryptographically secure 6-digit numeric OTP with 15-minute expiry
    const tGenStart = Date.now();
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15-minute expiry to safeguard against SMTP delivery queueing
    const resetId = `rst-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const genMs = Date.now() - tGenStart;
    console.log(`[OTP-Trace] [${new Date().toISOString()}] 🔑 6-digit OTP generated & hashed in ${genMs}ms. Valid until: ${expiresAt.toISOString()}`);

    // Persist reset record
    const tDbStart = Date.now();
    await dbService.createPasswordReset({
      id: resetId,
      email: user.email,
      otpHash,
      expiresAt
    });
    const dbSaveMs = Date.now() - tDbStart;
    console.log(`[OTP-Trace] [${new Date().toISOString()}] 💾 Reset record saved to storage in ${dbSaveMs}ms (ID: ${resetId})`);

    // Send email using real SMTP transporter if configured or dev console fallback
    const tMailStart = Date.now();
    try {
      console.log(`[OTP-Trace] [${new Date().toISOString()}] 🚀 Submitting OTP email to Brevo SMTP relay...`);
      const dispatchResult = await sendPasswordResetOtpEmail({
        to: user.email,
        otp,
        name: user.name
      });
      const mailMs = Date.now() - tMailStart;
      console.log(`[OTP-Trace] [${new Date().toISOString()}] 🏁 Brevo relay submission finished in ${mailMs}ms.`);
      console.log(`[OTP-Trace]    └─ Mode: ${dispatchResult.mode}, Message-ID: ${dispatchResult.messageId || 'N/A'}`);
      if (dispatchResult.response) {
        console.log(`[OTP-Trace]    └─ Server Response: ${dispatchResult.response}`);
      }
    } catch (mailErr) {
      const mailFailMs = Date.now() - tMailStart;
      console.error(`[OTP-Trace] [${new Date().toISOString()}] ❌ Failed to dispatch email after ${mailFailMs}ms:`, mailErr.message);
      // Clean up the pending reset attempt so failed dispatch doesn't consume rate limit attempts!
      try {
        await dbService.deletePasswordReset(resetId);
      } catch (cleanupErr) {
        console.error('[Auth] Error rolling back reset attempt:', cleanupErr.message);
      }

      // Never falsely claim email was sent when delivery failed
      return res.status(503).json({
        success: false,
        message: 'Unable to deliver verification email at this moment. Please verify mail configuration or try again shortly.'
      });
    }

    const totalMs = Date.now() - reqStart;
    console.log(`[OTP-Trace] [${new Date().toISOString()}] 📤 HTTP 200 returned to client. Total server processing latency: ${totalMs}ms`);

    res.status(200).json({
      success: true,
      message: 'If an account exists with this email, a 6-digit verification code has been sent.',
      ...(process.env.NODE_ENV !== 'production' ? { devOtp: otp } : {})
    });
  } catch (err) {
    console.error('Forgot-password error:', err);
    res.status(500).json({ success: false, message: 'Password recovery request failed. Please try again.' });
  }
});

// 2. Verify 6-digit OTP & Issue Reset Token
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and 6-digit verification code are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanOtp = String(otp).trim();

    if (!/^\d{6}$/.test(cleanOtp)) {
      return res.status(400).json({ success: false, message: 'Verification code must be exactly 6 digits.' });
    }

    const activeReset = await dbService.getLatestActiveReset(cleanEmail);
    if (!activeReset) {
      return res.status(400).json({
        success: false,
        message: 'Verification code has expired or is invalid. Please request a new code.'
      });
    }

    const maxAttempts = activeReset.max_attempts || 5;
    if (activeReset.attempts >= maxAttempts) {
      return res.status(429).json({
        success: false,
        message: 'Maximum verification attempts exceeded. Please request a new code.'
      });
    }

    const candidateHash = crypto.createHash('sha256').update(cleanOtp).digest('hex');
    if (candidateHash !== activeReset.otp_hash) {
      await dbService.incrementResetAttempts(activeReset.id);
      const remaining = maxAttempts - (activeReset.attempts + 1);
      return res.status(400).json({
        success: false,
        message: remaining > 0
          ? `Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
          : 'Invalid verification code. Maximum attempts exceeded. Please request a new code.'
      });
    }

    // OTP Verified: Bind single-use resetToken valid for 10 minutes
    const resetToken = 'rsttok_' + crypto.randomBytes(32).toString('hex');
    const tokenExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await dbService.bindResetToken(activeReset.id, resetToken, tokenExpiresAt);

    res.status(200).json({
      success: true,
      message: 'Code verified successfully.',
      resetToken
    });
  } catch (err) {
    console.error('Verify-OTP error:', err);
    res.status(500).json({ success: false, message: 'Verification failed. Please try again.' });
  }
});

// 3. Reset Password using bound resetToken
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, resetToken, newPassword } = req.body;
    if (!email || !resetToken || !newPassword) {
      return res.status(400).json({ success: false, message: 'Email, reset token, and new password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    // Check token and recovery request binding
    const resetRecord = await dbService.getResetByTokenAndEmail(resetToken, cleanEmail);
    if (!resetRecord) {
      return res.status(400).json({
        success: false,
        message: 'Reset authorization is invalid or has expired. Please restart the password recovery process.'
      });
    }

    // Hash new password using bcrypt
    const passwordHash = bcrypt.hashSync(newPassword, 10);

    // Update user in database and increment token_version to invalidate prior sessions
    const updatedUser = await dbService.updateUserPassword(cleanEmail, passwordHash);
    if (!updatedUser) {
      return res.status(404).json({ success: false, message: 'User account not found.' });
    }

    // Mark reset record as used (single-use enforcement)
    await dbService.markResetUsed(resetRecord.id);

    // Invalidate active session cookie on this client
    clearAuthCookie(res);

    res.status(200).json({
      success: true,
      message: 'Password reset successfully! You can now log in with your new password.'
    });
  } catch (err) {
    console.error('Reset-password error:', err);
    res.status(500).json({ success: false, message: 'Password reset failed. Please try again.' });
  }
});

// 4. Authenticated Change Password (Profile Area)
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current password and new password are required.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
    }

    const user = await dbService.findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User account not found.' });
    }

    const isMatch = bcrypt.compareSync(currentPassword, user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password does not match.' });
    }

    const passwordHash = bcrypt.hashSync(newPassword, 10);
    const updatedUser = await dbService.updateUserPassword(user.email, passwordHash);

    // Issue updated token with incremented tokenVersion
    const newToken = generateToken({
      id: updatedUser.id,
      email: updatedUser.email,
      role: updatedUser.role,
      name: updatedUser.name,
      patientId: updatedUser.patientId,
      doctorId: updatedUser.doctorId,
      tokenVersion: updatedUser.tokenVersion
    });

    setAuthCookie(res, newToken);

    res.status(200).json({
      success: true,
      message: 'Password changed successfully.',
      token: newToken
    });
  } catch (err) {
    console.error('Change-password error:', err);
    res.status(500).json({ success: false, message: 'Unable to update password. Please try again.' });
  }
});


// ==========================================
// 1.5. HEALTHCARE INTEROPERABILITY & FHIR R4 APIS
// ==========================================

app.get('/api/healthcare/status', (req, res) => {
  res.json({
    success: true,
    data: healthcareDataProvider.getStatus()
  });
});

app.post('/api/healthcare/switch-provider', (req, res) => {
  const { mode } = req.body;
  const status = healthcareDataProvider.switchProvider(mode || 'synthetic');
  res.json({
    success: true,
    message: `Healthcare Data Provider switched to ${status.activeMode.toUpperCase()}`,
    data: status
  });
});

app.get('/api/healthcare/patients', async (req, res) => {
  try {
    const provider = healthcareDataProvider.getProvider();
    const patients = await provider.getPatients(req.query);
    res.json({
      success: true,
      count: patients.length,
      resourceType: "Bundle",
      type: "searchset",
      data: patients
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/healthcare/patients/:id', async (req, res) => {
  try {
    const provider = healthcareDataProvider.getProvider();
    const patient = await provider.getPatientById(req.params.id);
    if (!patient) return res.status(404).json({ success: false, message: 'FHIR Patient resource not found' });
    res.json({
      success: true,
      data: patient
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get(['/api/healthcare/doctors', '/api/healthcare/practitioners'], async (req, res) => {
  try {
    const provider = healthcareDataProvider.getProvider();
    const practitioners = await provider.getPractitioners(req.query);
    res.json({
      success: true,
      count: practitioners.length,
      resourceType: "Bundle",
      type: "searchset",
      data: practitioners
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get(['/api/healthcare/doctors/:id', '/api/healthcare/practitioners/:id'], async (req, res) => {
  try {
    const provider = healthcareDataProvider.getProvider();
    const practitioner = await provider.getPractitionerById(req.params.id);
    if (!practitioner) return res.status(404).json({ success: false, message: 'FHIR Practitioner resource not found' });
    res.json({
      success: true,
      data: practitioner
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/healthcare/organizations', async (req, res) => {
  try {
    const provider = healthcareDataProvider.getProvider();
    const orgs = await provider.getOrganizations();
    res.json({
      success: true,
      count: orgs.length,
      resourceType: "Bundle",
      data: orgs
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get(['/api/healthcare/schedules', '/api/healthcare/schedules/:doctorId'], async (req, res) => {
  try {
    const provider = healthcareDataProvider.getProvider();
    const doctorId = req.params.doctorId || req.query.doctorId || 'doc-1';
    const schedules = await provider.getSchedules(doctorId);
    res.json({
      success: true,
      count: schedules.length,
      resourceType: "Bundle",
      data: schedules
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get(['/api/healthcare/slots', '/api/healthcare/slots/:doctorId'], async (req, res) => {
  try {
    const provider = healthcareDataProvider.getProvider();
    const doctorId = req.params.doctorId || req.query.doctorId || 'doc-1';
    const slots = await provider.getSlots(doctorId, req.query.date);
    res.json({
      success: true,
      count: slots.length,
      resourceType: "Bundle",
      data: slots
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/healthcare/appointments', async (req, res) => {
  try {
    const provider = healthcareDataProvider.getProvider();
    const apts = await provider.getAppointments(req.query);
    res.json({
      success: true,
      count: apts.length,
      resourceType: "Bundle",
      type: "searchset",
      data: apts
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/healthcare/appointments', async (req, res) => {
  try {
    const provider = healthcareDataProvider.getProvider();
    const createdApt = await provider.createAppointment(req.body);
    res.status(201).json({
      success: true,
      message: 'FHIR Appointment resource created',
      data: createdApt
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/healthcare/encounters', async (req, res) => {
  try {
    const provider = healthcareDataProvider.getProvider();
    const encounters = await provider.getEncounters(req.query);
    res.json({
      success: true,
      count: encounters.length,
      resourceType: "Bundle",
      data: encounters
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/healthcare/encounters/:id', async (req, res) => {
  try {
    const provider = healthcareDataProvider.getProvider();
    const enc = await provider.getEncounterById(req.params.id);
    if (!enc) return res.status(404).json({ success: false, message: 'FHIR Encounter resource not found' });
    res.json({
      success: true,
      data: enc
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get(['/api/healthcare/observations', '/api/healthcare/observations/:patientId'], async (req, res) => {
  try {
    const provider = healthcareDataProvider.getProvider();
    const patientId = req.params.patientId || req.query.patientId || 'pat-1';
    const obs = await provider.getObservations(patientId);
    res.json({
      success: true,
      count: obs.length,
      resourceType: "Bundle",
      data: obs
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get(['/api/healthcare/reports', '/api/healthcare/reports/:patientId', '/api/healthcare/diagnostic-reports', '/api/healthcare/diagnostic-reports/:patientId'], async (req, res) => {
  try {
    const provider = healthcareDataProvider.getProvider();
    const patientId = req.params.patientId || req.query.patientId || 'pat-1';
    const reports = await provider.getDiagnosticReports(patientId);
    res.json({
      success: true,
      count: reports.length,
      resourceType: "Bundle",
      data: reports
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get(['/api/healthcare/documents', '/api/healthcare/documents/:patientId', '/api/healthcare/document-references', '/api/healthcare/document-references/:patientId'], async (req, res) => {
  try {
    const provider = healthcareDataProvider.getProvider();
    const patientId = req.params.patientId || req.query.patientId || 'pat-1';
    const docs = await provider.getDocumentReferences(patientId);
    res.json({
      success: true,
      count: docs.length,
      resourceType: "Bundle",
      data: docs
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 2. LOCATIONS & DOCTORS API
// ==========================================

app.get('/api/locations', async (req, res) => {
  try {
    const locations = await dbService.getLocations();
    res.json({ success: true, count: locations.length, data: locations });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/doctors', async (req, res) => {
  try {
    const list = await dbService.getDoctors(req.query);

    // Attach real-time live queue calculations to each doctor
    const enriched = await Promise.all(list.map(async (doc) => {
      const queue = await getDoctorQueueStats(doc.id);
      const totalInQueue = queue.waitingCount + (queue.nowConsulting ? 1 : 0);
      return {
        ...doc,
        currentQueueCount: totalInQueue,
        waitingCount: queue.waitingCount,
        estimatedWaitTime: totalInQueue * doc.averageDurationMinutes,
        nowConsultingPatient: queue.nowConsulting ? queue.nowConsulting.patientName : null
      };
    }));

    res.json({ success: true, count: enriched.length, data: enriched });
  } catch (err) {
    console.error('Get doctors error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/doctors/:id', async (req, res) => {
  try {
    const doc = await dbService.getDoctorById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: 'Doctor not found' });
    const queue = await getDoctorQueueStats(doc.id);
    res.json({
      success: true,
      data: {
        ...doc,
        queue
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 3. APPOINTMENTS API
// ==========================================

app.get('/api/appointments', requireAuth, async (req, res) => {
  try {
    const { doctorId, status } = req.query;
    const filter = { status };

    if (req.user.role === 'patient') {
      filter.patientId = req.user.patientId || 'pat-1';
    } else if (req.user.role === 'doctor') {
      filter.doctorId = req.user.doctorId || doctorId || 'doc-1';
    }

    const list = await dbService.getAppointments(filter);
    res.json({ success: true, count: list.length, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/appointments/:id', requireAuth, async (req, res) => {
  try {
    const apt = await dbService.getAppointmentById(req.params.id);
    if (!apt) return res.status(404).json({ success: false, message: 'Appointment not found' });

    // Ownership verification
    if (req.user.role === 'patient' && apt.patientId !== req.user.patientId && apt.patientId !== 'pat-1') {
      return res.status(403).json({ success: false, message: 'Unauthorized to view this appointment.' });
    }
    if (req.user.role === 'doctor' && req.user.doctorId && apt.doctorId !== req.user.doctorId) {
      return res.status(403).json({ success: false, message: 'Unauthorized. Doctor mismatch.' });
    }

    const queueStats = await getDoctorQueueStats(apt.doctorId);
    let patientsAhead = 0;
    let estimatedWaitMinutes = 0;

    if (apt.status === 'waiting') {
      patientsAhead = queueStats.waitingList.filter(w => w.queuePosition < apt.queuePosition).length + (queueStats.nowConsulting ? 1 : 0);
      estimatedWaitMinutes = patientsAhead * queueStats.avgDuration;
    }

    res.json({
      success: true,
      data: {
        ...apt,
        liveQueue: {
          nowConsulting: queueStats.nowConsulting,
          calledPatient: queueStats.calledPatient,
          patientsAhead,
          estimatedWaitMinutes,
          queuePosition: apt.queuePosition,
          queueState: apt.queueState || 'WAITING',
          doctorStatus: queueStats.doctorStatus
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/appointments', requireAuth, async (req, res) => {
  try {
    const { doctorId, patientName, date, time, consultationType, reason } = req.body;
    const doctor = await dbService.getDoctorById(doctorId);
    if (!doctor) return res.status(400).json({ success: false, message: 'Invalid doctor' });

    const effectivePatientId = req.user.patientId || "pat-1";
    const effectivePatientName = patientName || req.user.name || "Rahul Sharma";

    const todaysDocApts = await dbService.getAppointments({ doctorId, date: (date || "2026-10-05") });
    const maxTokenNum = todaysDocApts.length + 1;
    const tokenNumber = `Q-${maxTokenNum < 10 ? '0' + maxTokenNum : maxTokenNum}`;

    const waitingList = todaysDocApts.filter(a => a.status === 'waiting' && a.queueState !== 'COMPLETED');
    const hasNowConsulting = todaysDocApts.some(a => a.status === 'now_consulting' || a.queueState === 'IN_CONSULTATION');
    const queuePosition = waitingList.length + (hasNowConsulting ? 2 : 1);
    const patientsAhead = waitingList.length + (hasNowConsulting ? 1 : 0);
    const estimatedWaitMinutes = patientsAhead * doctor.averageDurationMinutes;

    const newAppointment = await dbService.createAppointment({
      id: `apt-${Date.now()}`,
      tokenNumber,
      doctorId,
      doctorName: doctor.name,
      doctorSpecialty: doctor.specialty,
      doctorAvatar: doctor.avatar,
      hospital: doctor.hospital,
      location: doctor.location,
      patientId: effectivePatientId,
      patientName: effectivePatientName,
      patientAge: 31,
      patientGender: "Male",
      date: date || "2026-10-05",
      time: time || "04:00 PM",
      consultationType: consultationType || "In-Clinic",
      reason: reason || "Consultation & clinical evaluation",
      status: "waiting",
      queueState: queuePosition === 1 ? "NEAR_TURN" : "WAITING",
      queuePosition,
      aiPreConsultation: {
        completed: false,
        chiefComplaint: "",
        duration: "",
        severity: "",
        associatedSymptoms: "",
        priorHistory: "",
        summaryText: ""
      },
      doctorNotes: "",
      consultationSummary: null
    });

    // Trigger Notification for Patient
    await createNotification({
      userId: req.user.id,
      patientId: effectivePatientId,
      title: "✓ Appointment Confirmed",
      message: `Your appointment with ${doctor.name} (${doctor.specialty}) is confirmed for ${time || '04:00 PM'}. Queue Token: ${tokenNumber}.`,
      type: "Appointment",
      relatedId: newAppointment.id
    });

    // Broadcast update
    const queueStats = await getDoctorQueueStats(doctorId);
    broadcastEvent('queue_updated', {
      doctorId,
      queue: queueStats,
      appointmentId: newAppointment.id,
      action: 'book'
    });

    res.status(201).json({
      success: true,
      data: newAppointment,
      patientsAhead,
      estimatedWaitMinutes,
      tokenNumber
    });
  } catch (err) {
    console.error('Book appointment error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 4. QUEUE MANAGEMENT & DOCTOR WORKFLOW API
// ==========================================

app.get('/api/queue/:doctorId', async (req, res) => {
  try {
    const stats = await getDoctorQueueStats(req.params.doctorId);
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Doctor calls patient into chamber (CALLED state)
app.post('/api/queue/:doctorId/call-next', requireAuth, requireRole('doctor'), async (req, res) => {
  try {
    const doctorId = req.params.doctorId;
    const docApts = await dbService.getAppointments({ doctorId, date: "2026-10-05" });

    const waitingList = docApts
      .filter(a => a.status === 'waiting' && a.queueState !== 'COMPLETED')
      .sort((a, b) => a.queuePosition - b.queuePosition);

    if (waitingList.length === 0) {
      return res.status(400).json({ success: false, message: 'No waiting patients in queue.' });
    }

    const nextPatient = waitingList[0];
    nextPatient.queueState = 'CALLED';
    await dbService.updateAppointment(nextPatient.id, { queueState: 'CALLED' });

    // Trigger high-priority notification for patient
    await createNotification({
      patientId: nextPatient.patientId,
      title: "🔔 It's Your Turn!",
      message: `Dr. ${nextPatient.doctorName} is ready for you. Please step into the consultation room.`,
      type: "Queue",
      relatedId: nextPatient.id
    });

    const updatedQueue = await getDoctorQueueStats(doctorId);

    broadcastEvent('queue_updated', {
      doctorId,
      queue: updatedQueue,
      action: 'patient_called',
      calledPatient: nextPatient
    });

    res.json({
      success: true,
      message: `Called ${nextPatient.patientName} (${nextPatient.tokenNumber}) into chamber.`,
      data: updatedQueue,
      calledPatient: nextPatient
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Doctor starts consultation (IN_CONSULTATION state)
app.post('/api/queue/:doctorId/start-consultation', requireAuth, requireRole('doctor'), async (req, res) => {
  try {
    const doctorId = req.params.doctorId;
    const { appointmentId } = req.body;

    const docApts = await dbService.getAppointments({ doctorId, date: "2026-10-05" });
    let targetApt = appointmentId 
      ? docApts.find(a => a.id === appointmentId) 
      : docApts.find(a => a.queueState === 'CALLED' || a.status === 'waiting');

    if (!targetApt) {
      return res.status(400).json({ success: false, message: 'No target appointment to start.' });
    }

    // Set previous now_consulting to completed if needed
    for (const a of docApts) {
      if (a.id !== targetApt.id && a.status === 'now_consulting') {
        await dbService.updateAppointment(a.id, { status: 'completed', queueState: 'COMPLETED' });
      }
    }

    targetApt.status = 'now_consulting';
    targetApt.queueState = 'IN_CONSULTATION';
    targetApt.queuePosition = 1;
    await dbService.updateAppointment(targetApt.id, {
      status: 'now_consulting',
      queueState: 'IN_CONSULTATION',
      queuePosition: 1
    });

    await createNotification({
      patientId: targetApt.patientId,
      title: "🟢 Consultation Started",
      message: `Consultation with Dr. ${targetApt.doctorName} is now in progress.`,
      type: "Consultation",
      relatedId: targetApt.id
    });

    const updatedQueue = await getDoctorQueueStats(doctorId);

    broadcastEvent('queue_updated', {
      doctorId,
      queue: updatedQueue,
      action: 'consultation_started',
      currentPatient: targetApt
    });

    res.json({
      success: true,
      message: `Started consultation for ${targetApt.patientName}.`,
      data: updatedQueue,
      currentPatient: targetApt
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Doctor completes consultation & automatically generates structured report
app.post('/api/queue/:doctorId/complete', requireAuth, requireRole('doctor'), async (req, res) => {
  try {
    const doctorId = req.params.doctorId;
    const { appointmentId, doctorNotes, observations, clinicalSummary, advice, followUpDate, followUpReason } = req.body;

    const docApts = await dbService.getAppointments({ doctorId, date: "2026-10-05" });

    let targetApt = appointmentId 
      ? docApts.find(a => a.id === appointmentId)
      : docApts.find(a => a.status === 'now_consulting' || a.queueState === 'IN_CONSULTATION' || a.queueState === 'CALLED');

    if (targetApt) {
      const intake = targetApt.aiPreConsultation || {};
      const doctor = (await dbService.getDoctorById(doctorId)) || {
        id: doctorId,
        name: targetApt.doctorName,
        specialty: targetApt.doctorSpecialty,
        hospital: targetApt.hospital,
        location: targetApt.location
      };

      // Auto-generate structured consultation report
      const newReport = await dbService.createConsultationReport({
        id: `rep-${Date.now()}`,
        appointmentId: targetApt.id,
        patientId: targetApt.patientId,
        patientName: targetApt.patientName,
        patientAge: targetApt.patientAge || 31,
        patientGender: targetApt.patientGender || "Male",
        doctorId: doctor.id || doctorId,
        doctorName: doctor.name,
        doctorSpecialty: doctor.specialty,
        hospital: doctor.hospital,
        location: doctor.location,
        date: targetApt.date || "2026-10-05",
        time: targetApt.time || "04:00 PM",
        chiefComplaint: intake.chiefComplaint || targetApt.reason || "Clinical Consultation",
        symptomsReported: intake.summaryText || `${intake.chiefComplaint || targetApt.reason} (Duration: ${intake.duration || 'recent'}, Severity: ${intake.severity || 'Moderate'})`,
        patientProvidedInfo: intake.priorHistory ? `Prior History: ${intake.priorHistory}` : "Pre-consultation intake recorded via MediFlow AI Assistant.",
        doctorObservations: observations || "Vital parameters recorded and evaluated. Systemic examination satisfactory.",
        doctorNotes: doctorNotes || targetApt.doctorNotes || "Patient examined thoroughly. Clinical findings documented and management plan initiated.",
        clinicalSummary: clinicalSummary || `Clinical evaluation for ${intake.chiefComplaint || targetApt.reason}. Patient responding adequately.`,
        advice: advice || "1. Adhere to prescribed supportive care.\n2. Maintain proper rest and hydration.\n3. Monitor symptoms and report any exacerbation.",
        followUp: {
          recommended: Boolean(followUpDate),
          recommendedDate: followUpDate || null,
          reason: followUpReason || "Review recovery progress"
        },
        status: "Completed"
      });

      targetApt.status = 'completed';
      targetApt.queueState = 'COMPLETED';
      targetApt.queuePosition = 0;
      targetApt.doctorNotes = doctorNotes || targetApt.doctorNotes;
      targetApt.consultationSummary = newReport;

      await dbService.updateAppointment(targetApt.id, {
        status: 'completed',
        queueState: 'COMPLETED',
        queuePosition: 0,
        doctorNotes: targetApt.doctorNotes,
        consultationSummary: newReport
      });

      // Trigger Notification for Patient
      await createNotification({
        patientId: targetApt.patientId,
        title: "📋 Consultation Report Ready",
        message: `Your consultation with Dr. ${doctor.name} is complete. Your official medical summary and PDF report are ready.`,
        type: "Report",
        relatedId: newReport.id
      });
    }

    // Shift queue and promote next patient
    const waitingList = docApts
      .filter(a => a.status === 'waiting' && (!targetApt || a.id !== targetApt.id))
      .sort((a, b) => a.queuePosition - b.queuePosition);

    let nextInLine = null;
    if (waitingList.length > 0) {
      nextInLine = waitingList[0];
      nextInLine.status = 'now_consulting';
      nextInLine.queueState = 'IN_CONSULTATION';
      nextInLine.queuePosition = 1;

      await dbService.updateAppointment(nextInLine.id, {
        status: 'now_consulting',
        queueState: 'IN_CONSULTATION',
        queuePosition: 1
      });

      // Shift remaining waiting list
      for (let idx = 1; idx < waitingList.length; idx++) {
        const apt = waitingList[idx];
        apt.queuePosition = idx + 1;
        apt.queueState = (idx === 1) ? 'NEAR_TURN' : 'WAITING';

        await dbService.updateAppointment(apt.id, {
          queuePosition: apt.queuePosition,
          queueState: apt.queueState
        });

        if (idx === 1) {
          await createNotification({
            patientId: apt.patientId,
            title: "⏳ You are Next in Line",
            message: `Only 1 patient ahead of you for Dr. ${apt.doctorName}. Please stay near the virtual waiting room.`,
            type: "Queue",
            relatedId: apt.id
          });
        }
      }

      await createNotification({
        patientId: nextInLine.patientId,
        title: "🟢 Now Consulting",
        message: `You are now consulting with Dr. ${nextInLine.doctorName}. Please enter consultation.`,
        type: "Queue",
        relatedId: nextInLine.id
      });
    }

    const updatedQueue = await getDoctorQueueStats(doctorId);

    broadcastEvent('queue_updated', {
      doctorId,
      queue: updatedQueue,
      action: 'consultation_completed',
      completedAppointment: targetApt,
      currentPatient: nextInLine
    });

    res.json({
      success: true,
      message: nextInLine 
        ? `Consultation completed. ${nextInLine.patientName} is now consulting.`
        : 'Consultation completed. Queue is now clear.',
      data: updatedQueue,
      appointment: targetApt,
      currentPatient: nextInLine
    });
  } catch (err) {
    console.error('Complete consultation error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 5. CONSULTATION REPORTS & PDF GENERATOR
// ==========================================

app.get('/api/consultations/reports', requireAuth, async (req, res) => {
  try {
    const filter = {};
    if (req.user.role === 'patient') {
      filter.patientId = req.user.patientId || 'pat-1';
    } else if (req.user.role === 'doctor') {
      filter.doctorId = req.user.doctorId || 'doc-1';
    }

    const list = await dbService.getConsultationReports(filter);
    res.json({ success: true, count: list.length, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/consultations/reports/:id', requireAuth, async (req, res) => {
  try {
    const report = await dbService.getConsultationReportById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Consultation report not found' });

    // Ownership check
    if (req.user.role === 'patient' && report.patientId !== req.user.patientId && report.patientId !== 'pat-1') {
      return res.status(403).json({ success: false, message: 'Unauthorized to access this medical report.' });
    }

    res.json({ success: true, data: report });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Stream Professional Downloadable PDF Report
app.get('/api/consultations/reports/:id/pdf', requireAuth, async (req, res) => {
  try {
    const report = await dbService.getConsultationReportById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Consultation report not found' });

    if (req.user.role === 'patient' && report.patientId !== req.user.patientId && report.patientId !== 'pat-1') {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const doc = new PDFDocument({ margin: 45, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="MediFlow-Consultation-Report-${report.id}.pdf"`);

    doc.pipe(res);

    // Header Banner
    doc.rect(45, 45, 505, 55).fill('#0f766e'); // Teal-700
    doc.fillColor('#ffffff').fontSize(20).font('Helvetica-Bold').text('MEDIFLOW HEALTHCARE', 60, 58);
    doc.fontSize(10).font('Helvetica').text('AI-Assisted Virtual Waiting Room & Clinical Network', 60, 80);
    doc.fontSize(10).font('Helvetica-Bold').text(`REPORT #${report.id.toUpperCase()}`, 400, 68, { align: 'right' });

    doc.moveDown(3);

    // Meta Grid: Patient & Doctor Info
    doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text('PATIENT INFORMATION', 45, 120);
    doc.rect(45, 135, 245, 90).fillAndStroke('#f8fafc', '#e2e8f0');
    doc.fillColor('#334155').fontSize(9).font('Helvetica')
      .text(`Name: ${report.patientName}`, 55, 145)
      .text(`Age / Gender: ${report.patientAge} yrs / ${report.patientGender}`, 55, 160)
      .text(`Patient ID: ${report.patientId}`, 55, 175)
      .text(`Date of Visit: ${report.date} at ${report.time}`, 55, 190)
      .text(`Status: Verified & Completed`, 55, 205);

    doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text('CONSULTING PHYSICIAN', 305, 120);
    doc.rect(305, 135, 245, 90).fillAndStroke('#f8fafc', '#e2e8f0');
    doc.fillColor('#334155').fontSize(9).font('Helvetica')
      .text(`Doctor: ${report.doctorName}`, 315, 145)
      .text(`Specialty: ${report.doctorSpecialty}`, 315, 160)
      .text(`Hospital: ${report.hospital}`, 315, 175, { width: 225 })
      .text(`Location: ${report.location}, India`, 315, 205);

    let y = 245;

    // Section: Chief Complaint & Symptoms
    doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text('1. CHIEF COMPLAINT & PRESENTING SYMPTOMS', 45, y);
    y += 18;
    doc.rect(45, y, 505, 45).fillAndStroke('#ffffff', '#cbd5e1');
    doc.fillColor('#1e293b').fontSize(9).font('Helvetica')
      .text(report.chiefComplaint || 'Routine evaluation', 55, y + 8, { width: 485 })
      .text(`Reported Details: ${report.symptomsReported || 'Standard review'}`, 55, y + 24, { width: 485 });
    y += 60;

    // Section: Doctor Observations & Clinical Notes
    doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text('2. CLINICAL EXAMINATION & OBSERVATIONS', 45, y);
    y += 18;
    doc.rect(45, y, 505, 55).fillAndStroke('#ffffff', '#cbd5e1');
    doc.fillColor('#1e293b').fontSize(9).font('Helvetica')
      .text(`Doctor Observations: ${report.doctorObservations || 'Satisfactory baseline'}`, 55, y + 8, { width: 485 })
      .text(`Physician Notes: ${report.doctorNotes || 'Routine care advised'}`, 55, y + 30, { width: 485 });
    y += 70;

    // Section: Clinical Summary & Diagnosis
    doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text('3. CLINICAL SUMMARY & ASSESSMENT', 45, y);
    y += 18;
    doc.rect(45, y, 505, 45).fillAndStroke('#f0fdfa', '#99f6e4'); // Teal tint
    doc.fillColor('#115e59').fontSize(9.5).font('Helvetica-Bold')
      .text(report.clinicalSummary || 'Clinical review completed', 55, y + 10, { width: 485 });
    y += 60;

    // Section: Medical Advice & Follow-Up Plan
    doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text('4. PHYSICIAN ADVICE & FOLLOW-UP PLAN', 45, y);
    y += 18;
    doc.rect(45, y, 505, 65).fillAndStroke('#ffffff', '#cbd5e1');
    doc.fillColor('#1e293b').fontSize(9).font('Helvetica')
      .text(report.advice || 'Follow general healthcare advice and hydration.', 55, y + 8, { width: 485 })
      .text(`Recommended Follow-up: ${report.followUp?.recommended ? `${report.followUp.recommendedDate} (${report.followUp.reason})` : 'SOS as needed'}`, 55, y + 48, { width: 485 });
    y += 85;

    // Signature Block & Footer
    doc.rect(45, y, 505, 55).fillAndStroke('#f8fafc', '#e2e8f0');
    doc.fillColor('#64748b').fontSize(8).font('Helvetica')
      .text('Authenticity: Electronically authorized by consulting doctor via DOCBEE MediFlow Clinical Station.', 55, y + 10)
      .text('Disclaimer: AI pre-consultation intake is supplementary. Clinical determinations remain the sole authority of the licensed physician.', 55, y + 22, { width: 330 });

    doc.fillColor('#0f766e').fontSize(9).font('Helvetica-Bold')
      .text(`Dr. ${report.doctorName}`, 410, y + 15, { align: 'right' })
      .text('Authorized Signatory', 410, y + 28, { align: 'right' });

    doc.end();
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 6. NOTIFICATIONS API
// ==========================================

app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const patId = req.user.patientId || 'pat-1';
    const userNotifs = await dbService.getNotifications(req.user.id, patId);
    res.json({ success: true, count: userNotifs.length, data: userNotifs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.patch('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const notif = await dbService.markNotificationRead(req.params.id);
    res.json({ success: true, data: notif });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.patch('/api/notifications/mark-all-read', requireAuth, async (req, res) => {
  try {
    const patId = req.user.patientId || 'pat-1';
    await dbService.markAllNotificationsRead(req.user.id, patId);
    res.json({ success: true, message: 'All notifications marked as read.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/notifications/:id', requireAuth, async (req, res) => {
  try {
    await dbService.deleteNotification(req.params.id);
    res.json({ success: true, message: 'Notification dismissed.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 7. PATIENT PROFILE, FAMILY & DOCUMENTS API
// ==========================================

app.get('/api/patient/profile', requireAuth, async (req, res) => {
  try {
    const profile = await dbService.getPatientProfile(req.user.patientId || req.user.id);
    res.json({ success: true, data: profile });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/patient/profile', requireAuth, async (req, res) => {
  try {
    const updated = await dbService.updatePatientProfile({
      id: req.user.patientId || 'pat-1',
      userId: req.user.id,
      ...req.body
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/family', requireAuth, async (req, res) => {
  try {
    const members = await dbService.getFamilyMembers(req.user.patientId || 'pat-1');
    res.json({ success: true, data: members });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/family', requireAuth, async (req, res) => {
  try {
    const newMember = await dbService.createFamilyMember({
      id: `fam-${Date.now()}`,
      patientId: req.user.patientId || "pat-1",
      ...req.body
    });
    res.status(201).json({ success: true, data: newMember });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/documents', requireAuth, async (req, res) => {
  try {
    const patId = req.user.patientId || 'pat-1';
    const docs = await dbService.getMedicalDocuments(patId);
    res.json({ success: true, count: docs.length, data: docs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/documents', requireAuth, async (req, res) => {
  try {
    const newDoc = await dbService.createMedicalDocument({
      id: `doc-vault-${Date.now()}`,
      patientId: req.user.patientId || "pat-1",
      title: req.body.title || "Diagnostic Report",
      category: req.body.category || "Diagnostic Report",
      date: new Date().toISOString().split('T')[0],
      doctor: req.body.doctor || "Consulting Specialist",
      hospital: req.body.hospital || "Hospital Diagnostic Labs",
      fileSize: "1.5 MB",
      status: req.body.status || "Verified by Pathology",
      isSharedWithDoctor: true,
      type: "pdf"
    });
    res.status(201).json({ success: true, data: newDoc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.patch('/api/documents/:id/toggle-share', requireAuth, async (req, res) => {
  try {
    const doc = await dbService.toggleDocumentShare(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 8. AI ASSISTANT INTAKE & PRE-CONSULTATION
// ==========================================

app.post('/api/ai/pre-consultation', requireAuth, async (req, res) => {
  try {
    const { 
      appointmentId, 
      chiefComplaint, 
      duration, 
      location, 
      severity, 
      associatedSymptoms, 
      priorHistory,
      patientDescription 
    } = req.body;

    const apt = await dbService.getAppointmentById(appointmentId);
    
    const formattedSeverity = severity 
      ? (typeof severity === 'string' && severity.includes('/10') ? severity : `${severity}/10`) 
      : "6/10";

    const intakeData = {
      completed: true,
      chiefComplaint: chiefComplaint || "General symptoms evaluation",
      duration: duration || "2 days",
      location: location || "General",
      severity: formattedSeverity,
      associatedSymptoms: associatedSymptoms || "Fatigue",
      priorHistory: priorHistory || "No previous consultation",
      patientDescription: patientDescription || chiefComplaint || "Patient reported symptoms during pre-consultation intake",
      status: "Submitted",
      summaryText: `Chief complaint: ${chiefComplaint || 'Consultation review'} | Duration: ${duration || '2 days'} | Location: ${location || 'General'} | Severity: ${formattedSeverity} | Associated symptoms: ${associatedSymptoms || 'None'} | Prior treatment: ${priorHistory || 'None'}`,
      disclaimer: "This summary is based on information provided by the patient and is not a medical diagnosis.",
      completedAt: new Date().toISOString()
    };

    if (apt) {
      apt.aiPreConsultation = intakeData;
      await dbService.updateAppointment(apt.id, { aiPreConsultation: intakeData });
      broadcastEvent('appointment_updated', { appointment: apt });
      const queueStats = await getDoctorQueueStats(apt.doctorId);
      broadcastEvent('queue_updated', {
        doctorId: apt.doctorId,
        queue: queueStats,
        action: 'pre_consultation_updated'
      });
    }

    res.json({
      success: true,
      data: intakeData
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/ai/generate-summary', requireAuth, requireRole('doctor'), async (req, res) => {
  try {
    const { appointmentId, doctorNotes } = req.body;
    const apt = await dbService.getAppointmentById(appointmentId);

    const notesText = doctorNotes || (apt ? apt.doctorNotes : "Patient examined. Vital signs stable. Prescribed supportive treatment.");
    const intake = apt ? apt.aiPreConsultation : null;

    const summary = {
      chiefComplaint: intake && intake.chiefComplaint ? intake.chiefComplaint : "Primary consultation evaluation",
      symptomsDiscussed: intake && intake.associatedSymptoms ? `${intake.chiefComplaint}, ${intake.associatedSymptoms} (Duration: ${intake.duration || 'recent'})` : "Clinical symptoms reviewed with specialist",
      doctorNotes: notesText,
      clinicalObservations: "Vitals within normal baseline. Systemic evaluation satisfactory.",
      followUpRecommendation: "Adequate hydration, proper rest, and medication as discussed.",
      nextAppointment: "Recommended follow-up in 7-10 days if symptoms persist.",
      disclaimer: "AI-Assisted Clinical Summary: Formatted automatically from doctor consultation records. Verified and authorized by consulting physician.",
      generatedAt: new Date().toISOString()
    };

    if (apt) {
      apt.consultationSummary = summary;
      await dbService.updateAppointment(apt.id, { consultationSummary: summary });
      broadcastEvent('appointment_updated', { appointment: apt });
    }

    res.json({
      success: true,
      data: summary
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 9. DEMO RESET ENDPOINT
// ==========================================

app.post('/api/demo/reset', async (req, res) => {
  try {
    await dbService.resetDemoData();
    healthcareDataProvider.reset();

    broadcastEvent('demo_reset', { message: 'Demo data restored' });

    res.json({ success: true, message: 'Demo data reset successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 10. PRODUCTION STATIC & SPA FALLBACK
// ==========================================

const fs = require('fs');
const clientDistPath = path.join(__dirname, '../client/dist');
if (fs.existsSync(clientDistPath) || process.env.NODE_ENV === 'production') {
  app.use(express.static(clientDistPath));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next();
    }
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

// Server Startup with Database Initialization
async function startServer() {
  try {
    await initDatabase();
  } catch (err) {
    console.error('[MediFlow Server] Database initialization warning:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`[DOCBEE MediFlow Server] Running on http://localhost:${PORT} (NODE_ENV: ${process.env.NODE_ENV || 'development'})`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = app;
