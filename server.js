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
// ============================================================
// LAPER REELS + FIRESTORE RECOMMENDATION TREE
// ============================================================

const LAPER_REEL_TOPICS = [
  "gaming",
  "sports",
  "technology",
  "science",
  "art",
  "food",
  "travel",
  "animals",
  "music",
  "education",
  "entertainment",
  "cars",
  "space",
  "nature",
  "movies",
  "animation",
  "DIY",
  "history",
  "fitness",
  "funny"
];

function shuffleLaper(array) {
  const result = [...array];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [result[i], result[j]] =
      [result[j], result[i]];
  }

  return result;
}


// ============================================================
// GET PERSONALIZED REELS
// ============================================================

app.get("/laper/reels", async (req, res) => {

  try {

    const apiKey =
      process.env.YOUTUBE_API_KEY;

    if (!apiKey) {

      return res.status(500).json({
        ok: false,
        error: "YOUTUBE_API_KEY is not configured",
        reels: []
      });

    }

    /*
      The frontend sends the user's Firebase UID.

      We only use it to ask Firestore for the user's
      recommendation data.
    */

    const userId =
      String(req.query.userId || "");

    let topicScores = {};

    /*
      Firestore is optional here.

      If your server already has Firebase Admin initialized,
      this will use it.

      If it isn't available, the feed still works normally.
    */

    if (
      userId &&
      typeof db !== "undefined" &&
      db &&
      typeof db.collection === "function"
    ) {

      try {

        const treeDoc =
          await db
            .collection("recommendationTrees")
            .doc(userId)
            .get();

        if (treeDoc.exists) {

          const tree =
            treeDoc.data() || {};

          topicScores =
            tree.topics || {};

        }

      } catch (firestoreError) {

        console.warn(
          "Laper recommendation tree read failed:",
          firestoreError.message
        );

      }

    }


    // ========================================================
    // PICK 3 PERSONALIZED + 3 DISCOVERY TOPICS
    // ========================================================

    const ranked =
      LAPER_REEL_TOPICS
        .map(topic => ({
          topic,
          score:
            Number(
              topicScores[topic]
            ) || 1
        }))
        .sort(
          (a, b) =>
            b.score - a.score
        );

    const personalized =
      ranked
        .slice(0, 3)
        .map(item => item.topic);

    const discovery =
      shuffleLaper(
        LAPER_REEL_TOPICS.filter(
          topic =>
            !personalized.includes(topic)
        )
      ).slice(0, 3);

    const topics =
      shuffleLaper([
        ...personalized,
        ...discovery
      ]);


    // ========================================================
    // ONE YOUTUBE SEARCH
    // ========================================================

    const youtubeURL =
      new URL(
        "https://www.googleapis.com/youtube/v3/search"
      );

    youtubeURL.searchParams.set(
      "part",
      "snippet"
    );

    /*
      "|" means OR in YouTube search.
    */
    youtubeURL.searchParams.set(
      "q",
      topics.join("|")
    );

    youtubeURL.searchParams.set(
      "type",
      "video"
    );

    youtubeURL.searchParams.set(
      "videoDuration",
      "short"
    );

    youtubeURL.searchParams.set(
      "videoEmbeddable",
      "true"
    );

    youtubeURL.searchParams.set(
      "maxResults",
      "25"
    );

    youtubeURL.searchParams.set(
      "order",
      "relevance"
    );

    youtubeURL.searchParams.set(
      "key",
      apiKey
    );


    const response =
      await fetch(
        youtubeURL.toString()
      );

    const rawText =
      await response.text();


    if (!response.ok) {

      console.error(
        "YouTube API error:",
        response.status,
        rawText
      );

      return res.status(
        response.status
      ).json({

        ok: false,

        error:
          "YouTube search failed",

        youtubeStatus:
          response.status,

        youtubeResponse:
          rawText,

        reels: []

      });

    }


    const data =
      JSON.parse(rawText);


    // ========================================================
    // BUILD REELS
    // ========================================================

    let reels =
      (data.items || [])
        .filter(
          item =>
            item &&
            item.id &&
            item.id.videoId
        )
        .map(item => {

          const videoId =
            item.id.videoId;

          const topic =
            topics[
              Math.floor(
                Math.random() *
                topics.length
              )
            ];

          return {

            id:
              videoId,

            title:
              item.snippet?.title ||
              "Laper Reel",

            channel:
              item.snippet?.channelTitle ||
              "Creator",

            description:
              item.snippet?.description ||
              "",

            thumbnail:
              item.snippet?.thumbnails?.high?.url ||
              item.snippet?.thumbnails?.medium?.url ||
              item.snippet?.thumbnails?.default?.url ||
              "",

            embedUrl:
              "https://www.youtube.com/embed/" +
              encodeURIComponent(videoId) +
              "?playsinline=1" +
              "&enablejsapi=1" +
              "&rel=0" +
              "&modestbranding=1",

            source:
              "youtube",

            topic

          };

        });


    // ========================================================
    // REMOVE DUPLICATES
    // ========================================================

    const seen =
      new Set();

    reels =
      reels.filter(reel => {

        if (
          seen.has(reel.id)
        ) {
          return false;
        }

        seen.add(reel.id);

        return true;

      });


    reels =
      shuffleLaper(reels);


    return res.json({

      ok: true,

      topics,

      count:
        reels.length,

      reels

    });


  } catch (error) {

    console.error(
      "Laper Reels error:",
      error
    );

    return res.status(500).json({

      ok: false,

      error:
        error.message ||
        "Internal server error",

      reels: []

    });

  }

});


