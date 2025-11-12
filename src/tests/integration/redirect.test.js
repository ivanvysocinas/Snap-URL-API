import request from "supertest";
import app from "../../server.js";
import { TestHelper } from "../helpers/testHelpers.js";

describe("Redirect Routes", () => {
  let testUser, testUrl;

  beforeEach(async () => {
    const userData = await TestHelper.createTestUser();
    testUser = userData.user;
    testUrl = await TestHelper.createTestUrl(testUser._id, {
      shortCode: "redirect123",
      originalUrl: "https://example.com",
    });
  });

  describe("GET /:shortCode", () => {
    it("should redirect to original URL", async () => {
      const response = await request(app).get("/redirect123").expect(302);

      expect(response.headers.location).toBe("https://example.com");
    });

    it("should return 404 for non-existent short code", async () => {
      const response = await request(app).get("/nonexistent").expect(404);

      expect(response.body.success).toBe(false);
    });

    it("should return 404 for expired URL", async () => {
      const expiredUrl = await TestHelper.createTestUrl(testUser._id, {
        shortCode: "expired123",
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // Expired yesterday
      });

      const response = await request(app).get("/expired123").expect(404);

      expect(response.body.success).toBe(false);
    });

    it("should return 404 for inactive URL", async () => {
      const inactiveUrl = await TestHelper.createTestUrl(testUser._id, {
        shortCode: "inactive123",
        isActive: false,
      });

      const response = await request(app).get("/inactive123").expect(404);

      expect(response.body.success).toBe(false);
    });
  });

  describe("GET /preview/:shortCode", () => {
    it("should return URL preview", async () => {
      const response = await request(app)
        .get("/preview/redirect123")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.originalUrl).toBe("https://example.com");
      expect(response.body.data.shortCode).toBe("redirect123");
    });

    it("should return 404 for non-existent URL", async () => {
      const response = await request(app)
        .get("/preview/nonexistent")
        .expect(404);

      expect(response.body.success).toBe(false);
    });
  });

  describe("GET /:shortCode/stats", () => {
    beforeEach(async () => {
      // Create some clicks for stats
      await TestHelper.createTestClick(testUrl._id);
      await TestHelper.createTestClick(testUrl._id);
    });

    it("should return public stats", async () => {
      const response = await request(app).get("/redirect123/stats").expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.totalClicks).toBeGreaterThan(0);
    });
  });

  describe("GET /:shortCode/track", () => {
    it("should redirect with enhanced tracking", async () => {
      const response = await request(app)
        .get("/redirect123/track")
        .set("User-Agent", "Mozilla/5.0 (Test Browser)")
        .set("X-Forwarded-For", "192.168.1.1");

      expect(response.status).toBe(302);

      expect(response.headers.location).toBe("https://example.com/");
    });
  });

  describe("GET /qr/:shortCode", () => {
    it("should redirect from QR code", async () => {
      const response = await request(app).get("/qr/redirect123").expect(302);

      expect(response.headers.location).toBe("https://example.com");
    });
  });

  describe("POST /validate-batch", () => {
    beforeEach(async () => {
      await TestHelper.createTestUrl(testUser._id, {
        shortCode: "valid1",
      });
      await TestHelper.createTestUrl(testUser._id, {
        shortCode: "valid2",
      });
    });

    it("should validate multiple short codes", async () => {
      const response = await request(app)
        .post("/validate-batch")
        .send({
          shortCodes: ["valid1", "valid2", "invalid"],
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.results).toHaveLength(3);
    });

    it("should limit batch size", async () => {
      const shortCodes = Array(51)
        .fill()
        .map((_, i) => `test${i}`);

      const response = await request(app)
        .post("/validate-batch")
        .send({ shortCodes })
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });
});
