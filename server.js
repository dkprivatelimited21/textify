// server.js - WebSocket Server for Textify with Admin, Reports, Bans, Anti-bully and WebRTC signaling
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config(); // set ADMIN_KEY and PORT in .env

// Files
const BADWORDS_PATH = path.join(__dirname, 'badwords.json');
const REPORTS_PATH = path.join(__dirname, 'reports.json');
const BANS_PATH = path.join(__dirname, 'bans.json');

// Simple HTTP server (health / static could be served by your host)
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Server is running');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end('WebSocket server is running');
});

const wss = new WebSocket.Server({ server });

// --- Helpers: load/save files ---
function safeReadJSON(p, fallback) {
  try {
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    return JSON.parse(fs.readFileSync(p));
  } catch (e) {
    console.error('safeReadJSON error', p, e);
    return fallback;
  }
}
function safeWriteJSON(p, obj) {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); } catch (e) { console.error('safeWriteJSON error', p, e); }
}

// --- Bad words loader ---
function loadBadWordsSet() {
  const data = safeReadJSON(BADWORDS_PATH, { words: [] });
  return new Set(Array.isArray(data.words) ? data.words.map(w => String(w).toLowerCase()) : []);
}
let BAD_WORDS = loadBadWordsSet();
fs.watchFile(BADWORDS_PATH, () => { BAD_WORDS = loadBadWordsSet(); console.log('♻ badwords.json reloaded'); });
function containsBadWord(text) {
  if(!text) return false;
  const lower = String(text).toLowerCase();
  for (const w of BAD_WORDS) if (w && lower.includes(w)) return true;
  return false;
}

// --- Reports / Bans persistence ---
let reports = safeReadJSON(REPORTS_PATH, []); // array of report objects
let bans = safeReadJSON(BANS_PATH, { ips: [], userIds: [] });

function saveReports() { safeWriteJSON(REPORTS_PATH, reports); }
function saveBans() { safeWriteJSON(BANS_PATH, bans); }

// --- Matchmaking / connections ---
let waitingUser = null;
const activeConnections = new Map(); // userId -> { socket, partnerId }

// generate id
function generateId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}
function getOnlineCount() { return wss.clients.size; }

// forward signaling or custom messages to partner (attaches from)
function forwardToPartner(userId, message) {
  const conn = activeConnections.get(userId);
  if (!conn || !conn.partnerId) return;
  const partnerConn = activeConnections.get(conn.partnerId);
  if (partnerConn && partnerConn.socket && partnerConn.socket.readyState === WebSocket.OPEN) {
    // attach sender id for context
    const out = Object.assign({}, message, { from: userId });
    partnerConn.socket.send(JSON.stringify(out));
  }
}

// Connection handlers
wss.on('connection', (socket, req) => {
  const userId = generateId();
  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  console.log(`User connected: ${userId} from ${clientIp}`);

  socket.userId = userId;
  socket.ip = clientIp;

  // Immediately check bans
  if (bans.userIds.includes(userId) || bans.ips.includes(clientIp)) {
    socket.send(JSON.stringify({ type: 'banned', reason: 'You are banned.' }));
    socket.close();
    return;
  }

  // handshake
  socket.send(JSON.stringify({ type: 'connected', userId }));

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      switch (msg.type) {
        // Matchmaking
        case 'find_partner':
          findPartner(userId, socket);
          break;

        // Text message
        case 'send_message':
          if (!msg.text) return;
          if (containsBadWord(msg.text)) {
            socket.send(JSON.stringify({ type: 'warning', text: '⚠ Your message contained harmful language and was not sent.' }));
            // Auto-report to reports
            const rpt = { reporterId: userId, reportedId: activeConnections.get(userId)?.partnerId || null, reportedIp: activeConnections.get(userId)?.socket?.ip || null, reason: 'Auto moderation: toxic message', message: msg.text, time: new Date().toISOString() };
            reports.unshift(rpt); if (reports.length > 1000) reports.pop(); saveReports();
            return;
          }
          sendToPartner(userId, msg.text);
          break;

        // Typing
        case 'typing':
          notifyTyping(userId, msg.isTyping);
          break;

        // Disconnect
        case 'disconnect_chat':
          disconnectPair(userId);
          break;

        // Report user (from client)
        case 'report_user':
          {
            const entry = {
              reporterId: userId,
              reportedId: msg.reportedId || null,
              reportedIp: msg.reportedIp || null,
              reason: msg.reason || 'user_report',
              message: msg.message || null,
              time: new Date().toISOString()
            };
            reports.unshift(entry);
            if (reports.length > 5000) reports.pop();
            saveReports();
            socket.send(JSON.stringify({ type: 'report_ack' }));
            // optionally notify admin sockets (not implemented)
          }
          break;

        // Admin requests (protected)
        case 'get_user_count':
          if (msg.adminKey === process.env.ADMIN_KEY) {
            socket.send(JSON.stringify({ type: 'user_count', count: getOnlineCount() }));
          } else {
            console.warn(`Unauthorized get_user_count attempt by ${userId}`);
          }
          break;

        case 'get_reports':
          if (msg.adminKey === process.env.ADMIN_KEY) {
            socket.send(JSON.stringify({ type: 'reports', reports }));
          } else {
            console.warn(`Unauthorized get_reports attempt by ${userId}`);
          }
          break;

        case 'get_bans':
          if (msg.adminKey === process.env.ADMIN_KEY) {
            socket.send(JSON.stringify({ type: 'bans', bannedIPs: bans.ips, bannedUserIds: bans.userIds }));
          } else {
            console.warn(`Unauthorized get_bans attempt by ${userId}`);
          }
          break;

        case 'ban_user':
          if (msg.adminKey === process.env.ADMIN_KEY) {
            const uid = msg.userId || null;
            const ip = msg.ip || null;
            if (uid && !bans.userIds.includes(uid)) bans.userIds.push(uid);
            if (ip && !bans.ips.includes(ip)) bans.ips.push(ip);
            saveBans();
            socket.send(JSON.stringify({ type: 'ban_ack' }));
            // kill connection if present
            if (uid && activeConnections.has(uid)) {
              const c = activeConnections.get(uid).socket;
              try { c.send(JSON.stringify({ type: 'banned', reason: 'You were banned by admin.' })); c.close(); } catch(e){}
            }
            // also drop any matching IP
            wss.clients.forEach(s => { if ((s.ip === ip) && s.readyState === WebSocket.OPEN) { try { s.send(JSON.stringify({ type: 'banned', reason: 'Your IP was banned.' })); s.close(); } catch(e){} } });
          } else {
            console.warn(`Unauthorized ban_user attempt by ${userId}`);
          }
          break;

        case 'unban_user':
          if (msg.adminKey === process.env.ADMIN_KEY) {
            const uid = msg.userId || null;
            const ip = msg.ip || null;
            if (uid) bans.userIds = bans.userIds.filter(x => x !== uid);
            if (ip) bans.ips = bans.ips.filter(x => x !== ip);
            saveBans();
            socket.send(JSON.stringify({ type: 'unban_ack' }));
          } else {
            console.warn(`Unauthorized unban_user attempt by ${userId}`);
          }
          break;

        // WebRTC signaling: forward to partner
        case 'video_offer':
        case 'video_answer':
        case 'ice_candidate':
          // forward raw message, helper attaches `from` field
          forwardToPartner(userId, msg);
          break;

        default:
          console.warn('Unknown message type:', msg.type);
      }
    } catch (err) {
      console.error('Error parsing ws message', err);
    }
  });

  socket.on('close', () => {
    console.log('User disconnected:', userId);
    handleDisconnection(userId);
  });

  socket.on('error', (err) => {
    console.error('Socket error for', userId, err);
    handleDisconnection(userId);
  });

  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
});

