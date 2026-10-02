import { describe, expect, it } from "vitest";
import { adminActions, intentProposals, tasks } from "@/db/schema";
import { acceptProposals, declineProposal, proposeIntent } from "@/server/proposals";
import { setup } from "./support/harness";

describe("proposed work", () => {
  it("never starts work by itself; the owner's selection turns proposals into tasks", async () => {
    const { db } = await setup();
    const a = await proposeIntent(db, "operator", { project: "reading-lists", title: "Fix sort control order", intent: "Keyboard users should reach the Sort control before the list of books it sorts.", rationale: "V0 backlog B-1 (accessibility)", source: "V0 review B-1" });
    const b = await proposeIntent(db, "operator", { project: "reading-lists", title: "Descriptions", intent: "Owners can add an optional description to a list, shown on its page.", rationale: "Owner-visible value, small scope", source: "operator" });
    expect(await db.select().from(tasks)).toEqual([]);
    const started = await acceptProposals(db, [a.id]);
    await declineProposal(db, b.id);
    expect(started.length).toBe(1);
    const ps = await db.select().from(intentProposals).orderBy(intentProposals.id);
    expect(ps.map((p) => p.status)).toEqual(["accepted", "declined"]);
    expect((await db.select().from(tasks))[0]!.title).toBe("Fix sort control order");
    expect((await db.select().from(adminActions)).map((x) => x.op)).toEqual(["propose_intent", "propose_intent"]);
    await expect(proposeIntent(db, "operator", { project: "nope", title: "x", intent: "y", rationale: "z", source: "s" })).rejects.toThrow();
  });
});
