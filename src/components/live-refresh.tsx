"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const CLIENT_BUILD = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";

/** A form the owner is filling in (text typed, choice made) - never reloaded underneath the owner. */
function ownerIsEditing(): boolean {
  for (const el of Array.from(document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("textarea, input:not([type]), input[type=text]")))
    if (el.value.trim() !== "") return true;
  return !!document.querySelector("form[data-dirty='true']");
}

/**
 * Re-reads authoritative state from the server periodically (no client-side simulation), and detects a redeploy: when the server's
 * build differs from this page's build, the page reloads itself automatically unless the owner is typing, in which case a banner asks
 * for a reload (a stale page's buttons would otherwise fail silently - V0 finding B-5).
 */
export function LiveRefresh({ seconds = 5 }: { seconds?: number }) {
  const router = useRouter();
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let alive = true;
    const t = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch("/api/v0/version", { cache: "no-store" });
        const { build } = (await r.json()) as { build: string };
        if (!alive) return;
        if (build !== CLIENT_BUILD && CLIENT_BUILD !== "dev") {
          if (!ownerIsEditing()) window.location.reload();
          else setStale(true);
          return;
        }
      } catch {
        /* server restarting: try again next tick */
      }
      router.refresh();
    }, seconds * 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [router, seconds]);
  if (!stale) return null;
  return (
    <div role="status" className="fixed inset-x-0 bottom-4 z-50 mx-auto w-fit rounded-full border border-warn/40 bg-panel px-4 py-2 text-sm text-warn shadow-lg">
      A new version of Agents App is running.{" "}
      <button className="underline" onClick={() => window.location.reload()}>
        Reload
      </button>{" "}
      when you have finished typing.
    </div>
  );
}
