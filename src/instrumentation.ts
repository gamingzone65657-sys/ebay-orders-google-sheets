/**
 * Next.js calls this once per server process, before the first request.
 *
 * Used only to surface configuration problems at boot. It deliberately does
 * not throw: refusing to start would turn a missing warning-level variable
 * into an outage, and the checks that genuinely must hold (token encryption,
 * authentication) already fail closed at the point of use.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { reportProductionReadiness } = await import("@/lib/production-check");
  reportProductionReadiness();
}
