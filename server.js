require("dotenv").config();
const WebSocket = require("ws");
const express = require("express");
const cors = require("cors");
const webpush = require("web-push");

const PORT = process.env.PORT || 3000;

const app = express();

app.use(cors());
app.use(express.json());

const server = new WebSocket.Server({
  noServer: true
});

const clients = new Map();
const pushSubscriptions = new Map();

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

console.log(`Laper server starting on port ${PORT}`);

/* ---------------- PUSH NOTIFICATIONS ---------------- */

app.get("/", (req, res) => {
  res.send("Laper server is running");
});

app.get("/vapidPublicKey", (req, res) => {
  res.json({
    publicKey: process.env.VAPID_PUBLIC_KEY
  });
});

app.post("/subscribe", (req, res) => {
  try {
    const { subscription } = req.body;

    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({
        error: "Invalid push subscription"
      });
    }

    const id = subscription.endpoint;

    pushSubscriptions.set(id, subscription);

    console.log("Push subscription saved.");

    res.status(201).json({
      success: true
    });
  } catch (error) {
    console.error("Subscribe error:", error);
    res.status(500).json({
      error: "Could not save subscription"
    });
  }
});

/* Test notification endpoint */
app.post("/send-test-notification", async (req, res) => {
  const payload = JSON.stringify({
    title: "Laper 🔔",
    body: "Your Laper notifications are working!",
    url: "/"
  });

  let sent = 0;

  for (const [id, subscription] of pushSubscriptions) {
    try {
      await webpush.sendNotification(subscription, payload);
      sent++;
    } catch (error) {
      console.error("Push error:", error.statusCode, error.message);

      if (error.statusCode === 404 || error.statusCode === 410) {
        pushSubscriptions.delete(id);
      }
    }
  }

  res.json({
    success: true,
    sent
  });
});

/* ---------------- VIDEO CALL WEBSOCKET ---------------- */

server.on("connection", (ws) => {
  let userId = null;

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());

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

/* ---------------- HTTP + WEBSOCKET SERVER ---------------- */

const httpServer = app.listen(PORT, () => {
  console.log(`Laper HTTP server running on port ${PORT}`);
});

httpServer.on("upgrade", (request, socket, head) => {
  server.handleUpgrade(request, socket, head, (ws) => {
    server.emit("connection", ws, request);
  });
});