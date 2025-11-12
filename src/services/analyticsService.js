import Click from "../models/Click.js";
import URL_MODEL from "../models/URL.js";
import User from "../models/User.js";

/**
 * Analytics Service for SnapURL
 * Handles click tracking, analytics generation, and statistical reporting
 */

class AnalyticsService {
  /**
   * Comprehensive IP address normalization and validation
   * @param {string} ip - Raw IP address from various sources
   * @param {Object} headers - Request headers for additional IP extraction
   * @returns {string} Normalized and validated IPv4 address
   */
  _normalizeIpAddress(ip, headers = {}) {
    // Helper function to validate IPv4
    const isValidIPv4 = (ip) => {
      const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
      if (!ipv4Regex.test(ip)) return false;

      const parts = ip.split(".");
      return parts.every((part) => {
        const num = parseInt(part, 10);
        return num >= 0 && num <= 255;
      });
    };

    // Helper function to extract IP from X-Forwarded-For header
    const extractFromForwardedFor = (forwardedFor) => {
      if (!forwardedFor) return null;

      // Split by comma and get the first (original client) IP
      const ips = forwardedFor.split(",").map((ip) => ip.trim());

      // Find first public IP (not private/local)
      for (const candidateIp of ips) {
        if (this._isPublicIP(candidateIp)) {
          return candidateIp;
        }
      }

      // If no public IP found, return the first one
      return ips[0] || null;
    };

    // Try multiple sources in order of preference
    const ipSources = [
      ip, // Direct IP parameter
      headers["cf-connecting-ip"], // Cloudflare
      headers["x-real-ip"], // Nginx proxy
      extractFromForwardedFor(headers["x-forwarded-for"]), // Load balancers
      headers["x-client-ip"], // Apache
      headers["x-forwarded"], // Other proxies
      headers["forwarded-for"],
      headers["forwarded"],
    ].filter(Boolean);

    for (const candidateIp of ipSources) {
      let normalizedIp = candidateIp;

      // Handle IPv4-mapped IPv6 addresses (::ffff:127.0.0.1 -> 127.0.0.1)
      if (normalizedIp.startsWith("::ffff:")) {
        normalizedIp = normalizedIp.substring(7);
      }

      // Handle IPv6 loopback (::1 -> 127.0.0.1)
      if (normalizedIp === "::1") {
        normalizedIp = "127.0.0.1";
      }

      // Handle localhost variations
      if (normalizedIp === "localhost") {
        normalizedIp = "127.0.0.1";
      }

      // Validate and return if it's a valid IPv4
      if (isValidIPv4(normalizedIp)) {
        return normalizedIp;
      }
    }

    // Fallback for development/testing
    return "127.0.0.1";
  }

  /**
   * Check if IP address is public (not private/local)
   * @param {string} ip - IP address to check
   * @returns {boolean} True if public IP
   */
  _isPublicIP(ip) {
    if (!ip) return false;

    // Private IP ranges (RFC 1918)
    const privateRanges = [
      /^10\./, // 10.0.0.0/8
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
      /^192\.168\./, // 192.168.0.0/16
      /^127\./, // Loopback
      /^169\.254\./, // Link-local
      /^224\./, // Multicast
      /^0\./, // Invalid
    ];

    return !privateRanges.some((range) => range.test(ip));
  }

