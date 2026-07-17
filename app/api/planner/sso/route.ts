export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const backendUrl = process.env.KMD_BACKEND_URL ?? "http://127.0.0.1:8021";
  const query = new URLSearchParams();
  for (const key of [
    "solve_for",
    "altitude_km",
    "inclination_deg",
    "eccentricity",
    "ltan",
    "multibody_enabled",
    "mu_km3_s2",
    "equatorial_radius_km",
    "j2",
    "tropical_year_days",
  ]) {
    const value = requestUrl.searchParams.get(key);
    if (value != null) query.set(key, value);
  }

  try {
    const response = await fetch(`${backendUrl}/v1/planner/sso?${query.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4_500),
    });
    const body = await response.json();
    return Response.json(body, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return Response.json(
      { detail: timedOut ? "SSO solver did not respond within 4.5 seconds" : error instanceof Error ? error.message : "SSO planner backend unavailable" },
      { status: timedOut ? 504 : 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
