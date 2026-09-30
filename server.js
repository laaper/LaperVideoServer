const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const server = new WebSocket.Server({
  port: PORT
});

const clients = new Map();

console.log(`Laper signaling server running on port ${PORT}`);

server.on("connection", (ws) => {
  let userId = null;

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());

      // Register this user
      if (message.type === "register") {
        userId = String(message.userId);
        clients.set(userId, ws);

        ws.send(JSON.stringify({
          type: "registered",
          userId
        }));

        console.log(`User connected: ${userId}`);
        return;
      }

      // Forward signaling messages to another user
      if (message.to) {
        const target = clients.get(String(message.to));

        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({
            ...message,
            from: userId
          }));
        }
      }
    } catch (error) {
      console.error("Invalid message:", error.message);
    }
  });

  ws.on("close", () => {
    if (userId && clients.get(userId) === ws) {
      clients.delete(userId);
      console.log(`User disconnected: ${userId}`);
    }
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error.message);
  });
});