// matchmaking functions
function findPartner(userId, socket) {
  // If user is already paired, ignore
  if (activeConnections.has(userId)) return;

  if (waitingUser && waitingUser.id !== userId) {
    const partnerId = waitingUser.id;
    const partnerSocket = waitingUser.socket;

    if (partnerSocket.readyState !== WebSocket.OPEN) {
      waitingUser = { id: userId, socket };
      socket.send(JSON.stringify({ type: 'searching' }));
      return;
    }

    activeConnections.set(userId, { socket, partnerId });
    activeConnections.set(partnerId, { socket: partnerSocket, partnerId: userId });

    socket.send(JSON.stringify({ type: 'partner_found', partnerId }));
    partnerSocket.send(JSON.stringify({ type: 'partner_found', partnerId: userId }));

    console.log(`Paired: ${userId} <-> ${partnerId}`);
    waitingUser = null;
  } else {
    waitingUser = { id: userId, socket };
    socket.send(JSON.stringify({ type: 'searching' }));
    console.log(`User ${userId} is waiting`);
  }
}

function sendToPartner(userId, text) {
  const conn = activeConnections.get(userId);
  if (!conn || !conn.partnerId) return;
  const partnerConn = activeConnections.get(conn.partnerId);
  if (partnerConn && partnerConn.socket && partnerConn.socket.readyState === WebSocket.OPEN) {
    partnerConn.socket.send(JSON.stringify({ type: 'message', text }));
  }
}

function notifyTyping(userId, isTyping) {
  const conn = activeConnections.get(userId);
  if (!conn || !conn.partnerId) return;
  const partnerConn = activeConnections.get(conn.partnerId);
  if (partnerConn && partnerConn.socket && partnerConn.socket.readyState === WebSocket.OPEN) {
    partnerConn.socket.send(JSON.stringify({ type: 'typing', isTyping }));
  }
}

function disconnectPair(userId) {
  const conn = activeConnections.get(userId);
  if (conn && conn.partnerId) {
    const partnerConn = activeConnections.get(conn.partnerId);
    if (partnerConn && partnerConn.socket && partnerConn.socket.readyState === WebSocket.OPEN) {
      partnerConn.socket.send(JSON.stringify({ type: 'partner_disconnected' }));
      activeConnections.delete(conn.partnerId);
    }
    activeConnections.delete(userId);
    console.log(`Disconnected pair: ${userId} <-> ${conn.partnerId}`);
  } else {
    // if waiting user, remove
    if (waitingUser && waitingUser.id === userId) waitingUser = null;
  }
}

function handleDisconnection(userId) {
  if (waitingUser && waitingUser.id === userId) waitingUser = null;
  disconnectPair(userId);
}

// heartbeat
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((s) => {
    if (s.isAlive === false) return s.terminate();
    s.isAlive = false;
    s.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
