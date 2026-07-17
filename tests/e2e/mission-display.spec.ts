import { expect, test, type Page, type APIRequestContext } from "@playwright/test";

const fakeOrigin = "http://127.0.0.1:18021";

async function scenario(request: APIRequestContext, name: string) {
  const response = await request.post(`${fakeOrigin}/__test__/scenario/${name}`);
  expect(response.ok()).toBeTruthy();
}

async function expectNoDocumentOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

async function waitForLive(page: Page) {
  await expect(page.locator(".nav-status")).toContainText("LIVE");
}

test.beforeEach(async ({ request }) => {
  await scenario(request, "nominal_ascent");
});

test("fake backend integrates through REST proxies and validates all five data surfaces", async ({ request }) => {
  const telemetry = await request.get("/api/telemetry?mission_profile=EARTH_ORBIT");
  expect(telemetry.ok()).toBeTruthy();
  expect(telemetry.headers()["x-kmd-telemetry-source"]).toBe("krpc");
  expect((await telemetry.json()).source).toBe("krpc");

  const stages = await request.get("/api/vehicle-stages");
  expect(stages.ok()).toBeTruthy();
  expect((await stages.json()).stages).toHaveLength(2);

  const planner = await request.get("/api/planner/geo?target_longitude_deg=110&tolerance_deg=0.1&node_filter=DN&max_nodes=3");
  expect(planner.ok()).toBeTruthy();
  const plan = await planner.json();
  expect(plan.ready).toBe(true);
  expect(plan.candidates).toHaveLength(3);
  expect(plan.candidates.every((candidate: { node: string }) => candidate.node === "DN")).toBe(true);

  const sso = await request.get("/api/planner/sso?solve_for=INCLINATION&altitude_km=600&eccentricity=0&ltan=10%3A30&multibody_enabled=true");
  expect(sso.ok()).toBeTruthy();
  const ssoPlan = await sso.json();
  expect(ssoPlan.ready).toBe(true);
  expect(ssoPlan.model).toBe("J2_SECULAR_FIRST_ORDER");
  expect(ssoPlan.selected.inclination_rad * 180 / Math.PI).toBeGreaterThan(97);
  expect(ssoPlan.selected.inclination_rad * 180 / Math.PI).toBeLessThan(99);
  expect(ssoPlan.selected.nodal_precession_deg_day).toBeCloseTo(ssoPlan.selected.target_precession_deg_day, 8);
});

test("mission editor buttons add, reorder, delete, toggle fairing and persist the mission", async ({ page }) => {
  await page.goto("/mission-setup");
  await waitForLive(page);

  const stageNames = page.getByLabel(/第 \d+ 级名称/);
  await expect(stageNames).toHaveCount(3);
  await page.getByRole("button", { name: "+ ADD FLIGHT ELEMENT" }).click();
  await expect(stageNames).toHaveCount(4);
  await page.getByLabel("第 4 级名称").fill("TEST KICK STAGE");
  await page.getByRole("button", { name: "上移 TEST KICK STAGE" }).click();
  await expect(page.getByLabel("第 3 级名称")).toHaveValue("TEST KICK STAGE");

  const fairing = page.getByRole("checkbox", { name: "PAYLOAD FAIRING" });
  await fairing.uncheck();
  await expect(page.getByLabel("EVENT NAME")).toBeDisabled();
  await fairing.check();
  await expect(page.getByLabel("EVENT NAME")).toBeEnabled();

  await page.getByRole("button", { name: "删除 TEST KICK STAGE" }).click();
  await expect(stageNames).toHaveCount(3);

  await page.getByLabel("MISSION NAME").fill("X".repeat(200));
  await expect(page.getByLabel("MISSION NAME")).toHaveValue("X".repeat(96));
  await page.getByLabel("MISSION NAME").fill("INTEGRATION FLIGHT 01");
  await page.getByLabel("VEHICLE NAME").fill("AUTOMATED TEST LAUNCH VEHICLE");
  await page.getByRole("button", { name: /CREATE MISSION/ }).click();
  await expect(page).toHaveURL(/\/display$/);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("kmd.active-mission.v1") ?? "null"));
  expect(saved.name).toBe("INTEGRATION FLIGHT 01");
  expect(saved.vehicleName).toBe("AUTOMATED TEST LAUNCH VEHICLE");
  expect(saved.stages).toHaveLength(3);
});

