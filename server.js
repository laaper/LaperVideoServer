require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");
const webpush = require("web-push");

const PORT = process.env.PORT || 3000;

const app = express();

app.use(cors());
app.use(express.json({ limit: "100kb" }));

const httpServer = http.createServer(app);

const wss = new WebSocket.Server({
  server: httpServer
});

/*
=========================================================
LAPER STORAGE
=========================================================
*/

const clients = new Map();

/*
  userId -> Set<WebSocket>

  A user can have more than one Laper device/browser
  connected at the same time.
*/

const pushSubscriptions = new Map();

/*
  userId -> subscription
*/

/*
=========================================================
WEB PUSH
=========================================================
*/

if (
  !process.env.VAPID_SUBJECT ||
  !process.env.VAPID_PUBLIC_KEY ||
  !process.env.VAPID_PRIVATE_KEY
) {
  console.error(
    "ERROR: Missing VAPID environment variables."
  );
} else {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

/*
=========================================================
BASIC HTTP
=========================================================
*/

app.get("/", (req, res) => {
  res.status(200).send(
    "Laper signaling and Web Push server is running."
  );
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    server: "laper-video-server",
    websocket: true,
    push: !!(
      process.env.VAPID_PUBLIC_KEY &&
      process.env.VAPID_PRIVATE_KEY
    ),
    time: new Date().toISOString()
  });
});

app.get("/vapidPublicKey", (req, res) => {

  if (!process.env.VAPID_PUBLIC_KEY) {
    return res.status(500).json({
      success: false,
      error: "VAPID public key is not configured."
    });
  }

  res.json({
    success: true,
    publicKey: process.env.VAPID_PUBLIC_KEY
  });
});

/*
=========================================================
SAVE PUSH SUBSCRIPTION
=========================================================
*/

app.post("/subscribe", (req, res) => {

  try {

    const {
      userId,
      subscription
    } = req.body || {};

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "userId is required."
      });
    }

    if (
      !subscription ||
      !subscription.endpoint
    ) {
      return res.status(400).json({
        success: false,
        error: "Valid Push subscription is required."
      });
    }

    const id = String(userId);

    pushSubscriptions.set(
      id,
      subscription
    );

    console.log(
      "Push subscription saved for:",
      id
    );

    res.status(201).json({
      success: true
    });

  } catch (error) {

    console.error(
      "Subscribe error:",
      error
    );

    res.status(500).json({
      success: false,
      error: "Could not save subscription."
    });

  }

});

/*
=========================================================
REMOVE PUSH SUBSCRIPTION
=========================================================
*/

app.post("/unsubscribe", (req, res) => {

  try {

    const {
      userId
    } = req.body || {};

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "userId is required."
      });
    }

    pushSubscriptions.delete(
      String(userId)
    );

    res.json({
      success: true
    });

  } catch (error) {

    console.error(
      "Unsubscribe error:",
      error
    );

    res.status(500).json({
      success: false
    });

  }

});

/*
=========================================================
SEND WEB PUSH
=========================================================
*/

async function sendPush(
  userId,
  payload
) {

  const id = String(userId);

  const subscription =
    pushSubscriptions.get(id);

  if (!subscription) {

    console.log(
      "No Push subscription for:",
      id
    );

    return false;
  }

  try {

    await webpush.sendNotification(
      subscription,
      JSON.stringify(payload),
      {
        TTL: 60
      }
    );

    console.log(
      "Push sent to:",
      id
    );

    return true;

  } catch (error) {

    console.error(
      "Push error for",
      id,
      ":",
      error.statusCode,
      error.message
    );

    /*
      404/410 normally means the subscription
      is no longer valid.
    */

    if (
      error.statusCode === 404 ||
      error.statusCode === 410
    ) {

      pushSubscriptions.delete(id);

      console.log(
        "Removed expired Push subscription:",
        id
      );

    }

    return false;
  }

}

/*
=========================================================
INCOMING CALL PUSH
=========================================================
*/

