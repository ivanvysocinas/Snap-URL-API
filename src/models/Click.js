import mongoose from "mongoose";
import geoip from "geoip-lite";
import { config } from "../config/config.js";

/**
 * Click Schema for SnapURL service
 * Tracks individual clicks on shortened URLs with detailed analytics
 *
 * @swagger
 * components:
 *   schemas:
 *     Click:
 *       type: object
 *       required:
 *         - urlId
 *         - ipAddress
 *       properties:
 *         _id:
 *           type: string
 *           description: Unique click identifier
 *         urlId:
 *           type: string
 *           description: Reference to the shortened URL
 *         userId:
 *           type: string
 *           description: User who clicked (if authenticated)
 *         ipAddress:
 *           type: string
 *           description: IP address of the visitor
 *         userAgent:
 *           type: string
 *           description: Browser user agent string
 *         referrer:
 *           type: string
 *           description: Referring URL or source
 *         location:
 *           type: object
 *           properties:
 *             country:
 *               type: string
 *               description: Country code (ISO 2-letter)
 *             region:
 *               type: string
 *               description: Region or state
 *             city:
 *               type: string
 *               description: City name
 *             timezone:
 *               type: string
 *               description: Timezone identifier
 *             coordinates:
 *               type: object
 *               properties:
 *                 latitude:
 *                   type: number
 *                 longitude:
 *                   type: number
 *         device:
 *           type: object
 *           properties:
 *             type:
 *               type: string
 *               enum: [desktop, mobile, tablet, bot]
 *             browser:
 *               type: string
 *               description: Browser name
 *             browserVersion:
 *               type: string
 *               description: Browser version
 *             os:
 *               type: string
 *               description: Operating system
 *             osVersion:
 *               type: string
 *               description: OS version
 *         isBot:
 *           type: boolean
 *           description: Whether the click was from a bot
 *         isUnique:
 *           type: boolean
 *           description: First time this IP clicked this URL
 *         clickedAt:
 *           type: string
 *           format: date-time
 *           description: Timestamp of the click
 *       example:
 *         _id: "64a1b2c3d4e5f6789abcdef0"
 *         urlId: "64a1b2c3d4e5f6789abcdef1"
 *         ipAddress: "192.168.1.1"
 *         location:
 *           country: "US"
 *           city: "New York"
 *         device:
 *           type: "desktop"
 *           browser: "Chrome"
 *           os: "Windows"
 *         isBot: false
 *         isUnique: true
 */