test("auto-detect consumes fake craft data and long labels cannot break desktop or mobile layout", async ({ page, request }) => {
  await scenario(request, "long_labels");
  await page.goto("/mission-setup");
  await waitForLive(page);
  await page.getByRole("button", { name: "AUTO-DETECT FROM KRPC" }).click();
  await expect(page.getByText("CRAFT INFERENCE")).toBeVisible();
  await expect(page.getByLabel("第 1 级名称")).toHaveValue(/WITH-AN-INTENTIONALLY-LONG-DESIGNATION/);
  await expectNoDocumentOverflow(page);

  await page.getByRole("button", { name: /CREATE MISSION/ }).click();
  await expect(page.locator(".broadcast-title h1")).toContainText("超長名称試験機体");
  await expectNoDocumentOverflow(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoDocumentOverflow(page);
  const titleBox = await page.locator(".broadcast-title h1").boundingBox();
  expect(titleBox?.width ?? 0).toBeLessThanOrEqual(390);
});

test("50 Hz WebSocket display switches speed frame at 100 km and retains Max-Q", async ({ page, request }) => {
  await page.goto("/display");
  await waitForLive(page);
  await expect(page.getByText("SURFACE SPEED", { exact: true })).toBeVisible();
  await expect(page.getByText(/PEAK 12\.64 kPa/)).toBeVisible();

  await scenario(request, "high_altitude");
  await expect(page.getByText("INERTIAL SPEED", { exact: true })).toBeVisible();
  await expect(page.locator(".broadcast-title > span")).toContainText("ORBITING");
});

test("null, extreme and malformed telemetry never render NaN/Infinity or crash the page", async ({ page, request }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await scenario(request, "null_values");
  await page.goto("/display");
  await waitForLive(page);
  await expect(page.locator(".broadcast-telemetry")).toContainText("—");

  await scenario(request, "numeric_extremes");
  await expect(page.locator(".met-display time")).toHaveText("DATE OUT OF RANGE");
  await expect(page.locator("body")).not.toContainText(/NaN|Infinity/);
  await expectNoDocumentOverflow(page);

  await scenario(request, "malformed");
  await page.waitForTimeout(300);
  await expect(page.locator("main")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("FDO consumes the fake high-rate feed and survives extreme display values", async ({ page, request }) => {
  await page.goto("/fdo");
  await waitForLive(page);
  await expect(page.getByRole("heading", { name: "ASCENT OPERATIONS" })).toBeVisible();
  await expect(page.getByText("SURFACE SPEED", { exact: true })).toBeVisible();
  await expect(page.getByText("CURRENT TRAJECTORY", { exact: true })).toBeVisible();

  await scenario(request, "high_altitude");
  await expect(page.getByText("INERTIAL SPEED", { exact: true })).toBeVisible();
  await scenario(request, "numeric_extremes");
  await expect(page.locator("body")).not.toContainText(/NaN|Infinity/);
  await expectNoDocumentOverflow(page);
});

test("WebSocket disconnect falls back visibly and recovers to LIVE", async ({ page, request }) => {
  await page.goto("/display");
  await waitForLive(page);
  await scenario(request, "disconnected");
  await expect(page.locator(".nav-status")).toContainText("SIMULATION");
  await expect(page.locator(".display-phase-panel")).toContainText("FALLBACK");

  await scenario(request, "nominal_ascent");
  await waitForLive(page);
  await expect(page.locator(".display-phase-panel")).toContainText("LIVE");
});

test("malformed localStorage mission is rejected instead of crashing display", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("kmd.active-mission.v1", JSON.stringify({ schemaVersion: 1, id: "broken" }));
  });
  await page.goto("/display");
  await waitForLive(page);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator(".broadcast-title p")).toContainText("EARTH_ORBIT");
});

test("planner profile, node filter, candidate selection and HOLD state buttons work", async ({ page, request }) => {
  await page.goto("/mission-planner");
  await expect(page.locator(".candidate-table > button")).toHaveCount(4);
  await page.getByRole("button", { name: "DN", exact: true }).click();
  await expect(page.locator(".candidate-table > button b")).toHaveCount(4);
  await expect(page.locator(".candidate-table > button b")).toHaveText(["DN", "DN", "DN", "DN"]);
  await page.locator(".candidate-table > button").nth(1).click();
  await expect(page.locator(".selected-solution h2")).toContainText("DN-01");

  await page.getByRole("button", { name: /TLI\s+月球相位/ }).click();
  await expect(page.getByRole("heading", { name: "TRANS-LUNAR INJECTION" })).toBeVisible();
  await page.getByRole("button", { name: /SSO\s+J2 进动/ }).click();
  await expect(page.getByRole("heading", { name: "SUN-SYNCHRONOUS ORBIT" })).toBeVisible();
  await expect(page.getByText("MULTIBODY MODEL REQUIRED")).toBeVisible();
  await page.getByRole("button", { name: /TWO-BODY \/ HOLD/ }).click();
  await expect(page.getByText("J2 MATCH")).toBeVisible();
  await expect(page.locator(".selected-solution .solution-hero > strong")).toContainText("°");
  await page.getByRole("button", { name: /GEO SLOT\s+地固经度/ }).click();
  await expect(page.getByRole("heading", { name: "GEO SLOT INSERTION" })).toBeVisible();

  await scenario(request, "planner_hold");
  await page.getByLabel("目标东经").fill("111");
  await expect(page.getByText("TRAJECTORY SOLVER HOLD")).toBeVisible();
  await expect(page.locator(".candidate-table > button")).toHaveCount(0);
});

test("SSO request timeout releases SOLVING and shows a transient SPA notification", async ({ page }) => {
  await page.route("**/api/planner/sso?**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await route.abort("timedout");
  });
  await page.goto("/mission-planner");
  await page.getByRole("button", { name: /SSO\s+J2 进动/ }).click();

  const notice = page.locator("[data-sonner-toast]").filter({ hasText: "SSO SOLVER TIMEOUT" });
  await expect(notice).toBeVisible({ timeout: 7_000 });
  await expect(notice).toContainText("计算超过 5 秒");
  await expect(page.getByText("SOLVING", { exact: true })).toHaveCount(0);
  await expect(notice).toBeHidden({ timeout: 6_000 });
});

test("stage inference failure is visible and does not destroy the editable stack", async ({ page, request }) => {
  await scenario(request, "stage_error");
  await page.goto("/mission-setup");
  const before = await page.getByLabel(/第 \d+ 级名称/).count();
  await page.getByRole("button", { name: "AUTO-DETECT FROM KRPC" }).click();
  await expect(page.getByText("AUTO-DETECT FAILED")).toBeVisible();
  await expect(page.getByLabel(/第 \d+ 级名称/)).toHaveCount(before);
});
