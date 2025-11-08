// server.js - WebSocket Server for Textify with Admin + Anti-Bullying System
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config(); // Load ADMIN_KEY from .env

// ===============================
// 1️⃣ BASIC HTTP + WEBSOCKET SERVER
// ===============================
const server = http.createServer((req, res) => {
  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Server is running');
    return;
  }

  // CORS headers
  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Access-Control-Allow-Origin': '*'
  });
  res.end('WebSocket server is running');
});

const wss = new WebSocket.Server({ server });

// ===============================
// 2️⃣ BAD WORDS AUTO-LOADER
// ===============================
const BADWORDS_PATH = path.join(__dirname, 'badwords.json');

function loadBadWords() {
  try {
    if (!fs.existsSync(BADWORDS_PATH)) {
      fs.writeFileSync(BADWORDS_PATH, JSON.stringify({ words: [] }, null, 2));
      console.log("⚠️ Created empty badwords.json");
    }
    const file = JSON.parse(fs.readFileSync(BADWORDS_PATH));
    return new Set(file.words.map(w => w.toLowerCase()));
  } catch (err) {
    console.error("❌ Failed to load badwords.json", err);
    return new Set();
  }
}

let BAD_WORDS = loadBadWords();

// 🔁 Auto reload when file changes
fs.watchFile(BADWORDS_PATH, () => {
  console.log("♻ Reloading badwords.json...");
  BAD_WORDS = loadBadWords();
});

function containsBadWord(text) {
  const lower = text.toLowerCase();
  for (const word of BAD_WORDS) {
    if (lower.includes(word)) return true;
  }
  return false;
}

// ===============================
// 3️⃣ USER HANDLING LOGIC
// ===============================
let waitingUser = null;
const activeConnections = new Map(); // userId -> { socket, partnerId }

function generateId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

function getOnlineCount() {
  return wss.clients.size;
}

// ===============================
// 4️⃣ CORE CONNECTION LOGIC
// ===============================
wss.on('connection', (socket, req) => {
  const userId = generateId();
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`✅ User connected: ${userId} from ${clientIp}`);

  // Attach meta info
  socket.userId = userId;
  socket.ip = clientIp;

  // Send handshake info
  socket.send(JSON.stringify({ type: 'connected', userId }));

  socket.on('message', (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        // 🔹 Matchmaking
        case 'find_partner':
          findPartner(userId, socket);
          break;

        // 🔹 Message sending + moderation
        case 'send_message':
          if (!message.text) return;

          // 🧠 Anti-bullying check
          if (containsBadWord(message.text)) {
            console.log(`🚨 Blocked abusive message from ${userId}: "${message.text}"`);
            
            // Warn sender
            socket.send(JSON.stringify({
              type: 'warning',
              text: "⚠ Your message contained harmful language and was not sent."
            }));

            // Optional: auto report (can integrate with reports.json)
            // saveReport({
            //   reporterId: userId,
            //   reportedId: activeConnections.get(userId)?.partnerId || null,
            //   reason: "Auto moderation: toxic message",
            //   message: message.text,
            //   time: new Date().toISOString()
            // });

            return; // Stop message from being sent
          }

          sendToPartner(userId, message.text);
          break;

        // 🔹 Disconnect
        case 'disconnect_chat':
          disconnectPair(userId);
          break;

        // 🔹 Typing status
        case 'typing':
          notifyTyping(userId, message.isTyping);
          break;

        // 🔹 Admin user count
        case 'get_user_count':
          if (message.adminKey === process.env.ADMIN_KEY) {
            socket.send(JSON.stringify({
              type: 'user_count',
              count: getOnlineCount()
            }));
            console.log(`👑 Admin requested user count: ${getOnlineCount()}`);
          } else {
            console.warn(`🚫 Unauthorized admin count request from ${userId}`);
          }
          break;
      }
    } catch (err) {
      console.error('❌ Error processing message:', err);
    }
  });

  socket.on('close', () => {
    console.log(`❎ User disconnected: ${userId}`);
    handleDisconnection(userId);
  });

  socket.on('error', (err) => {
    console.error('⚠️ Socket error:', err);
    handleDisconnection(userId);
  });

  // Keepalive heartbeat
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
});

// ===============================
// 5️⃣ MATCHMAKING / CHAT LOGIC
// ===============================
function findPartner(userId, socket) {
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

    console.log(`🔗 Paired: ${userId} ↔ ${partnerId}`);
    waitingUser = null;
  } else {
    waitingUser = { id: userId, socket };
    socket.send(JSON.stringify({ type: 'searching' }));
    console.log(`🕒 User ${userId} is waiting for a partner`);
  }
}

function sendToPartner(userId, text) {
  const connection = activeConnections.get(userId);
  if (!connection || !connection.partnerId) return;

  const partnerConnection = activeConnections.get(connection.partnerId);
  if (partnerConnection?.socket?.readyState === WebSocket.OPEN) {
    partnerConnection.socket.send(JSON.stringify({ type: 'message', text }));
  }
}

function notifyTyping(userId, isTyping) {
  const connection = activeConnections.get(userId);
  if (!connection?.partnerId) return;

  const partnerConnection = activeConnections.get(connection.partnerId);
  if (partnerConnection?.socket?.readyState === WebSocket.OPEN) {
    partnerConnection.socket.send(JSON.stringify({ type: 'typing', isTyping }));
  }
}

function disconnectPair(userId) {
  const connection = activeConnections.get(userId);
  if (connection?.partnerId) {
    const partnerConnection = activeConnections.get(connection.partnerId);
    if (partnerConnection?.socket?.readyState === WebSocket.OPEN) {
      partnerConnection.socket.send(JSON.stringify({ type: 'partner_disconnected' }));
      activeConnections.delete(connection.partnerId);
    }
    activeConnections.delete(userId);
    console.log(`🧹 Disconnected pair: ${userId} ↔ ${connection.partnerId}`);
  }
}

function handleDisconnection(userId) {
  if (waitingUser && waitingUser.id === userId) waitingUser = null;
  disconnectPair(userId);
}

// ===============================
// 6️⃣ HEARTBEAT (PREVENT STALE SOCKETS)
// ===============================
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket.isAlive === false) return socket.terminate();
    socket.isAlive = false;
    socket.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

// ===============================
// 7️⃣ SERVER START
// ===============================
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ WebSocket server running on port ${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
});