// ============================================================
// RECOMMENDATION EVENT
// ============================================================

app.post(
  "/laper/recommendation-event",
  express.json(),
  async (req, res) => {

    try {

      const {
        userId,
        topic,
        action,
        videoId
      } = req.body || {};


      if (!userId || !topic) {

        return res.status(400).json({
          ok: false,
          error:
            "userId and topic are required"
        });

      }


      if (
        typeof db === "undefined" ||
        !db ||
        typeof db.collection !== "function"
      ) {

        return res.status(500).json({
          ok: false,
          error:
            "Firestore is not available on the server"
        });

      }


      const ref =
        db
          .collection(
            "recommendationTrees"
          )
          .doc(String(userId));


      const snap =
        await ref.get();


      let tree =
        snap.exists
          ? snap.data()
          : {
              version: 1,
              topics: {},
              recent: []
            };


      if (!tree.topics) {
        tree.topics = {};
      }

      if (!Array.isArray(tree.recent)) {
        tree.recent = [];
      }


      if (
        typeof tree.topics[topic] !==
        "number"
      ) {

        tree.topics[topic] = 1;

      }


      // ======================================================
      // LEARNING WEIGHTS
      // ======================================================

      if (action === "watch") {

        tree.topics[topic] += 1;

      }

      else if (action === "like") {

        tree.topics[topic] += 3;

      }

      else if (action === "replay") {

        tree.topics[topic] += 2;

      }

      else if (action === "skip") {

        tree.topics[topic] -= 0.4;

      }


      tree.topics[topic] =
        Math.max(
          0.1,
          Math.min(
            25,
            tree.topics[topic]
          )
        );


      // ======================================================
      // REMEMBER RECENT VIDEOS
      // ======================================================

      if (videoId) {

        tree.recent = [
          String(videoId),
          ...tree.recent.filter(
            id =>
              id !== String(videoId)
          )
        ].slice(0, 50);

      }


      tree.updatedAt =
        new Date();


      // ======================================================
      // SAVE
      // ======================================================

      await ref.set(
        tree,
        {
          merge: true
        }
      );


      return res.json({
        ok: true
      });


    } catch (error) {

      console.error(
        "Laper recommendation error:",
        error
      );

      return res.status(500).json({

        ok: false,

        error:
          error.message ||
          "Recommendation update failed"

      });

    }

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