  /**
   * Record a click event with detailed analytics
   * @param {Object} clickData - Click event data
   * @param {string} clickData.urlId - URL document ID
   * @param {string} clickData.ipAddress - Visitor IP address
   * @param {string} [clickData.userAgent] - Browser user agent
   * @param {string} [clickData.referrer] - Referring URL
   * @param {string} [clickData.userId] - User ID if authenticated
   * @param {Object} [clickData.customData] - Additional tracking data
   * @returns {Promise<Object>} Recorded click and redirect URL
   * @throws {Error} If click recording fails
   */
  async recordClick(clickData) {
    try {
      const {
        urlId,
        ipAddress: rawIpAddress,
        headers = {}, // Add headers parameter
        userAgent = null,
        referrer = null,
        userId = null,
        customData = {},
        sessionId = null,
        device
      } = clickData;

      // Use enhanced IP normalization
      const ipAddress = this._normalizeIpAddress(rawIpAddress, headers);

      // Find the URL document
      const url = await URL_MODEL.findById(urlId);
      if (!url || !url.isActive) {
        throw new Error("URL not found or inactive");
      }

      // Check if URL is expired
      if (url.isExpired) {
        throw new Error("URL has expired");
      }

      // Determine if this is a unique click
      const isUnique = await Click.isUniqueClick(urlId, ipAddress);

      // Create click record
      const click = new Click({
        urlId,
        userId,
        ipAddress,
        userAgent,
        referrer,
        isUnique,
        sessionId,
        customData,
        device,
        // Add IP metadata for debugging
        ipMetadata:
          process.env.NODE_ENV === "development"
            ? {
                raw: rawIpAddress,
                isPublic: this._isPublicIP(ipAddress),
                source: this._getIPSource(rawIpAddress, headers),
              }
            : undefined,
      });

      // Extract campaign data from referrer if present
      if (referrer) {
        const campaignData = this._extractCampaignData(referrer);
        if (campaignData) {
          click.campaign = campaignData;
        }
      }

      // Save click record (geo and device data populated by middleware)
      await click.save();

      // Update URL statistics
      await this._updateUrlStats(url, isUnique);

      // Update user statistics if applicable
      if (url.userId) {
        await this._updateUserStats(url.userId, 1);
      }

      return {
        click,
        redirectUrl: url.originalUrl,
        analytics: {
          totalClicks: url.clickCount + 1,
          uniqueClicks: url.uniqueClicks + (isUnique ? 1 : 0),
          isUnique,
        },
      };
    } catch (error) {
      throw new Error(`Click recording failed: ${error.message}`);
    }
  }

  /**
   * Helper method to identify IP source for debugging
   * @param {string} rawIp - Original IP
   * @param {Object} headers - Request headers
   * @returns {string} IP source identifier
   */
  _getIPSource(rawIp, headers) {
    if (headers["cf-connecting-ip"]) return "cloudflare";
    if (headers["x-real-ip"]) return "nginx";
    if (headers["x-forwarded-for"]) return "load-balancer";
    if (headers["x-client-ip"]) return "apache";
    if (rawIp) return "direct";
    return "unknown";
  }

  /**
   * Development helper: Test IP normalization
   * @param {Object} testData - Test scenarios
   * @returns {Object} Test results
   */
  _testIPNormalization(testData = {}) {
    if (process.env.NODE_ENV !== "development") {
      return { error: "Only available in development mode" };
    }

    const testCases = {
      ipv6Mapped: "::ffff:192.168.1.1",
      ipv6Loopback: "::1",
      localhost: "localhost",
      privateIP: "192.168.1.100",
      publicIP: "8.8.8.8",
      cloudflare: { headers: { "cf-connecting-ip": "203.0.113.1" } },
      forwardedFor: {
        headers: { "x-forwarded-for": "203.0.113.1, 192.168.1.1, 127.0.0.1" },
      },
      ...testData,
    };

    const results = {};

    Object.entries(testCases).forEach(([testName, data]) => {
      if (typeof data === "string") {
        results[testName] = {
          input: data,
          output: this._normalizeIpAddress(data),
          isPublic: this._isPublicIP(this._normalizeIpAddress(data)),
        };
      } else {
        results[testName] = {
          input: data,
          output: this._normalizeIpAddress(null, data.headers),
          isPublic: this._isPublicIP(
            this._normalizeIpAddress(null, data.headers)
          ),
        };
      }
    });

    return results;
  }