async function sendIncomingCallPush(
  targetUserId,
  message
) {

  return sendPush(
    targetUserId,
    {
      type: "incoming-call",

      title:
        (
          message.callerName ||
          "Laper User"
        ) +
        " is calling",

      body:
        "Incoming Laper video call",

      icon:
        message.icon ||
        "/icon-192.png",

      badge:
        message.badge ||
        "/icon-192.png",

      callerId:
        String(
          message.callerId || ""
        ),

      callerName:
        message.callerName ||
        "Laper User",

      callerPhoto:
        message.callerPhoto ||
        "",

      callId:
        String(
          message.callId || ""
        ),

      roomId:
        String(
          message.callId || ""
        )
    }
  );

}

/*
=========================================================
SEND TO ALL CONNECTED DEVICES
=========================================================
*/

function sendToUser(
  userId,
  message
) {

  const id =
    String(userId);

  const sockets =
    clients.get(id);

  if (!sockets) {
    return 0;
  }

  let sent = 0;

  for (
    const socket
    of sockets
  ) {

    if (
      socket.readyState ===
      WebSocket.OPEN
    ) {

      try {

        socket.send(
          JSON.stringify(message)
        );

        sent++;

      } catch (error) {

        console.error(
          "Socket send error:",
          error.message
        );

      }

    }

  }

  return sent;

}

/*
=========================================================
ADD SOCKET
=========================================================
*/

function addClient(
  userId,
  ws
) {

  const id =
    String(userId);

  if (!clients.has(id)) {
    clients.set(
      id,
      new Set()
    );
  }

  clients
    .get(id)
    .add(ws);

}

/*
=========================================================
REMOVE SOCKET
=========================================================
*/

function removeClient(
  userId,
  ws
) {

  if (!userId) {
    return;
  }

  const id =
    String(userId);

  const sockets =
    clients.get(id);

  if (!sockets) {
    return;
  }

  sockets.delete(ws);

  if (sockets.size === 0) {
    clients.delete(id);
  }

}

/*
=========================================================
WEBSOCKET CONNECTION
=========================================================
*/

wss.on(
  "connection",
  ws => {

    let userId = null;

    console.log(
      "WebSocket connected."
    );

    ws.on(
      "message",
      async raw => {

        let message;

        try {

          message =
            JSON.parse(
              raw.toString()
            );

        } catch (error) {

          console.error(
            "Invalid JSON received."
          );

          return;

        }

        /*
        -------------------------------------------------
        REGISTER
        -------------------------------------------------
        */

        if (
          message.type ===
          "register"
        ) {

          if (!message.userId) {

            ws.send(
              JSON.stringify({
                type: "error",
                message:
                  "userId is required."
              })
            );

            return;
          }

          userId =
            String(
              message.userId
            );

          addClient(
            userId,
            ws
          );

          ws.send(
            JSON.stringify({
              type: "registered",
              userId
            })
          );

          console.log(
            "User connected:",
            userId
          );

          return;
        }

        /*
        -------------------------------------------------
        EVERYTHING BELOW REQUIRES REGISTRATION
        -------------------------------------------------
        */

        if (!userId) {

          ws.send(
            JSON.stringify({
              type: "error",
              message:
                "Register the WebSocket first."
            })
          );

          return;
        }

        /*
        -------------------------------------------------
        TARGET
        -------------------------------------------------
        */

        const targetId =
          message.to
            ? String(message.to)
            : null;

        /*
        -------------------------------------------------
        INCOMING CALL
        -------------------------------------------------
        */

        if (
          message.type ===
          "call"
        ) {

          if (!targetId) {
            return;
          }

          /*
            Send Push regardless of whether
            the receiver currently has Laper open.
          */

          await sendIncomingCallPush(
            targetId,
            {
              callerId:
                userId,

              callerName:
                message.callerName ||
                "Laper User",

              callerPhoto:
                message.callerPhoto ||
                "",

              callId:
                message.callId ||
                ""
            }
          );

          /*
            If receiver is currently online,
            also send the live call signal.
          */

          sendToUser(
            targetId,
            {
              ...message,
              from: userId
            }
          );

          return;
        }

        /*
        -------------------------------------------------
        WEBRTC OFFER
        -------------------------------------------------
        */

        if (
          message.type ===
          "offer"
        ) {

          if (!targetId) {
            return;
          }

          sendToUser(
            targetId,
            {
              ...message,
              from: userId
            }
          );

          return;
        }

        /*
        -------------------------------------------------
        WEBRTC ANSWER
        -------------------------------------------------
        */

        if (
          message.type ===
          "answer"
        ) {

          if (!targetId) {
            return;
          }

          sendToUser(
            targetId,
            {
              ...message,
              from: userId
            }
          );

          return;
        }

        /*
        -------------------------------------------------
        ICE CANDIDATE
        -------------------------------------------------
        */

        if (
          message.type ===
          "ice"
        ) {

          if (!targetId) {
            return;
          }

          sendToUser(
            targetId,
            {
              ...message,
              from: userId
            }
          );

          return;
        }

        /*
        -------------------------------------------------
        CALL ACCEPT
        -------------------------------------------------
        */

        if (
          message.type ===
          "accept"
        ) {

          if (!targetId) {
            return;
          }

          sendToUser(
            targetId,
            {
              ...message,
              from: userId
            }
          );

          return;
        }

        /*
        -------------------------------------------------
        CALL DECLINE
        -------------------------------------------------
        */

        if (
          message.type ===
          "decline"
        ) {

          if (!targetId) {
            return;
          }

          sendToUser(
            targetId,
            {
              ...message,
              from: userId
            }
          );

          return;
        }

        /*
        -------------------------------------------------
        CALL END
        -------------------------------------------------
        */

        if (
          message.type ===
          "end"
        ) {

          if (!targetId) {
            return;
          }

          sendToUser(
            targetId,
            {
              ...message,
              from: userId
            }
          );

          return;
        }

        /*
        -------------------------------------------------
        CALL CANCEL
        -------------------------------------------------
        */

        if (
          message.type ===
          "cancel"
        ) {

          if (!targetId) {
            return;
          }

          sendToUser(
            targetId,
            {
              ...message,
              from: userId
            }
          );

          return;
        }

      }
    );

    ws.on(
      "close",
      () => {

        removeClient(
          userId,
          ws
        );

        console.log(
          "WebSocket disconnected:",
          userId || "unknown"
        );

      }
    );

    ws.on(
      "error",
      error => {

        console.error(
          "WebSocket error:",
          error.message
        );

      }
    );

  }
);

