// server.js - WebSocket Server for Textify with Admin User Count Feature
const WebSocket = require('ws');
const http = require('http');
require('dotenv').config(); // Load ADMIN_KEY from .env

const server = http.createServer((req, res) => {
  // Basic health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Server is running');
    return;
  }

  // CORS headers for production
  res.writeHead(200, {
    'Content-Type': 'text/plain',
    'Access-Control-Allow-Origin': '*'
  });
  res.end('WebSocket server is running');
});

const wss = new WebSocket.Server({ server });

// Store waiting users and active connections
let waitingUser = null;
const activeConnections = new Map(); // userId -> { socket, partnerId }

function generateId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

function getOnlineCount() {
  return wss.clients.size;
}

wss.on('connection', (socket, req) => {
  const userId = generateId();
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`User connected: ${userId} from ${clientIp}`);

  // Send welcome message
  socket.send(JSON.stringify({ type: 'connected', userId }));

  socket.on('message', (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case 'find_partner':
          findPartner(userId, socket);
          break;

        case 'send_message':
          sendToPartner(userId, message.text);
          break;

        case 'disconnect_chat':
          disconnectPair(userId);
          break;

        case 'typing':
          notifyTyping(userId, message.isTyping);
          break;

        // ✅ Admin-only: get live user count securely
        case 'get_user_count':
          if (message.adminKey === process.env.ADMIN_KEY) {
            socket.send(JSON.stringify({
              type: 'user_count',
              count: getOnlineCount()
            }));
            console.log(`Admin requested user count: ${getOnlineCount()}`);
          } else {
            console.warn(`Unauthorized admin count request from ${userId}`);
          }
          break;
      }
    } catch (err) {
      console.error('Error processing message:', err);
    }
  });

  socket.on('close', () => {
    console.log(`User disconnected: ${userId}`);
    handleDisconnection(userId);
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
    handleDisconnection(userId);
  });

  // Heartbeat to keep connection alive
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });
});

// Heartbeat interval to detect broken connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket.isAlive === false) {
      return socket.terminate();
    }
    socket.isAlive = false;
    socket.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

function findPartner(userId, socket) {
  if (waitingUser && waitingUser.id !== userId) {
    const partnerId = waitingUser.id;
    const partnerSocket = waitingUser.socket;

    // If waiting user disconnected
    if (partnerSocket.readyState !== WebSocket.OPEN) {
      waitingUser = { id: userId, socket };
      socket.send(JSON.stringify({ type: 'searching' }));
      return;
    }

    activeConnections.set(userId, { socket, partnerId });
    activeConnections.set(partnerId, { socket: partnerSocket, partnerId: userId });

    socket.send(JSON.stringify({ type: 'partner_found' }));
    partnerSocket.send(JSON.stringify({ type: 'partner_found' }));

    console.log(`Paired: ${userId} <-> ${partnerId}`);
    waitingUser = null;
  } else {
    waitingUser = { id: userId, socket };
    socket.send(JSON.stringify({ type: 'searching' }));
    console.log(`User ${userId} is waiting for a partner`);
  }
}

function sendToPartner(userId, text) {
  const connection = activeConnections.get(userId);
  if (connection && connection.partnerId) {
    const partnerConnection = activeConnections.get(connection.partnerId);
    if (partnerConnection && partnerConnection.socket.readyState === WebSocket.OPEN) {
      partnerConnection.socket.send(JSON.stringify({ type: 'message', text }));
    }
  }
}

function notifyTyping(userId, isTyping) {
  const connection = activeConnections.get(userId);
  if (connection && connection.partnerId) {
    const partnerConnection = activeConnections.get(connection.partnerId);
    if (partnerConnection && partnerConnection.socket.readyState === WebSocket.OPEN) {
      partnerConnection.socket.send(JSON.stringify({ type: 'typing', isTyping }));
    }
  }
}

function disconnectPair(userId) {
  const connection = activeConnections.get(userId);
  if (connection && connection.partnerId) {
    const partnerConnection = activeConnections.get(connection.partnerId);

    if (partnerConnection && partnerConnection.socket.readyState === WebSocket.OPEN) {
      partnerConnection.socket.send(JSON.stringify({ type: 'partner_disconnected' }));
      activeConnections.delete(connection.partnerId);
    }

    activeConnections.delete(userId);
    console.log(`Disconnected pair: ${userId} <-> ${connection.partnerId}`);
  }
}

function handleDisconnection(userId) {
  if (waitingUser && waitingUser.id === userId) {
    waitingUser = null;
  }
  disconnectPair(userId);
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ WebSocket server is running on port ${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
});
