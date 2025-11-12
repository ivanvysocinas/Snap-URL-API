import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";

// Import configurations
import connectDB from "./config/db.js";
import { config } from "./config/config.js";

// Import middleware
import { errorHandler } from "./middleware/errorHandler.js";

// Import routes
import authRoutes from "./routes/auth.js";
import urlRoutes from "./routes/urls.js";
import analyticsRoutes from "./routes/analytics.js";
import redirectRoutes from "./routes/redirect.js";

const app = express();
const server = createServer(app);

const io = new Server(server, {
  cors: {
    origin: config.corsOrigin,
    credentials: true,
    methods: ["GET", "POST"]
  }
});

// Connect to database
if (process.env.NODE_ENV !== "test") {
  connectDB();
}

// Middleware
app.use(helmet());
app.use(
  cors({
    origin: config.corsOrigin,
    credentials: true,
  })
);

app.use(morgan(config.nodeEnv === "development" ? "dev" : "combined"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);

// Rate limiting
if (process.env.NODE_ENV !== "test") {
  const limiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMaxRequests,
    message: {
      success: false,
      message: "Too many requests, please try again later",
    },
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use("/api", limiter);
}

// Import swagger configuration
import { swaggerOptions } from "./docs/swagger.js";

const swaggerDocs = swaggerJsdoc(swaggerOptions);
app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerDocs, {
    customSiteTitle: "SnapURL API Documentation",
    customCss: ".swagger-ui .topbar { display: none }",
  })
);

// Health check route
app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "SnapURL API is running!",
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
  });
});

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/urls", urlRoutes);
app.use("/api/analytics", analyticsRoutes);

// Redirect routes (no /api prefix for clean short URLs)
app.use("/", redirectRoutes);

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  socket.on('subscribe:url', (shortCode) => {
    socket.join(`url:${shortCode}`);
    console.log(`📊 Client ${socket.id} subscribed to ${shortCode}`);
  });

  socket.on('unsubscribe:url', (shortCode) => {
    socket.leave(`url:${shortCode}`);
    console.log(`📊 Client ${socket.id} unsubscribed from ${shortCode}`);
  });

  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected:', socket.id);
  });
});

// Global error handler
app.use(errorHandler);

// 404 handler
app.all(/.*/, (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
  });
});

// Start server
if (process.env.NODE_ENV !== "test") {
  const PORT = config.port;
  server.listen(PORT, () => {
    console.log("🚀 SnapURL API Server started");
    console.log(`📍 Environment: ${config.nodeEnv}`);
    console.log(`📍 Port: ${PORT}`);
    console.log(`📍 API Docs: http://localhost:${PORT}/api-docs`);
    console.log(`📍 Health Check: http://localhost:${PORT}/health`);
    console.log("✨ Ready to shorten URLs!");
  });
}
export { io };
export default app;