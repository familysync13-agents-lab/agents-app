import { describe, expect, it } from "vitest";
import { GET } from "@/app/auth/preview/route";

describe("gate preview sign-in", () => {
  it("does not exist outside APP_ENV=preview", async () => {
    for (const env of [undefined, "production", "test", "Preview", "preview "]) {
      if (env === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = env;
      const r = await GET();
      expect(r.status).toBe(404);
      expect(r.headers.get("set-cookie")).toBeNull();
    }
  });
});
