import urlService from "../services/urlService.js";
import analyticsService from "../services/analyticsService.js";
import Click from "../models/Click.js";
import { ApiResponse } from "../utils/responses.js";
import { io } from "../server.js";
import URL from "../models/URL.js";
import { config } from "../config/config.js";

/**
 * Redirect Controller for SnapURL
 * Handles HTTP requests for URL redirects and click tracking
 */

/**
 * Handle short URL redirect with analytics tracking
 * @route GET /:shortCode
 * @access Public
 */
export const handleRedirect = async (req, res, next) => {
  try {
    const { shortCode } = req.params;

    if (req.method === "HEAD") {
      console.log('⛔ Blocked HEAD request');
      return res.status(200).end();
    }

    const ipAddress = req.ip || req.connection.remoteAddress || "127.0.0.1";
    const userAgent = req.get("User-Agent") || null;
    const referrer = req.get("Referrer") || req.get("Referer") || null;

    const device = parseUserAgent(userAgent);

    const url = await urlService.getUrlByShortCode(shortCode);

    if (!url) {
      return res.status(404).json(
        ApiResponse.error(
          "Short URL not found or expired",
          {
            shortCode,
            suggestion: "Please check the URL and try again",
          },
          404
        )
      );
    }

    const clickData = {
      urlId: url._id,
      device: device,
      ipAddress,
      userAgent,
      referrer,
      userId: null,
      sessionId: req.sessionID || null,
    };

    await analyticsService.recordClick(clickData);

    res.redirect(302, url.originalUrl);

    setImmediate(async () => {
      try {
        const now = new Date();
        const fiveMinutesAgo = new Date(now - 5 * 60 * 1000);
        const oneHourAgo = new Date(now - 60 * 60 * 1000);

        const [
          clicksLast5Min,
          clicksLastHour,
          uniqueVisitors,
          activeCountries,
          allUniqueVisitors,
          globalClicksLastHour,
          globalActiveCountries,
          topActiveUrls,
        ] = await Promise.all([
          Click.countDocuments({
            urlId: url._id,
            clickedAt: { $gte: fiveMinutesAgo },
          }),
          Click.countDocuments({
            urlId: url._id,
            clickedAt: { $gte: oneHourAgo },
          }),
          Click.aggregate([
            {
              $match: {
                urlId: url._id,
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
          Click.aggregate([
            {
              $match: {
                urlId: url._id,
                clickedAt: { $gte: oneHourAgo },
              },
            },
            {
              $group: {
                _id: "$location.country",
              },
            },
          ]).then((result) => result.map((r) => r._id).filter((c) => c)),

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
        ]);

        io.to(`url:${shortCode}`).emit("realtime:update", {
          clicksLast5Minutes: clicksLast5Min,
          clicksLastHour: clicksLastHour,
          activeCountries: activeCountries,
          uniqueVisitorsLastHour: uniqueVisitors,
          lastUpdated: now.toISOString(),
        });

        io.to("real-time").emit("real-time:analytics", {
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
      } catch (error) {
        console.error("Real-time analytics error:", error);
      }
    });
  } catch (error) {
    console.error("Redirect error:", error);

    res.status(500).json(
      ApiResponse.error(
        "Redirect failed",
        {
          shortCode: req.params.shortCode,
          error: error.message,
        },
        500
      )
    );
  }
};

// Determining the device type

function parseUserAgent(userAgent) {
  const ua = userAgent || navigator.userAgent;

  // Device Type
  let type = "desktop";
  if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) {
    type = "tablet";
  } else if (
    /Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/.test(
      ua
    )
  ) {
    type = "mobile";
  }

  // Browser Detection
  let browser = "Unknown";
  let browserVersion = "";

  const browserPatterns = [
    { name: "Edge", pattern: /Edg\/([0-9.]+)/ },
    { name: "Chrome", pattern: /Chrome\/([0-9.]+)/, exclude: /Edg/ },
    {
      name: "Safari",
      pattern: /Version\/([0-9.]+).*Safari/,
      exclude: /Chrome/,
    },
    { name: "Firefox", pattern: /Firefox\/([0-9.]+)/ },
    { name: "Opera", pattern: /(?:Opera|OPR)\/([0-9.]+)/ },
    { name: "IE", pattern: /(?:MSIE |rv:)([0-9.]+)/ },
  ];

  for (const { name, pattern, exclude } of browserPatterns) {
    if ((!exclude || !exclude.test(ua)) && pattern.test(ua)) {
      browser = name;
      const match = ua.match(pattern);
      browserVersion = match ? match[1] : "";
      break;
    }
  }

  // OS Detection
  let os = "Unknown";
  let osVersion = "";

  if (ua.includes("Windows NT 10.0")) {
    os = "Windows";
    osVersion = "10/11";
  } else if (ua.includes("Windows NT")) {
    os = "Windows";
    const versionMatch = ua.match(/Windows NT ([0-9.]+)/);
    osVersion = versionMatch ? versionMatch[1] : "";
  } else if (ua.includes("Mac OS X")) {
    os = "macOS";
    const versionMatch = ua.match(/Mac OS X ([0-9_]+)/);
    osVersion = versionMatch ? versionMatch[1].replace(/_/g, ".") : "";
  } else if (ua.includes("iPhone")) {
    os = "iOS";
    const versionMatch = ua.match(/OS ([0-9_]+)/);
    osVersion = versionMatch ? versionMatch[1].replace(/_/g, ".") : "";
  } else if (ua.includes("iPad")) {
    os = "iPadOS";
    const versionMatch = ua.match(/OS ([0-9_]+)/);
    osVersion = versionMatch ? versionMatch[1].replace(/_/g, ".") : "";
  } else if (ua.includes("Android")) {
    os = "Android";
    const versionMatch = ua.match(/Android ([0-9.]+)/);
    osVersion = versionMatch ? versionMatch[1] : "";
  } else if (ua.includes("Linux")) {
    os = "Linux";
  }

  return {
    type,
    browser: browserVersion ? `${browser} ${browserVersion}` : browser,
    os: osVersion ? `${os} ${osVersion}` : os,
  };
}

/**
 * Get redirect preview (shows destination without redirecting)
 * @route GET /preview/:shortCode
 * @access Public
 */
export const getRedirectPreview = async (req, res, next) => {
  try {
    const { shortCode } = req.params;

    const url = await urlService.getUrlByShortCode(shortCode);

    if (!url) {
      return res
        .status(404)
        .json(ApiResponse.error("Short URL not found or expired", null, 404));
    }

    // Return preview information without redirecting
    res.status(200).json(
      ApiResponse.success("Redirect preview retrieved successfully", {
        shortCode,
        shortUrl: url.shortUrl,
        originalUrl: url.originalUrl,
        title: url.title || url.metadata?.pageTitle || "Untitled",
        description: url.description || url.metadata?.pageDescription || "",
        domain: url.metadata?.domain,
        favicon: url.metadata?.favicon,
        createdAt: url.createdAt,
        isActive: url.isActive,
        totalClicks: url.clickCount,
        qrCode: url.qrCode?.dataUrl,
      })
    );
  } catch (error) {
    next(error);
  }
};

/**
 * Handle redirect with custom tracking parameters
 * @route GET /:shortCode/track
 * @access Public
 */
export const handleTrackedRedirect = async (req, res, next) => {
  try {
    const { shortCode } = req.params;
    const {
      utm_source,
      utm_medium,
      utm_campaign,
      utm_term,
      utm_content,
      ref,
      track_id,
    } = req.query;

    // Extract client information
    const ipAddress = req.ip || req.connection.remoteAddress || "127.0.0.1";
    const userAgent = req.get("User-Agent") || null;
    const referrer = ref || req.get("Referrer") || req.get("Referer") || null;

    // Get URL by short code
    const url = await urlService.getUrlByShortCode(shortCode);

    if (!url) {
      return res
        .status(404)
        .json(ApiResponse.error("Short URL not found or expired", null, 404));
    }

    // Enhanced click data with tracking parameters
    const clickData = {
      urlId: url._id,
      ipAddress,
      userAgent,
      referrer,
      userId: null,
      sessionId: req.sessionID || null,
      customData: {
        trackingId: track_id,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_term,
        utm_content,
        trackingTimestamp: new Date(),
      },
    };

    // Record enhanced click data
    analyticsService.recordClick(clickData).catch((error) => {
      console.error("Enhanced click recording failed:", error);
    });

    // Build destination URL with preserved parameters
    let destinationUrl = url.originalUrl;

    // If destination URL already has query parameters, append; otherwise, add them
    const urlObj = new globalThis.URL(destinationUrl);
    if (utm_source) urlObj.searchParams.set("utm_source", utm_source);
    if (utm_medium) urlObj.searchParams.set("utm_medium", utm_medium);
    if (utm_campaign) urlObj.searchParams.set("utm_campaign", utm_campaign);
    if (utm_term) urlObj.searchParams.set("utm_term", utm_term);
    if (utm_content) urlObj.searchParams.set("utm_content", utm_content);

    res.redirect(302, urlObj.toString());
  } catch (error) {
    console.error("Tracked redirect error:", error);
    res
      .status(500)
      .json(ApiResponse.error("Tracked redirect failed", null, 500));
  }
};

/**
 * Get redirect statistics for public URLs
 * @route GET /:shortCode/stats
 * @access Public (limited info)
 */
export const getPublicStats = async (req, res, next) => {
  try {
    const { shortCode } = req.params;

    const url = await urlService.getUrlByShortCode(shortCode);

    if (!url) {
      return res
        .status(404)
        .json(ApiResponse.error("Short URL not found or expired", null, 404));
    }

    // Return limited public statistics
    res.status(200).json(
      ApiResponse.success("Public statistics retrieved successfully", {
        shortCode,
        shortUrl: url.shortUrl,
        title: url.title || "Untitled",
        domain: url.metadata?.domain,
        createdAt: url.createdAt,
        totalClicks: url.clickCount,
        // Don't expose detailed analytics for public URLs
        isActive: url.isActive,
      })
    );
  } catch (error) {
    next(error);
  }
};

/**
 * Handle QR code redirect (same as regular redirect but with QR tracking)
 * @route GET /qr/:shortCode
 * @access Public
 */
export const handleQRRedirect = async (req, res, next) => {
  try {
    const { shortCode } = req.params;

    if (req.method === "HEAD") {
      return res.status(200).end();
    }

    // Extract client information
    const ipAddress = req.ip || req.connection.remoteAddress || "127.0.0.1";
    const userAgent = req.get("User-Agent") || null;
    const referrer = req.get("Referrer") || req.get("Referer") || null;

    // Get URL by short code
    const url = await urlService.getUrlByShortCode(shortCode);

    if (!url) {
      return res
        .status(404)
        .json(
          ApiResponse.error("QR code target not found or expired", null, 404)
        );
    }

    // Record click with QR code source tracking
    const clickData = {
      urlId: url._id,
      ipAddress,
      userAgent,
      referrer,
      userId: null,
      customData: {
        source: "qr_code",
        qrScanTimestamp: new Date(),
      },
    };

    analyticsService.recordClick(clickData).catch((error) => {
      console.error("QR click recording failed:", error);
    });

    // Redirect to original URL
    res.redirect(302, url.originalUrl);
  } catch (error) {
    console.error("QR redirect error:", error);
    res.status(500).json(ApiResponse.error("QR redirect failed", null, 500));
  }
};

/**
 * Batch redirect validation (check multiple short codes)
 * @route POST /validate-batch
 * @access Public
 */
export const validateBatchRedirects = async (req, res, next) => {
  try {
    const { shortCodes } = req.body;

    if (!Array.isArray(shortCodes)) {
      return res
        .status(400)
        .json(ApiResponse.error("Short codes array is required", null, 400));
    }

    if (shortCodes.length > 50) {
      return res
        .status(400)
        .json(
          ApiResponse.error(
            "Maximum 50 short codes allowed per batch",
            null,
            400
          )
        );
    }

    // Validate each short code
    const validationPromises = shortCodes.map(async (shortCode) => {
      try {
        const url = await urlService.getUrlByShortCode(shortCode);
        return {
          shortCode,
          valid: !!url,
          active: url ? url.isActive : false,
          expired: url ? url.isExpired : true,
          destination: url ? url.originalUrl : null,
        };
      } catch (error) {
        return {
          shortCode,
          valid: false,
          error: error.message,
        };
      }
    });

    const results = await Promise.all(validationPromises);

    const summary = {
      total: shortCodes.length,
      valid: results.filter((r) => r.valid).length,
      invalid: results.filter((r) => !r.valid).length,
      active: results.filter((r) => r.valid && r.active).length,
      expired: results.filter((r) => r.valid && r.expired).length,
    };

    res.status(200).json(
      ApiResponse.success("Batch validation completed", {
        results,
        summary,
      })
    );
  } catch (error) {
    next(error);
  }
};

/**
 * Handle redirect with password protection (future feature)
 * @route POST /:shortCode/unlock
 * @access Public
 */
export const handlePasswordProtectedRedirect = async (req, res, next) => {
  try {
    const { shortCode } = req.params;

    if (req.method === "HEAD") {
      return res.status(200).end();
    }

    const { password } = req.body;

    if (!password) {
      return res
        .status(400)
        .json(ApiResponse.error("Password is required", null, 400));
    }

    const url = await urlService.getUrlByShortCode(shortCode);

    if (!url) {
      return res
        .status(404)
        .json(ApiResponse.error("Short URL not found or expired", null, 404));
    }

    // Check if URL has password protection
    if (!url.password) {
      // If no password set, redirect normally
      return res.redirect(302, url.originalUrl);
    }

    // Verify password (in production, this would be hashed)
    const bcrypt = await import("bcryptjs");
    const isValidPassword = await bcrypt.compare(password, url.password);

    if (!isValidPassword) {
      return res
        .status(401)
        .json(ApiResponse.error("Invalid password", null, 401));
    }

    // Record click with password unlock tracking
    const clickData = {
      urlId: url._id,
      ipAddress: req.ip || "127.0.0.1",
      userAgent: req.get("User-Agent"),
      referrer: req.get("Referrer"),
      customData: {
        passwordProtected: true,
        unlockedAt: new Date(),
      },
    };

    analyticsService.recordClick(clickData).catch(console.error);

    res.status(200).json(
      ApiResponse.success("URL unlocked successfully", {
        redirectUrl: url.originalUrl,
      })
    );
  } catch (error) {
    next(error);
  }
};