const clickSchema = new mongoose.Schema(
  {
    // Core references
    urlId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "URL",
      required: [true, "URL ID is required"],
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null, // Anonymous clicks allowed
      index: true,
    },

    // Request information
    ipAddress: {
      type: String,
      required: [true, "IP address is required"],
      validate: {
        validator: function (ip) {
          // Basic IP validation (IPv4 and IPv6)
          const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
          const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
          return (
            ipv4Regex.test(ip) ||
            ipv6Regex.test(ip) ||
            ip === "::1" ||
            ip === "localhost"
          );
        },
        message: "Invalid IP address format",
      },
    },

    userAgent: {
      type: String,
      maxLength: [1000, "User agent string too long"],
    },

    referrer: {
      type: String,
      maxLength: [500, "Referrer URL too long"],
      default: null,
    },

    // Geographic information (populated from IP)
    location: {
      country: {
        type: String,
        maxLength: 2, // ISO 2-letter country code
        uppercase: true,
      },

      countryName: {
        type: String,
        maxLength: 100,
      },

      region: {
        type: String,
        maxLength: 100,
      },

      city: {
        type: String,
        maxLength: 100,
      },

      timezone: {
        type: String,
        maxLength: 50,
      },

      coordinates: {
        latitude: {
          type: Number,
          min: -90,
          max: 90,
        },
        longitude: {
          type: Number,
          min: -180,
          max: 180,
        },
      },

      // Additional location metadata
      isp: {
        type: String,
        maxLength: 200,
      },

      organization: {
        type: String,
        maxLength: 200,
      },
    },

    // Device and browser information
    device: {
      type: {
        type: String,
        enum: ["desktop", "mobile", "tablet", "bot", "unknown"],
        default: "unknown",
      },

      browser: {
        type: String,
        maxLength: 50,
      },

      browserVersion: {
        type: String,
        maxLength: 20,
      },

      engine: {
        type: String,
        maxLength: 50,
      },

      os: {
        type: String,
        maxLength: 50,
      },

      osVersion: {
        type: String,
        maxLength: 20,
      },

      screenResolution: {
        width: Number,
        height: Number,
      },

      language: {
        type: String,
        maxLength: 10, // e.g., 'en-US'
      },
    },

    // Click classification
    isBot: {
      type: Boolean,
      default: false,
      index: true,
    },

    isUnique: {
      type: Boolean,
      default: false,
      index: true,
    },

    // Campaign and tracking
    campaign: {
      source: String, // utm_source
      medium: String, // utm_medium
      campaign: String, // utm_campaign
      term: String, // utm_term
      content: String, // utm_content
    },

    // Session information
    sessionId: {
      type: String,
      maxLength: 100,
    },

    // Click metadata
    loadTime: {
      type: Number, // milliseconds
      min: 0,
    },

    // Custom tracking data
    customData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: {
      createdAt: "clickedAt",
      updatedAt: false, // Clicks are immutable
    },
    toJSON: {
      virtuals: true,
      transform: function (doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

/**
 * Virtual for getting formatted click time
 */
clickSchema.virtual("formattedClickTime").get(function () {
  return this.clickedAt.toLocaleString();
});

/**
 * Virtual for checking if click is recent (within last hour)
 */
clickSchema.virtual("isRecent").get(function () {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  return this.clickedAt > oneHourAgo;
});

/**
 * Virtual for getting location string
 */
clickSchema.virtual("locationString").get(function () {
  const parts = [];
  if (this.location.city) parts.push(this.location.city);
  if (this.location.region) parts.push(this.location.region);
  if (this.location.countryName) parts.push(this.location.countryName);
  return parts.join(", ") || "Unknown";
});

/**
 * Pre-save middleware to populate location data from IP
 */
clickSchema.pre("save", function (next) {
  if (this.isNew && config.enableGeolocation && this.ipAddress) {
    try {
      // Skip localhost and private IPs
      if (
        this.ipAddress === "127.0.0.1" ||
        this.ipAddress === "::1" ||
        this.ipAddress.startsWith("192.168.") ||
        this.ipAddress.startsWith("10.") ||
        this.ipAddress.startsWith("172.")
      ) {
        this.location = {
          country: "XX",
          countryName: "Local/Private",
          city: "Local",
          region: "Local",
        };
      } else {
        const geo = geoip.lookup(this.ipAddress);
        if (geo) {
          this.location = {
            country: geo.country,
            countryName: geo.country, // geoip-lite doesn't provide full name
            region: geo.region,
            city: geo.city,
            timezone: geo.timezone,
            coordinates: {
              latitude: geo.ll[0],
              longitude: geo.ll[1],
            },
          };
        }
      }
    } catch (error) {
      console.error("Geolocation lookup failed:", error.message);
      // Continue without geolocation data
    }
  }

  next();
});

/**
 * Pre-save middleware to detect bots
 */
clickSchema.pre("save", async function (next) {
  if (this.isNew && this.userAgent) {
    try {
      // Bot detection
      this.isBot = this.detectBot(this.userAgent);
    } catch (error) {
      console.error("Bot detection failed: ", error.message);
    }
  }

  next();
});

/**
 * Instance method to detect if user agent is a bot
 * @param {string} userAgent - User agent string
 * @returns {boolean} True if bot detected
 */
clickSchema.methods.detectBot = function (userAgent) {
  const botPatterns = [
    /bot/i,
    /crawl/i,
    /spider/i,
    /scrape/i,
    /google/i,
    /bing/i,
    /yahoo/i,
    /baidu/i,
    /facebook/i,
    /twitter/i,
    /linkedin/i,
    /curl/i,
    /wget/i,
    /postman/i,
  ];

  return botPatterns.some((pattern) => pattern.test(userAgent));
};

/**
 * Static method to get click analytics for a URL
 * @param {string} urlId - URL ObjectId
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Click analytics
 */
clickSchema.statics.getUrlAnalytics = async function (urlId, options = {}) {
  try {
    const {
      startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
      endDate = new Date(),
      excludeBots = true,
    } = options;

    const matchStage = {
      urlId: new mongoose.Types.ObjectId(urlId),
      clickedAt: { $gte: startDate, $lte: endDate },
    };

    if (excludeBots) {
      matchStage.isBot = { $ne: true };
    }

    const [analytics] = await this.aggregate([
      { $match: matchStage },
      {
        $facet: {
          overview: [
            {
              $group: {
                _id: null,
                totalClicks: { $sum: 1 },
                uniqueClicks: { $sum: { $cond: ["$isUnique", 1, 0] } },
                botClicks: { $sum: { $cond: ["$isBot", 1, 0] } },
                averageLoadTime: { $avg: "$loadTime" },
              },
            },
          ],

          byCountry: [
            {
              $match: { "location.country": { $exists: true, $ne: null } },
            },
            {
              $group: {
                _id: "$location.country",
                count: { $sum: 1 },
                countryName: { $first: "$location.countryName" },
              },
            },
            {
              $sort: { count: -1 },
            },
            {
              $limit: 10,
            },
          ],

          byDevice: [
            {
              $group: {
                _id: "$device.type",
                count: { $sum: 1 },
              },
            },
            {
              $sort: { count: -1 },
            },
          ],

          byBrowser: [
            {
              $match: { "device.browser": { $exists: true, $ne: "Unknown" } },
            },
            {
              $group: {
                _id: "$device.browser",
                count: { $sum: 1 },
              },
            },
            {
              $sort: { count: -1 },
            },
            {
              $limit: 10,
            },
          ],

          byReferrer: [
            {
              $match: { referrer: { $exists: true, $ne: null } },
            },
            {
              $group: {
                _id: "$referrer",
                count: { $sum: 1 },
              },
            },
            {
              $sort: { count: -1 },
            },
            {
              $limit: 10,
            },
          ],

          clicksByHour: [
            {
              $group: {
                _id: { $hour: "$clickedAt" },
                count: { $sum: 1 },
                uniqueUsers: { $addToSet: "$userId" },
                uniqueIPs: { $addToSet: "$ipAddress" },
              },
            },
            {
              $project: {
                _id: 1,
                count: 1,
                uniqueUsersCount: { $size: "$uniqueUsers" },
                uniqueIPsCount: { $size: "$uniqueIPs" },
              },
            },
            {
              $sort: { _id: 1 },
            },
          ],

          clicksByDay: [
            {
              $group: {
                _id: {
                  year: { $year: "$clickedAt" },
                  month: { $month: "$clickedAt" },
                  day: { $dayOfMonth: "$clickedAt" },
                },
                count: { $sum: 1 },
                uniqueVisitors: {
                  $addToSet: {
                    $cond: [
                      { $ne: ["$userId", null] },
                      "$userId",
                      "$ipAddress",
                    ],
                  },
                },
                uniqueRegisteredUsers: {
                  $addToSet: {
                    $cond: [{ $ne: ["$userId", null] }, "$userId", "$$REMOVE"],
                  },
                },
                uniqueCountries: { $addToSet: "$location.country" },
                botClicks: {
                  $sum: { $cond: [{ $eq: ["$isBot", true] }, 1, 0] },
                },
                uniqueDeviceTypes: { $addToSet: "$device.type" },
              },
            },
            {
              $project: {
                _id: 1,
                count: 1,
                uniqueVisitorsCount: { $size: "$uniqueVisitors" },
                uniqueRegisteredUsersCount: {
                  $size: { $ifNull: ["$uniqueRegisteredUsers", []] },
                },
                uniqueCountriesCount: { $size: "$uniqueCountries" },
                uniqueDeviceTypesCount: { $size: "$uniqueDeviceTypes" },
                botClicks: 1,
                humanClicks: { $subtract: ["$count", "$botClicks"] },
              },
            },
            {
              $sort: { _id: 1 },
            },
          ],
        },
      },
    ]);

    return {
      overview: analytics.overview[0] || {
        totalClicks: 0,
        uniqueClicks: 0,
        botClicks: 0,
        averageLoadTime: 0,
      },
      byCountry: analytics.byCountry,
      byDevice: analytics.byDevice,
      byBrowser: analytics.byBrowser,
      byReferrer: analytics.byReferrer,
      clicksByHour: analytics.clicksByHour,
      clicksByDay: analytics.clicksByDay,
      dateRange: { startDate, endDate },
    };
  } catch (error) {
    throw new Error(`Click analytics generation failed: ${error.message}`);
  }
};

/**
 * Static method to get global analytics across all URLs
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Global analytics
 */
clickSchema.statics.getGlobalAnalytics = async function (options = {}) {
  try {
    const {
      startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      endDate = new Date(),
      excludeBots = true,
      userId = null,
    } = options;

    const matchStage = {
      clickedAt: { $gte: startDate, $lte: endDate },
    };

    if (excludeBots) {
      matchStage.isBot = { $ne: true };
    }

    if (userId) {
      matchStage.userId = new mongoose.Types.ObjectId(userId);
    }

    const [analytics] = await this.aggregate([
      { $match: matchStage },
      {
        $facet: {
          overview: [
            {
              $group: {
                _id: null,
                totalClicks: { $sum: 1 },
                uniqueUrls: { $addToSet: "$urlId" },
                uniqueVisitors: { $addToSet: "$ipAddress" },
                topCountries: { $push: "$location.country" },
              },
            },
            {
              $project: {
                totalClicks: 1,
                uniqueUrls: { $size: "$uniqueUrls" },
                uniqueVisitors: { $size: "$uniqueVisitors" },
              },
            },
          ],

          trends: [
            {
              $group: {
                _id: {
                  date: {
                    $dateToString: {
                      format: "%Y-%m-%d",
                      date: "$clickedAt",
                    },
                  },
                },
                clicks: { $sum: 1 },
                uniqueVisitors: { $addToSet: "$ipAddress" },
              },
            },
            {
              $project: {
                date: "$_id.date",
                clicks: 1,
                uniqueVisitors: { $size: "$uniqueVisitors" },
              },
            },
            {
              $sort: { date: 1 },
            },
          ],
        },
      },
    ]);

    return {
      overview: analytics.overview[0] || {
        totalClicks: 0,
        uniqueUrls: 0,
        uniqueVisitors: 0,
      },
      trends: analytics.trends,
      dateRange: { startDate, endDate },
    };
  } catch (error) {
    throw new Error(`Global analytics generation failed: ${error.message}`);
  }
};

/**
 * Static method to detect and mark unique clicks
 * @param {string} urlId - URL ObjectId
 * @param {string} ipAddress - Visitor IP address
 * @returns {Promise<boolean>} True if this is a unique click
 */
clickSchema.statics.isUniqueClick = async function (urlId, ipAddress) {
  try {
    const existingClick = await this.findOne({
      urlId: new mongoose.Types.ObjectId(urlId),
      ipAddress,
    });

    return !existingClick;
  } catch (error) {
    console.error("Unique click detection failed:", error);
    return false; // Default to non-unique on error
  }
};

/**
 * Static method to get real-time click statistics
 * @param {number} minutes - Time window in minutes (default 60)
 * @returns {Promise<Object>} Real-time statistics
 */
clickSchema.statics.getRealTimeStats = async function (minutes = 60) {
  try {
    const timeThreshold = new Date(Date.now() - minutes * 60 * 1000);

    const [stats] = await this.aggregate([
      {
        $match: {
          clickedAt: { $gte: timeThreshold },
          isBot: { $ne: true },
        },
      },
      {
        $group: {
          _id: null,
          recentClicks: { $sum: 1 },
          activeUrls: { $addToSet: "$urlId" },
          activeCountries: { $addToSet: "$location.country" },
          clicksPerMinute: {
            $push: {
              minute: { $minute: "$clickedAt" },
              clicks: 1,
            },
          },
        },
      },
      {
        $project: {
          recentClicks: 1,
          activeUrls: { $size: "$activeUrls" },
          activeCountries: { $size: "$activeCountries" },
          avgClicksPerMinute: { $divide: ["$recentClicks", minutes] },
        },
      },
    ]);

    return (
      stats || {
        recentClicks: 0,
        activeUrls: 0,
        activeCountries: 0,
        avgClicksPerMinute: 0,
      }
    );
  } catch (error) {
    throw new Error(`Real-time statistics generation failed: ${error.message}`);
  }
};

/**
 * Static method to clean up old click data
 * @param {number} retentionDays - Number of days to retain data
 * @returns {Promise<Object>} Cleanup results
 */
clickSchema.statics.cleanupOldClicks = async function (retentionDays = 365) {
  try {
    const cutoffDate = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000
    );

    const result = await this.deleteMany({
      clickedAt: { $lt: cutoffDate },
    });

    return {
      deletedCount: result.deletedCount,
      cutoffDate,
      retentionDays,
    };
  } catch (error) {
    throw new Error(`Click data cleanup failed: ${error.message}`);
  }
};

/**
 * Static method to export click data for a URL
 * @param {string} urlId - URL ObjectId
 * @param {Object} options - Export options
 * @returns {Promise<Array>} Click data for export
 */
clickSchema.statics.exportClickData = async function (urlId, options = {}) {
  try {
    const {
      format = "json", // 'json' or 'csv'
      excludeBots = true,
      fields = [
        "clickedAt",
        "location.country",
        "location.city",
        "device.type",
        "device.browser",
        "referrer",
      ],
    } = options;

    const query = { urlId: new mongoose.Types.ObjectId(urlId) };
    if (excludeBots) {
      query.isBot = { $ne: true };
    }

    const clicks = await this.find(query)
      .select(fields.join(" "))
      .sort({ clickedAt: -1 })
      .lean();

    return clicks;
  } catch (error) {
    throw new Error(`Click data export failed: ${error.message}`);
  }
};

// Indexes for performance optimization
clickSchema.index({ urlId: 1, clickedAt: -1 });
clickSchema.index({ userId: 1, clickedAt: -1 });
clickSchema.index({ ipAddress: 1, urlId: 1 });
clickSchema.index({ clickedAt: -1 });
clickSchema.index({ isBot: 1 });
clickSchema.index({ isUnique: 1 });
clickSchema.index({ "location.country": 1 });
clickSchema.index({ "device.type": 1 });
clickSchema.index({ "device.browser": 1 });

// TTL index for automatic cleanup (optional)
clickSchema.index(
  { clickedAt: 1 },
  {
    expireAfterSeconds: 365 * 24 * 60 * 60, // 1 year
    partialFilterExpression: {
      isBot: true, // Only auto-delete bot clicks
    },
  }
);

const Click = mongoose.model("Click", clickSchema);

export default Click;