  /**
   * Get detailed analytics for a specific URL
   * @param {string} urlId - URL document ID
   * @param {Object} options - Analytics options
   * @returns {Promise<Object>} Comprehensive URL analytics
   * @throws {Error} If analytics generation fails
   */
  async getUrlAnalytics(urlId, options = {}) {
    try {
      const {
        startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
        endDate = new Date(),
        excludeBots = true,
        includeRealTime = true,
      } = options;

      // Verify URL exists
      const url = await URL_MODEL.findById(urlId);
      if (!url) {
        throw new Error("URL not found");
      }

      // Get click analytics
      const analytics = await Click.getUrlAnalytics(urlId, {
        startDate,
        endDate,
        excludeBots,
      });

      // Add real-time data if requested
      let realTimeStats = null;
      if (includeRealTime) {
        realTimeStats = await this._getRealTimeUrlStats(urlId);
      }

      // Get top referrers with additional processing
      const topReferrers = await this._getTopReferrers(
        urlId,
        startDate,
        endDate
      );

      // Calculate performance metrics
      const performanceMetrics = await this._calculatePerformanceMetrics(
        url,
        analytics
      );

      return {
        url: {
          id: url._id,
          originalUrl: url.originalUrl,
          shortUrl: url.shortUrl,
          title: url.title,
          createdAt: url.createdAt,
          isActive: url.isActive,
        },
        overview: analytics.overview,
        geographic: {
          byCountry: analytics.byCountry,
          topCountries: analytics.byCountry.slice(0, 5),
        },
        technology: {
          byDevice: analytics.byDevice,
          byBrowser: analytics.byBrowser,
          topBrowsers: analytics.byBrowser.slice(0, 5),
        },
        traffic: {
          byReferrer: topReferrers,
          clicksByHour: analytics.clicksByHour,
          clicksByDay: analytics.clicksByDay,
        },
        performance: performanceMetrics,
        realTime: realTimeStats,
        dateRange: { startDate, endDate },
      };
    } catch (error) {
      throw new Error(`URL analytics generation failed: ${error.message}`);
    }
  }

