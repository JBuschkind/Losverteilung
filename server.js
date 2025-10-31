const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = 8080;

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * Connection state
 * - participants: Map<ws, { name: string|null }>
 * - masters: Set<ws>
 */
const participants = new Map();
const masters = new Set();

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
  names.sort((a, b) => a.localeCompare(b, 'de'));
  return names;
}

function isNameTaken(name) {
  for (const { name: n } of participants.values()) {
    if (n && n.toLowerCase() === name.toLowerCase()) return true;
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

function createDerangement(names) {
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
  broadcastToMasters({ type: 'participants', participants: getParticipantNames() });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const role = url.searchParams.get('role') || 'participant';

  if (role === 'master') {
    masters.add(ws);
    send(ws, { type: 'participants', participants: getParticipantNames() });
  } else {
    participants.set(ws, { name: null });
  }

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    if (data.type === 'set_name' && typeof data.name === 'string') {
      const trimmed = data.name.trim();
      if (!trimmed) {
        send(ws, { type: 'error', message: 'Name darf nicht leer sein.' });
        return;
      }
      if (trimmed.length > 40) {
        send(ws, { type: 'error', message: 'Name ist zu lang (max. 40).' });
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
      participants.get(ws).name = trimmed;
      send(ws, { type: 'name_ok', name: trimmed });
      broadcastParticipantsUpdate();
    }

    if (role === 'master' && data.type === 'remove_name' && typeof data.name === 'string') {
      const target = data.name.trim();
      for (const [sock, info] of participants.entries()) {
        if (info.name && info.name.toLowerCase() === target.toLowerCase()) {
          info.name = null;
          send(sock, { type: 'reset' });
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
      const mapping = createDerangement(names);
      if (!mapping) {
        send(ws, { type: 'error', message: 'Konnte keine gültige Verteilung finden. Bitte erneut versuchen.' });
        return;
      }
      // Send each participant their target
      for (const [sock, info] of participants.entries()) {
        if (info.name && mapping.has(info.name)) {
          send(sock, { type: 'your_target', target: mapping.get(info.name) });
        }
      }
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
      participants.delete(ws);
      if (hadName) broadcastParticipantsUpdate();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});


