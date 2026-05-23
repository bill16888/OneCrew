/**
 * Placeholder landing page for the workspace skeleton.
 *
 * The real workspace shell (sidebar + channels + kanban) is wired up in
 * task 2.x. For now we just confirm the dark-theme tokens render.
 */
export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 py-16">
      <span className="ai-badge">AI</span>
      <h1 className="text-3xl font-semibold tracking-tight">AI-Native Team Workspace</h1>
      <p className="max-w-md text-center text-sm text-muted-foreground">
        Skeleton scaffolded. Channels, kanban, approvals, and the agentic loop are
        implemented in subsequent tasks.
      </p>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-block h-3 w-3 rounded-sm bg-primary" /> Indigo #6366F1
        <span className="inline-block h-3 w-3 rounded-sm bg-ai" /> AI #A855F7
        <span className="inline-block h-3 w-8 rounded-sm bg-ai-gradient" /> AI gradient
      </div>
    </main>
  );
}
