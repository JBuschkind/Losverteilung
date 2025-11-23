require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const PORT = 8085;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ 
  server,
  clientTracking: true,
  perMessageDeflate: false
});

/**
 * Connection state
 * - participants: Map<ws, { name: string|null, email: string|null, sessionId: string }>
 * - masters: Set<ws>
 * - sessions: Map<sessionId, { name: string, email: string, target: string|null }>
 */
const participants = new Map();
const masters = new Set();
const sessions = new Map(); // Persistent session storage

// Email configuration (can be set via environment variables)
const emailConfig = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
};

// Create email transporter (only if credentials are provided)
let emailTransporter = null;
if (emailConfig.auth.user && emailConfig.auth.pass) {
  emailTransporter = nodemailer.createTransport(emailConfig);
} else {
  console.warn('WARNUNG: E-Mail-Konfiguration nicht gesetzt. E-Mails werden nicht versendet.');
  console.warn('Setze SMTP_USER und SMTP_PASS Umgebungsvariablen oder bearbeite server.js');
}

function generateSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

async function sendEmail(to, name, target) {
  if (!emailTransporter) {
    console.warn(`E-Mail würde an ${to} gesendet werden, aber E-Mail-Konfiguration fehlt.`);
    return false;
  }

  try {
    const info = await emailTransporter.sendMail({
      from: emailConfig.auth.user,
      to: to,
      subject: 'Dein Juleklapp Los',
      text: `Hallo ${name},\n\nDu beschenkst: ${target}\n\nViel Spaß beim Schenken!\n\nDiese E-Mail wurde automatisch von der Juleklapp Losverteilung gesendet.`,
      html: `
        <html>
          <body>
            <h2>Hallo ${name},</h2>
            <p>Du beschenkst: <strong>${target}</strong></p>
            <p>Viel Spaß beim Schenken!</p>
            <hr>
            <p><small>Diese E-Mail wurde automatisch von der Juleklapp Losverteilung gesendet.</small></p>
          </body>
        </html>
      `
    });
    console.log(`E-Mail erfolgreich an ${to} gesendet: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error(`Fehler beim Senden der E-Mail an ${to}:`, error);
    return false;
  }
}

function send(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastToMasters(message) {
  for (const ws of masters) {
    send(ws, message);
  }
}

function getParticipantNames() {
  const names = [];
  for (const { name } of participants.values()) {
    if (name) names.push(name);
  }
  // Also include offline participants (from sessions)
  for (const session of sessions.values()) {
    if (session.name && session.email && !session.target) {
      // Only include if not already in list and not yet drawn
      if (!names.some(n => n.toLowerCase() === session.name.toLowerCase())) {
        names.push(session.name);
      }
    }
  }
  names.sort((a, b) => a.localeCompare(b, 'de'));
  return names;
}

function getAllParticipants() {
  // Returns array of { name, email, online } objects
  const participantMap = new Map();
  
  // Add online participants
  for (const { name, email } of participants.values()) {
    if (name && email) {
      participantMap.set(name.toLowerCase(), { name, email, online: true });
    }
  }
  
  // Add offline participants (from sessions)
  for (const session of sessions.values()) {
    if (session.name && session.email && !session.target) {
      const key = session.name.toLowerCase();
      if (!participantMap.has(key)) {
        participantMap.set(key, { name: session.name, email: session.email, online: false });
      } else {
        // Update to show as online if they are
        participantMap.get(key).online = true;
      }
    }
  }
  
  const result = Array.from(participantMap.values());
  result.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return result;
}

function getParticipantInfo(name) {
  for (const info of participants.values()) {
    if (info.name && info.name.toLowerCase() === name.toLowerCase()) {
      return info;
    }
  }
  return null;
}

function isNameTaken(name) {
  const nameLower = name.toLowerCase();
  // Check online participants
  for (const { name: n } of participants.values()) {
    if (n && n.toLowerCase() === nameLower) return true;
  }
  // Check offline participants (from sessions)
  for (const session of sessions.values()) {
    if (session.name && session.name.toLowerCase() === nameLower && !session.target) {
      return true;
    }
  }
  return false;
}

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function readConstraintsFile(path = 'constraints.txt') {
  try {
    const raw = fs.readFileSync(path, 'utf8');
    const pairs = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split(',');
      if (parts.length !== 2) continue;
      const giver = parts[0].trim();
      const receiver = parts[1].trim();
      if (!giver || !receiver) continue;
      pairs.push([giver.toLowerCase(), receiver.toLowerCase()]);
    }
    return pairs;
  } catch (e) {
    return [];
  }
}

function buildBannedSet() {
  const pairs = readConstraintsFile();
  const set = new Set();
  for (const [g, r] of pairs) {
    set.add(`${g}|${r}`);
  }
  return set;
}

function writeDistributionFile(mapping, outPath = 'Lose.txt') {
  try {
    const lines = [];
    lines.push(`# Loseverteilung - erstellt am ${new Date().toISOString()}`);
    lines.push(`# Format: GEBER, EMPFÄNGER`);
    const pairs = Array.from(mapping.entries());
    pairs.sort((a, b) => a[0].localeCompare(b[0], 'de'));
    for (const [giver, receiver] of pairs) {
      lines.push(`${giver}, ${receiver}`);
    }
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  } catch (e) {
    console.error('Fehler beim Schreiben von Lose.txt:', e);
  }
}

function createDerangement(names, bannedSet) {
  if (names.length < 2) return null;
  // Try up to 1000 attempts (more than enough for family sizes)
  for (let attempt = 0; attempt < 1000; attempt++) {
    const perm = shuffle(names);
    let valid = true;
    for (let i = 0; i < names.length; i++) {
      if (perm[i] === names[i]) {
        valid = false;
        break;
      }
      if (bannedSet && bannedSet.has(`${names[i].toLowerCase()}|${perm[i].toLowerCase()}`)) {
        valid = false;
        break;
      }
    }
    if (valid) {
      const map = new Map();
      for (let i = 0; i < names.length; i++) {
        map.set(names[i], perm[i]);
      }
      return map;
    }
  }
  return null; // Very unlikely for small N, but handle just in case
}

function broadcastParticipantsUpdate() {
  const allParticipants = getAllParticipants();
  broadcastToMasters({ 
    type: 'participants', 
    participants: allParticipants.map(p => p.name),
    participantsWithEmail: allParticipants
  });
}

// Heartbeat mechanism to keep connections alive
function setupHeartbeat() {
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000); // Ping every 30 seconds
}

