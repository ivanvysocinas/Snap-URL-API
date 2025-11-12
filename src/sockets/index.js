import { Server } from "socket.io";
import { config } from "../config/config.js";
import Click from "../models/Click.js";
import URL from "../models/URL.js";

let io;

/**
 * Initialize Socket.io server
 * @param {http.Server} server - HTTP server instance
 * @returns {Server} Socket.io instance
 */
export const initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: config.corsOrigin,
      credentials: true,
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    // Subscribe to specific URL analytics
    socket.on("subscribe:url", (shortCode) => {
      socket.join(`url:${shortCode}`);
      console.log(`Socket ${socket.id} subscribed to url:${shortCode}`);
    });

    // Unsubscribe from specific URL analytics
    socket.on("unsubscribe:url", (shortCode) => {
      socket.leave(`url:${shortCode}`);
      console.log(`Socket ${socket.id} unsubscribed from url:${shortCode}`);
    });

    // Subscribe to global real-time analytics
    socket.on("subscribe:real-time", () => {
      socket.join("real-time");
      console.log(`Socket ${socket.id} subscribed to real-time analytics`);
    });

    // Unsubscribe from global real-time analytics
    socket.on("unsubscribe:real-time", () => {
      socket.leave("real-time");
      console.log(`Socket ${socket.id} unsubscribed from real-time analytics`);
    });

    // Handle request for current real-time data
    socket.on("request:real-time:current", async () => {
      try {
        const now = new Date();
        const oneHourAgo = new Date(now - 60 * 60 * 1000);

        const [
          globalClicksLastHour,
          globalActiveCountries,
          topActiveUrls,
          allUniqueVisitors,
        ] = await Promise.all([
          Click.countDocuments({
            clickedAt: { $gte: oneHourAgo },
          }),

          Click.aggregate([
            {
              $match: {
                clickedAt: { $gte: oneHourAgo },
              },
            },
            {
              $group: {
                _id: "$location.country",
              },
            },
            {
              $count: "total",
            },
          ]).then((result) => result[0]?.total || 0),

          URL.find(
            {
              lastClickedAt: { $gte: oneHourAgo },
            },
            {
              shortCode: 1,
              title: 1,
              clickCount: 1,
              uniqueClicks: 1,
              lastClickedAt: 1,
            }
          )
            .sort({ lastClickedAt: -1 })
            .limit(5),

          Click.aggregate([
            {
              $match: {
                clickedAt: { $gte: oneHourAgo },
              },
            },
            {
              $group: {
                _id: "$ipAddress",
              },
            },
            {
              $count: "total",
            },
          ]).then((result) => result[0]?.total || 0),
        ]);

        socket.emit("real-time:analytics", {
          timeWindow: "60min",
          statistics: {
            recentClicks: globalClicksLastHour,
            activeUrls: topActiveUrls.length,
            activeCountries: globalActiveCountries,
            avgClicksPerMinute:
              Math.round((globalClicksLastHour / 60) * 100) / 100,
          },
          activeUrls: topActiveUrls.map((url) => ({
            shortUrl: `${config.baseUrl}/${url.shortCode}`,
            title: url.title || null,
            clickCount: url.clickCount,
            uniqueVisitors: url.uniqueClicks,
            lastClick: url.lastClickedAt,
          })),
          liveVisitors: allUniqueVisitors,
          lastUpdated: now.toISOString(),
        });

        console.log(`Real-time data sent to socket ${socket.id}`);
      } catch (error) {
        console.error("Real-time analytics request error:", error);
        socket.emit("real-time:error", {
          message: "Failed to fetch analytics",
        });
      }
    });

    // Handle disconnect
    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });

  return io;
};

/**
 * Get Socket.io instance
 * @returns {Server}
 */
export const getIO = () => {
  if (!io) {
    throw new Error("Socket.io not initialized! Call initializeSocket first.");
  }
  return io;
};

export default { initializeSocket, getIO };
