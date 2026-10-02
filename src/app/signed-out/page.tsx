export const metadata = { title: "Signed out" };

export default function SignedOut() {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="max-w-md rounded-2xl border border-line bg-panel p-8 text-center">
        <h1 className="text-xl font-semibold">Agents is locked</h1>
        <p className="mt-3 text-sm text-ink-2">
          This control plane only opens through a one-time link from the Agents daemon on your Mac. Ask the orchestrator to open it for you.
        </p>
      </div>
    </main>
  );
}