  /**
   * Get user dashboard analytics
   * @param {string} userId - User ID
   * @param {Object} options - Analytics options
   * @returns {Promise<Object>} User dashboard analytics
   * @throws {Error} If analytics generation fails
   */
  async getUserDashboard(userId, options = {}) {
    try {
      const {
        startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        endDate = new Date(),
        limit = 10,
      } = options;

      // Get user's URLs
      const userUrls = await URL_MODEL.find({
        // Исправлено: было URL
        userId,
        isActive: true,
      }).select("_id");

      const urlIds = userUrls.map((url) => url._id);

      if (urlIds.length === 0) {
        return this._getEmptyDashboard(userId);
      }

      // Get aggregate click data for user's URLs
      const [dashboardData] = await Click.aggregate([
        {
          $match: {
            urlId: { $in: urlIds },
            clickedAt: { $gte: startDate, $lte: endDate },
            isBot: { $ne: true },
          },
        },
        {
          $facet: {
            overview: [
              {
                $group: {
                  _id: null,
                  totalClicks: { $sum: 1 },
                  uniqueClicks: { $sum: { $cond: ["$isUnique", 1, 0] } },
                  uniqueVisitors: { $addToSet: "$ipAddress" },
                },
              },
              {
                $project: {
                  totalClicks: 1,
                  uniqueClicks: 1,
                  uniqueVisitors: { $size: "$uniqueVisitors" },
                },
              },
            ],

            trends: [
              {
                $group: {
                  _id: {
                    date: {
                      $dateToString: { format: "%Y-%m-%d", date: "$clickedAt" },
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

            topCountries: [
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
                $limit: 5,
              },
            ],
          },
        },
      ]);

      // Get top performing URLs
      const topUrls = await URL_MODEL.find({ userId })
        .sort({ clickCount: -1, uniqueClicks: -1 })
        .limit(limit)
        .select(
          "originalUrl shortUrl title clickCount uniqueClicks createdAt shortCode"
        )
        .lean();

      // Get recent activity
      const recentActivity = await this._getRecentActivity(userId, 10);

      return {
        userId,
        overview: dashboardData?.overview[0] || {
          totalClicks: 0,
          uniqueClicks: 0,
          uniqueVisitors: 0,
        },
        trends: dashboardData?.trends || [],
        geographic: {
          topCountries: dashboardData?.topCountries || [],
        },
        topUrls,
        recentActivity,
        dateRange: { startDate, endDate },
      };
    } catch (error) {
      throw new Error(`User dashboard analytics failed: ${error.message}`);
    }
  }

  /**
   * Get global platform analytics (admin only)
   * @param {Object} options - Analytics options
   * @returns {Promise<Object>} Platform-wide analytics
   * @throws {Error} If analytics generation fails
   */
  async getPlatformAnalytics(options = {}) {
    try {
      const {
        startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        endDate = new Date(),
      } = options;

      // Get global statistics
      const globalStats = await Click.getGlobalAnalytics({
        startDate,
        endDate,
        excludeBots: true,
      });

      // Get user analytics
      const userStats = await User.getAnalyticsSummary();

      // Get URL analytics
      const urlStats = await URL_MODEL.getAnalyticsSummary();

      // Get platform growth metrics
      const growthMetrics = await this._calculateGrowthMetrics(
        startDate,
        endDate
      );

      // Get performance metrics
      const performanceMetrics = await this._calculatePlatformPerformance();

      return {
        overview: {
          users: userStats,
          urls: urlStats,
          clicks: globalStats.overview,
        },
        growth: growthMetrics,
        performance: performanceMetrics,
        trends: globalStats.trends,
        dateRange: { startDate, endDate },
      };
    } catch (error) {
      throw new Error(`Platform analytics generation failed: ${error.message}`);
    }
  }

  /**
   * Generate analytics report for export
   * @param {Object} criteria - Report criteria
   * @returns {Promise<Object>} Formatted analytics report
   * @throws {Error} If report generation fails
   */
  async generateReport(criteria) {
    try {
      const {
        type = "url", // 'url', 'user', 'platform'
        targetId = null,
        startDate,
        endDate,
        format = "json",
        includeCharts = false,
      } = criteria;

      let reportData;

      switch (type) {
        case "url":
          if (!targetId) throw new Error("URL ID required for URL report");
          reportData = await this.getUrlAnalytics(targetId, {
            startDate,
            endDate,
          });
          break;

        case "user":
          if (!targetId) throw new Error("User ID required for user report");
          reportData = await this.getUserDashboard(targetId, {
            startDate,
            endDate,
          });
          break;

        case "platform":
          reportData = await this.getPlatformAnalytics({ startDate, endDate });
          break;

        default:
          throw new Error("Invalid report type");
      }

      // Format report
      const formattedReport = {
        metadata: {
          type,
          targetId,
          generatedAt: new Date(),
          dateRange: { startDate, endDate },
          format,
        },
        data: reportData,
      };

      // Add chart data if requested
      if (includeCharts) {
        formattedReport.charts = await this._generateChartData(
          reportData,
          type
        );
      }

      return formattedReport;
    } catch (error) {
      throw new Error(`Report generation failed: ${error.message}`);
    }
  }

  /**
   * Get real-time analytics (last hour)
   * @param {Object} options - Real-time options
   * @returns {Promise<Object>} Real-time analytics
   * @throws {Error} If real-time analytics fail
   */
  async getRealTimeAnalytics(options = {}) {
    try {
      const { minutes = 60, userId = null } = options;

      // Get real-time click statistics
      const realTimeStats = await Click.getRealTimeStats(minutes);

      // Get active URLs (URLs clicked in the time window)
      const activeUrls = await this._getActiveUrls(minutes, userId);

      // Get live visitor count estimate
      const liveVisitors = await this._estimateLiveVisitors(10); // Last 10 minutes

      return {
        timeWindow: `${minutes} minutes`,
        statistics: realTimeStats,
        activeUrls,
        liveVisitors,
        lastUpdated: new Date(),
      };
    } catch (error) {
      throw new Error(`Real-time analytics failed: ${error.message}`);
    }
  }

  /**
   * Private method to update URL statistics
   * @param {Object} url - URL document
   * @param {boolean} isUnique - Whether this is a unique click
   */
  async _updateUrlStats(url, isUnique) {
    try {
      const updateData = {
        $inc: { clickCount: 1 },
        lastClickedAt: new Date(),
      };

      if (isUnique) {
        updateData.$inc.uniqueClicks = 1;
      }

      await URL_MODEL.findByIdAndUpdate(url._id, updateData);
    } catch (error) {
      console.error("URL stats update failed:", error);
    }
  }

  /**
   * Private method to update user statistics
   * @param {string} userId - User ID
   * @param {number} clickCount - Number of clicks to add
   */
  async _updateUserStats(userId, clickCount) {
    try {
      await User.findByIdAndUpdate(userId, {
        $inc: { totalClicks: clickCount },
      });
    } catch (error) {
      console.error("User stats update failed:", error);
    }
  }

  /**
   * Private method to extract campaign data from referrer
   * @param {string} referrer - Referrer URL
   * @returns {Object|null} Campaign data or null
   */
  _extractCampaignData(referrer) {
    try {
      const url = new URL(referrer);
      const params = url.searchParams;

      const campaignData = {};

      if (params.has("utm_source"))
        campaignData.source = params.get("utm_source");
      if (params.has("utm_medium"))
        campaignData.medium = params.get("utm_medium");
      if (params.has("utm_campaign"))
        campaignData.campaign = params.get("utm_campaign");
      if (params.has("utm_term")) campaignData.term = params.get("utm_term");
      if (params.has("utm_content"))
        campaignData.content = params.get("utm_content");

      return Object.keys(campaignData).length > 0 ? campaignData : null;
    } catch {
      return null;
    }
  }

  /**
   * Private method to get top referrers with additional processing
   * @param {string} urlId - URL document ID
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @returns {Promise<Array>} Top referrers with metadata
   */
  async _getTopReferrers(urlId, startDate, endDate) {
    try {
      const referrers = await Click.aggregate([
        {
          $match: {
            urlId: urlId,
            clickedAt: { $gte: startDate, $lte: endDate },
            referrer: { $exists: true, $ne: null },
            isBot: { $ne: true },
          },
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
      ]);

      // Add metadata to referrers
      return referrers.map((referrer) => {
        const domain = this._extractDomain(referrer._id);
        return {
          referrer: referrer._id,
          domain,
          count: referrer.count,
          type: this._classifyReferrer(domain),
        };
      });
    } catch (error) {
      console.error("Top referrers calculation failed:", error);
      return [];
    }
  }

  /**
   * Private method to extract domain from URL
   * @param {string} url - URL to extract domain from
   * @returns {string} Domain or 'Direct'
   */
  _extractDomain(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return "Direct";
    }
  }

  /**
   * Private method to classify referrer type
   * @param {string} domain - Domain to classify
   * @returns {string} Referrer type
   */
  _classifyReferrer(domain) {
    const searchEngines = [
      "google.com",
      "bing.com",
      "yahoo.com",
      "duckduckgo.com",
    ];
    const socialMedia = [
      "facebook.com",
      "twitter.com",
      "linkedin.com",
      "instagram.com",
    ];

    if (searchEngines.some((se) => domain.includes(se))) return "search";
    if (socialMedia.some((sm) => domain.includes(sm))) return "social";
    return "referral";
  }

  /**
   * Private method to calculate performance metrics
   * @param {Object} url - URL document
   * @param {Object} analytics - Analytics data
   * @returns {Promise<Object>} Performance metrics
   */
  async _calculatePerformanceMetrics(url, analytics) {
    const ageInDays = Math.floor(
      (Date.now() - url.createdAt) / (1000 * 60 * 60 * 24)
    );
    const totalClicks = analytics.overview.totalClicks;

    return {
      clicksPerDay:
        ageInDays > 0 ? Math.round((totalClicks / ageInDays) * 100) / 100 : 0,
      conversionRate:
        totalClicks > 0
          ? Math.round(
              (analytics.overview.uniqueClicks / totalClicks) * 10000
            ) / 100
          : 0,
      engagementScore: this._calculateEngagementScore(analytics),
      peakHour: this._findPeakHour(analytics.clicksByHour),
      trendDirection: this._calculateTrend(analytics.clicksByDay),
    };
  }

  /**
   * Private method to calculate engagement score
   * @param {Object} analytics - Analytics data
   * @returns {number} Engagement score (0-100)
   */
  _calculateEngagementScore(analytics) {
    const { totalClicks, uniqueClicks } = analytics.overview;
    const deviceDiversity = analytics.byDevice.length;
    const countryDiversity = analytics.byCountry.length;

    let score = 0;

    // Click volume (30 points max)
    score += Math.min(totalClicks / 100, 1) * 30;

    // Unique click ratio (25 points max)
    if (totalClicks > 0) {
      score += (uniqueClicks / totalClicks) * 25;
    }

    // Device diversity (25 points max)
    score += Math.min(deviceDiversity / 4, 1) * 25;

    // Geographic diversity (20 points max)
    score += Math.min(countryDiversity / 10, 1) * 20;

    return Math.round(score);
  }

  /**
   * Private method to find peak hour
   * @param {Array} clicksByHour - Clicks by hour data
   * @returns {number|null} Peak hour (0-23) or null
   */
  _findPeakHour(clicksByHour) {
    if (!clicksByHour || clicksByHour.length === 0) return null;

    let maxClicks = 0;
    let peakHour = null;

    clicksByHour.forEach((hourData) => {
      if (hourData.count > maxClicks) {
        maxClicks = hourData.count;
        peakHour = hourData._id;
      }
    });

    return peakHour;
  }

  /**
   * Private method to calculate trend direction
   * @param {Array} clicksByDay - Clicks by day data
   * @returns {string} Trend direction ('up', 'down', 'stable')
   */
  _calculateTrend(clicksByDay) {
    if (!clicksByDay || clicksByDay.length < 2) return "stable";

    const recent = clicksByDay.slice(-7); // Last 7 days
    const older = clicksByDay.slice(-14, -7); // Previous 7 days

    const recentAvg =
      recent.reduce((sum, day) => sum + day.count, 0) / recent.length;
    const olderAvg =
      older.reduce((sum, day) => sum + day.count, 0) / older.length;

    const change = ((recentAvg - olderAvg) / olderAvg) * 100;

    if (change > 10) return "up";
    if (change < -10) return "down";
    return "stable";
  }

  /**
   * Private method to get real-time URL stats
   * @param {string} urlId - URL document ID
   * @returns {Promise<Object>} Real-time statistics
   */
  async _getRealTimeUrlStats(urlId) {
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

      const [recentStats] = await Click.aggregate([
        {
          $match: {
            urlId: urlId,
            clickedAt: { $gte: oneHourAgo },
            isBot: { $ne: true },
          },
        },
        {
          $facet: {
            last5Minutes: [
              {
                $match: { clickedAt: { $gte: fiveMinutesAgo } },
              },
              {
                $count: "clicks",
              },
            ],
            lastHour: [
              {
                $count: "clicks",
              },
            ],
            activeCountries: [
              {
                $match: {
                  clickedAt: { $gte: fiveMinutesAgo },
                  "location.country": { $exists: true, $ne: null },
                },
              },
              {
                $group: {
                  _id: "$location.country",
                  count: { $sum: 1 },
                },
              },
            ],
          },
        },
      ]);

      return {
        clicksLast5Minutes: recentStats?.last5Minutes[0]?.clicks || 0,
        clicksLastHour: recentStats?.lastHour[0]?.clicks || 0,
        activeCountries: recentStats?.activeCountries || [],
        lastUpdated: new Date(),
      };
    } catch (error) {
      console.error("Real-time URL stats failed:", error);
      return {
        clicksLast5Minutes: 0,
        clicksLastHour: 0,
        activeCountries: [],
        lastUpdated: new Date(),
      };
    }
  }

  /**
   * Private method to get empty dashboard for users with no data
   * @param {string} userId - User ID
   * @returns {Object} Empty dashboard structure
   */
  _getEmptyDashboard(userId) {
    return {
      userId,
      overview: { totalClicks: 0, uniqueClicks: 0, uniqueVisitors: 0 },
      trends: [],
      geographic: { topCountries: [] },
      topUrls: [],
      recentActivity: [],
      dateRange: { startDate: new Date(), endDate: new Date() },
    };
  }

  /**
   * Private method to get recent user activity
   * @param {string} userId - User ID
   * @param {number} limit - Maximum number of activities
   * @returns {Promise<Array>} Recent activities
   */
  async _getRecentActivity(userId, limit = 10) {
    try {
      const userUrls = await URL_MODEL.find({ userId }).select("_id");
      const urlIds = userUrls.map((url) => url._id);

      if (urlIds.length === 0) return [];

      const recentClicks = await Click.find({
        urlId: { $in: urlIds },
        isBot: { $ne: true },
      })
        .sort({ clickedAt: -1 })
        .limit(limit)
        .populate("urlId", "shortUrl title originalUrl")
        .select("clickedAt location.country location.city device.type urlId")
        .lean();

      return recentClicks.map((click) => ({
        type: "click",
        timestamp: click.clickedAt,
        url: {
          shortUrl: click.urlId?.shortUrl,
          title: click.urlId?.title || click.urlId?.originalUrl,
        },
        location:
          click.location?.city && click.location?.country
            ? `${click.location.city}, ${click.location.country}`
            : click.location?.country || "Unknown",
        device: click.device?.type || "unknown",
      }));
    } catch (error) {
      console.error("Recent activity retrieval failed:", error);
      return [];
    }
  }

  /**
   * Private method to calculate platform growth metrics
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @returns {Promise<Object>} Growth metrics
   */
  async _calculateGrowthMetrics(startDate, endDate) {
    try {
      // Get user growth
      const userGrowth = await User.aggregate([
        {
          $facet: {
            total: [{ $count: "count" }],
            new: [
              {
                $match: { createdAt: { $gte: startDate, $lte: endDate } },
              },
              {
                $count: "count",
              },
            ],
            active: [
              {
                $match: {
                  lastLogin: { $gte: startDate, $lte: endDate },
                  isActive: true,
                },
              },
              {
                $count: "count",
              },
            ],
          },
        },
      ]);

      // Get URL growth
      const urlGrowth = await URL_MODEL.aggregate([
        // Исправлено: было URL
        {
          $facet: {
            total: [{ $count: "count" }],
            new: [
              {
                $match: { createdAt: { $gte: startDate, $lte: endDate } },
              },
              {
                $count: "count",
              },
            ],
          },
        },
      ]);

      // Get click growth
      const clickGrowth = await Click.aggregate([
        {
          $facet: {
            period: [
              {
                $match: {
                  clickedAt: { $gte: startDate, $lte: endDate },
                  isBot: { $ne: true },
                },
              },
              {
                $count: "count",
              },
            ],
          },
        },
      ]);

      return {
        users: {
          total: userGrowth[0]?.total[0]?.count || 0,
          new: userGrowth[0]?.new[0]?.count || 0,
          active: userGrowth[0]?.active[0]?.count || 0,
        },
        urls: {
          total: urlGrowth[0]?.total[0]?.count || 0,
          new: urlGrowth[0]?.new[0]?.count || 0,
        },
        clicks: {
          period: clickGrowth[0]?.period[0]?.count || 0,
        },
      };
    } catch (error) {
      console.error("Growth metrics calculation failed:", error);
      return {
        users: { total: 0, new: 0, active: 0 },
        urls: { total: 0, new: 0 },
        clicks: { period: 0 },
      };
    }
  }

  /**
   * Private method to calculate platform performance metrics
   * @returns {Promise<Object>} Performance metrics
   */
  async _calculatePlatformPerformance() {
    try {
      const [performance] = await Click.aggregate([
        {
          $match: {
            clickedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // Last 24 hours
            isBot: { $ne: true },
          },
        },
        {
          $group: {
            _id: null,
            totalClicks: { $sum: 1 },
            averageLoadTime: { $avg: "$loadTime" },
            uniqueVisitors: { $addToSet: "$ipAddress" },
            topHour: { $push: { hour: { $hour: "$clickedAt" } } },
          },
        },
        {
          $project: {
            totalClicks: 1,
            averageLoadTime: 1,
            uniqueVisitors: { $size: "$uniqueVisitors" },
            clicksPerHour: { $divide: ["$totalClicks", 24] },
          },
        },
      ]);

      return (
        performance || {
          totalClicks: 0,
          averageLoadTime: 0,
          uniqueVisitors: 0,
          clicksPerHour: 0,
        }
      );
    } catch (error) {
      console.error("Platform performance calculation failed:", error);
      return {
        totalClicks: 0,
        averageLoadTime: 0,
        uniqueVisitors: 0,
        clicksPerHour: 0,
      };
    }
  }

  /**
   * Private method to generate chart data for reports
   * @param {Object} reportData - Report data
   * @param {string} type - Report type
   * @returns {Promise<Object>} Chart configuration data
   */
  async _generateChartData(reportData, type) {
    try {
      const charts = {};

      if (type === "url" || type === "user") {
        // Clicks over time chart
        charts.clicksOverTime = {
          type: "line",
          data: reportData.trends || [],
          xAxis: "date",
          yAxis: "clicks",
          title: "Clicks Over Time",
        };

        // Geographic distribution chart
        if (reportData.geographic?.topCountries) {
          charts.geographicDistribution = {
            type: "bar",
            data: reportData.geographic.topCountries,
            xAxis: "countryName",
            yAxis: "count",
            title: "Top Countries",
          };
        }

        // Device distribution chart
        if (reportData.technology?.byDevice) {
          charts.deviceDistribution = {
            type: "pie",
            data: reportData.technology.byDevice,
            label: "_id",
            value: "count",
            title: "Device Types",
          };
        }
      }

      if (type === "platform") {
        // Growth trends
        charts.growthTrends = {
          type: "multi-line",
          data: reportData.trends,
          title: "Platform Growth",
        };
      }

      return charts;
    } catch (error) {
      console.error("Chart data generation failed:", error);
      return {};
    }
  }

  /**
   * Private method to get currently active URLs
   * @param {number} minutes - Time window in minutes
   * @param {string} userId - User ID (optional)
   * @returns {Promise<Array>} Active URLs
   */
  async _getActiveUrls(minutes, userId = null) {
    try {
      const timeThreshold = new Date(Date.now() - minutes * 60 * 1000);

      const matchStage = {
        clickedAt: { $gte: timeThreshold },
        isBot: { $ne: true },
      };

      // Add user filter if provided
      const pipeline = [
        { $match: matchStage },
        {
          $group: {
            _id: "$urlId",
            clickCount: { $sum: 1 },
            uniqueVisitors: { $addToSet: "$ipAddress" },
            lastClick: { $max: "$clickedAt" },
          },
        },
        {
          $lookup: {
            from: "urls",
            localField: "_id",
            foreignField: "_id",
            as: "url",
          },
        },
        {
          $unwind: "$url",
        },
      ];

      // Add user filter to lookup if provided
      if (userId) {
        pipeline.push({
          $match: { "url.userId": userId },
        });
      }

      pipeline.push(
        {
          $project: {
            shortUrl: "$url.shortUrl",
            title: "$url.title",
            clickCount: 1,
            uniqueVisitors: { $size: "$uniqueVisitors" },
            lastClick: 1,
          },
        },
        { $sort: { clickCount: -1 } },
        { $limit: 10 }
      );

      return await Click.aggregate(pipeline);
    } catch (error) {
      console.error("Active URLs retrieval failed:", error);
      return [];
    }
  }

  /**
   * Private method to estimate live visitors
   * @param {number} minutes - Time window for "live" definition
   * @returns {Promise<number>} Estimated live visitor count
   */
  async _estimateLiveVisitors(minutes = 10) {
    try {
      const timeThreshold = new Date(Date.now() - minutes * 60 * 1000);

      const [result] = await Click.aggregate([
        {
          $match: {
            clickedAt: { $gte: timeThreshold },
            isBot: { $ne: true },
          },
        },
        {
          $group: {
            _id: null,
            uniqueVisitors: { $addToSet: "$ipAddress" },
          },
        },
        {
          $project: {
            count: { $size: "$uniqueVisitors" },
          },
        },
      ]);

      return result?.count || 0;
    } catch (error) {
      console.error("Live visitors estimation failed:", error);
      return 0;
    }
  }

  /**
   * Clean up old analytics data based on retention policy
   * @param {Object} options - Cleanup options
   * @returns {Promise<Object>} Cleanup results
   * @throws {Error} If cleanup fails
   */
  async cleanupAnalyticsData(options = {}) {
    try {
      const { retentionDays = 365, batchSize = 1000, dryRun = false } = options;

      const cutoffDate = new Date(
        Date.now() - retentionDays * 24 * 60 * 60 * 1000
      );

      if (dryRun) {
        // Count records that would be deleted
        const count = await Click.countDocuments({
          clickedAt: { $lt: cutoffDate },
        });

        return {
          dryRun: true,
          recordsToDelete: count,
          cutoffDate,
          retentionDays,
        };
      }

      // Delete old records in batches
      let totalDeleted = 0;
      let hasMore = true;

      while (hasMore) {
        const result = await Click.deleteMany(
          { clickedAt: { $lt: cutoffDate } },
          { limit: batchSize }
        );

        totalDeleted += result.deletedCount;
        hasMore = result.deletedCount === batchSize;

        // Small delay between batches to avoid overwhelming the database
        if (hasMore) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      return {
        success: true,
        deletedCount: totalDeleted,
        cutoffDate,
        retentionDays,
        cleanupDate: new Date(),
      };
    } catch (error) {
      throw new Error(`Analytics data cleanup failed: ${error.message}`);
    }
  }
}

export default new AnalyticsService();