/*
=========================================================
PUSH ACCEPT / DECLINE FROM SERVICE WORKER
=========================================================
*/

app.post(
  "/call-response",
  (req, res) => {

    try {

      const {
        action,
        callerId,
        callId,
        roomId
      } = req.body || {};

      if (!action || !callerId) {

        return res.status(400).json({
          success: false,
          error:
            "action and callerId are required."
        });

      }

      const type =
        action === "decline"
          ? "decline"
          : action === "accept"
            ? "accept"
            : action === "end"
              ? "end"
              : null;

      if (!type) {

        return res.status(400).json({
          success: false,
          error:
            "Invalid call action."
        });

      }

      const delivered =
        sendToUser(
          String(callerId),
          {
            type,
            callId:
              callId || roomId || "",
            roomId:
              roomId || callId || "",
            from:
              "push"
          }
        );

      console.log(
        "Call response:",
        type,
        "caller:",
        callerId,
        "delivered:",
        delivered
      );

      res.json({
        success: true,
        delivered
      });

    } catch (error) {

      console.error(
        "Call response error:",
        error
      );

      res.status(500).json({
        success: false
      });

    }

  }
);

/*
=========================================================
TEST PUSH
=========================================================

This is only a diagnostic endpoint.
It does NOT replace real call Push.
=========================================================
*/

app.post(
  "/send-test-notification",
  async (req, res) => {

    const {
      userId
    } = req.body || {};

    if (!userId) {

      return res.status(400).json({
        success: false,
        error:
          "userId is required."
      });

    }

    const sent =
      await sendPush(
        String(userId),
        {
          type: "general",

          title: "Laper",

          body:
            "Laper notifications are working.",

          icon:
            "/icon-192.png",

          badge:
            "/icon-192.png",

          url: "/"
        }
      );

    res.json({
      success: true,
      sent
    });

  }
);

/*
=========================================================
SERVER START
=========================================================
*/

httpServer.listen(
  PORT,
  () => {

    console.log(
      "Laper server running on port " +
      PORT
    );

    console.log(
      "HTTP:",
      "http://localhost:" +
      PORT
    );

    console.log(
      "WebSocket:",
      "ws://localhost:" +
      PORT
    );

  }
);