// Start heartbeat
setupHeartbeat();

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const role = url.searchParams.get('role') || 'participant';

  if (role === 'master') {
    masters.add(ws);
    const allParticipants = getAllParticipants();
    send(ws, { 
      type: 'participants', 
      participants: allParticipants.map(p => p.name),
      participantsWithEmail: allParticipants
    });
  } else {
    // Check for existing session via cookie
    const sessionId = req.headers.cookie ? 
      (req.headers.cookie.match(/sessionId=([^;]+)/) || [])[1] : null;
    
    let sessionData = null;
    if (sessionId && sessions.has(sessionId)) {
      sessionData = sessions.get(sessionId);
    }
    
    const participantData = { 
      name: sessionData?.name || null, 
      email: sessionData?.email || null,
      sessionId: sessionId || generateSessionId()
    };
    
    participants.set(ws, participantData);
    
    // If session exists, restore state
    if (sessionData) {
      if (sessionData.target) {
        // Already has a target, send it immediately
        send(ws, { type: 'your_target', target: sessionData.target });
      } else if (sessionData.name && sessionData.email) {
        // Has name and email but no target yet, confirm registration
        send(ws, { type: 'name_ok', name: sessionData.name });
      }
    }
  }

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    if (data.type === 'set_name' && typeof data.name === 'string' && typeof data.email === 'string') {
      const trimmed = data.name.trim();
      const trimmedEmail = data.email.trim();
      
      if (!trimmed) {
        send(ws, { type: 'error', message: 'Name darf nicht leer sein.' });
        return;
      }
      if (trimmed.length > 40) {
        send(ws, { type: 'error', message: 'Name ist zu lang (max. 40).' });
        return;
      }
      if (!trimmedEmail) {
        send(ws, { type: 'error', message: 'E-Mail-Adresse darf nicht leer sein.' });
        return;
      }
      if (!isValidEmail(trimmedEmail)) {
        send(ws, { type: 'error', message: 'Ungültige E-Mail-Adresse.' });
        return;
      }
      if (isNameTaken(trimmed)) {
        send(ws, { type: 'error', message: 'Name bereits vergeben. Bitte anderen wählen.' });
        return;
      }
      if (!participants.has(ws)) {
        // Ignore if this is not a participant socket
        send(ws, { type: 'error', message: 'Ungültige Aktion.' });
        return;
      }
      
      const participant = participants.get(ws);
      participant.name = trimmed;
      participant.email = trimmedEmail;
      
      // Save to session
      if (!sessions.has(participant.sessionId)) {
        sessions.set(participant.sessionId, { name: trimmed, email: trimmedEmail, target: null });
      } else {
        const session = sessions.get(participant.sessionId);
        session.name = trimmed;
        session.email = trimmedEmail;
      }
      
      send(ws, { type: 'name_ok', name: trimmed, sessionId: participant.sessionId });
      broadcastParticipantsUpdate();
    }

    if (role === 'master' && data.type === 'remove_name' && typeof data.name === 'string') {
      const target = data.name.trim();
      const targetLower = target.toLowerCase();
      
      // Remove from online participants
      for (const [sock, info] of participants.entries()) {
        if (info.name && info.name.toLowerCase() === targetLower) {
          info.name = null;
          info.email = null;
          send(sock, { type: 'reset' });
        }
      }
      
      // Remove from sessions (offline participants)
      for (const [sessionId, session] of sessions.entries()) {
        if (session.name && session.name.toLowerCase() === targetLower) {
          sessions.delete(sessionId);
        }
      }
      
      broadcastParticipantsUpdate();
    }

    if (role === 'master' && data.type === 'start_draw') {
      const names = getParticipantNames();
      if (names.length < 2) {
        send(ws, { type: 'error', message: 'Mindestens 2 Teilnehmer nötig.' });
        return;
      }
      const bannedSet = buildBannedSet();
      const mapping = createDerangement(names, bannedSet);
      if (!mapping) {
        send(ws, { type: 'error', message: 'Konnte keine gültige Verteilung finden. Bitte erneut versuchen.' });
        return;
      }
      // Send each participant their target and save to session
      const emailPromises = [];
      
      // Process online participants
      for (const [sock, info] of participants.entries()) {
        if (info.name && mapping.has(info.name)) {
          const target = mapping.get(info.name);
          send(sock, { type: 'your_target', target: target });
          
          // Update session with target
          if (info.sessionId && sessions.has(info.sessionId)) {
            sessions.get(info.sessionId).target = target;
          }
          
          // Send email
          if (info.email) {
            emailPromises.push(sendEmail(info.email, info.name, target));
          }
        }
      }
      
      // Process offline participants (from sessions)
      for (const [sessionId, session] of sessions.entries()) {
        if (session.name && session.email && !session.target && mapping.has(session.name)) {
          const target = mapping.get(session.name);
          session.target = target;
          
          // Send email to offline participant
          emailPromises.push(sendEmail(session.email, session.name, target));
        }
      }
      
      // Persist the distribution for independent verification
      writeDistributionFile(mapping);
      
      // Wait for emails to be sent (but don't block)
      Promise.all(emailPromises).then(results => {
        const successCount = results.filter(r => r).length;
        console.log(`${successCount} von ${emailPromises.length} E-Mails erfolgreich versendet.`);
      });
      
      // Notify masters that draw happened
      broadcastToMasters({ type: 'draw_complete' });
    }
  });

  ws.on('close', () => {
    if (masters.has(ws)) {
      masters.delete(ws);
      return;
    }
    if (participants.has(ws)) {
      const hadName = participants.get(ws).name;
      // Note: We keep the session data even when WebSocket closes
      participants.delete(ws);
      if (hadName) broadcastParticipantsUpdate();
    }
  });
});

// API endpoint to restore session
app.get('/api/session/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  if (sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    res.json({ 
      name: session.name, 
      email: session.email, 
      target: session.target 
    });
  } else {
    res.status(404).json({ error: 'Session nicht gefunden' });
  }
});

server.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
  console.log('Optional: Einschränkungen aus \'constraints.txt\' werden berücksichtigt.');
  console.log('Format je Zeile: GEBER, EMPFÄNGER   (z. B. "Alice, Bob"). \'#\' = Kommentar.');
  if (!emailTransporter) {
    console.log('\n⚠️  E-Mail-Versand deaktiviert. Setze SMTP_USER und SMTP_PASS Umgebungsvariablen.');
  } else {
    console.log('✓ E-Mail-Versand aktiviert.');
  }
});


