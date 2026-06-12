/**
 * Placeholder landing page. UI is intentionally minimal this step — the wiring
 * that matters is the two API routes under /api. A later step builds the search
 * UI that POSTs a question to /api/agent and fetches PHI rows from /api/results
 * with the returned query_id.
 */
export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-xl font-semibold">Claims Search</h1>
      <p className="mt-2 text-sm opacity-80">
        Phase 4 transport scaffold. API routes:
      </p>
      <ul className="mt-2 list-disc pl-5 text-sm">
        <li>
          <code>POST /api/agent</code> — natural-language question → query function (non-PHI summary)
        </li>
        <li>
          <code>POST /api/results</code> — query_id → PHI rows (authenticated)
        </li>
      </ul>
      <p className="mt-4 text-xs opacity-60">
        Both routes require <code>Authorization: Bearer &lt;RESULTS_API_SECRET&gt;</code>. PHI never
        appears in the agent response.
      </p>
    </main>
  );
}
