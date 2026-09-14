#!/usr/bin/env node

import fs from "fs/promises";
import fetch from "node-fetch";
import { exec } from "child_process";

/* =====================================================
   CONFIG
   ===================================================== */

// This lives inside the container -> matches the volume mount in docker-compose.yml
const LICENSE_PATH = "/app/license.lic";

/**
 * Same license server used by the Zabbix stack.
 * If Zammad has its own license key/product id, just make sure
 * license.lic below contains the Zammad-specific key + instanceId.
 */
const LICENSE_API_BASE =
  "https://f3tigq2rmb74psnp6nafqqg54i0kysrw.lambda-url.ap-south-1.on.aws/backend_api/check-license";

const ZAMMAD_CONTAINER = "zammad-railsserver";

// Zammad's REST API, reached over the internal docker network via nginx
const ZAMMAD_URL = "http://zammad-nginx:8080";
const ZAMMAD_API_TOKEN = process.env.ZAMMAD_API_TOKEN || "";

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const STARTUP_DELAY_MS = 60 * 1000;       // 1 minute

/* =====================================================
   HELPERS
   ===================================================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function docker(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (_, stdout) => resolve(stdout?.trim() || null));
  });
}

/* =====================================================
   DOCKER CONTROL
   ===================================================== */

async function controlZammad(shouldRun) {
  const running = await docker(
    `docker ps --filter "name=${ZAMMAD_CONTAINER}" --filter "status=running" --format "{{.Names}}"`
  );

  if (shouldRun && running === ZAMMAD_CONTAINER) return;
  if (!shouldRun && running !== ZAMMAD_CONTAINER) return;

  await docker(`docker ${shouldRun ? "start" : "stop"} ${ZAMMAD_CONTAINER}`);
}

/* =====================================================
   ZAMMAD USAGE DATA
   ===================================================== */

async function fetchZammadData() {
  if (!ZAMMAD_API_TOKEN) {
    console.error("⚠️  ZAMMAD_API_TOKEN not set — skipping usage lookup");
    return { agentCount: 0, ticketCount: 0 };
  }

  const authHeader = { Authorization: `Token token=${ZAMMAD_API_TOKEN}` };

  try {
    // 1) Agent count (users with the "Agent" role)
    const usersRes = await fetch(`${ZAMMAD_URL}/api/v1/users?per_page=200`, {
      headers: authHeader
    });
    const users = await usersRes.json();
    const agentCount = Array.isArray(users)
      ? users.filter((u) => (u.role_ids || []).length > 0 && u.active).length
      : 0;

    // 2) Ticket count
    const ticketsRes = await fetch(
      `${ZAMMAD_URL}/api/v1/tickets/search?query=*&limit=1`,
      { headers: authHeader }
    );
    const ticketsJson = await ticketsRes.json();
    const ticketCount = ticketsJson.tickets_count ?? 0;

    return { agentCount, ticketCount };
  } catch (err) {
    console.error("❌ Failed to fetch Zammad data:", err.message || err);
    return { agentCount: 0, ticketCount: 0 };
  }
}

/* =====================================================
   LICENSE CHECK
   ===================================================== */

async function checkLicense() {
  let content;

  try {
    content = (await fs.readFile(LICENSE_PATH, "utf-8")).trim();
  } catch {
    console.error("❌ license.lic not found");
    await controlZammad(false);
    return null;
  }

  const [licenseKey, instanceId] = content.split("\n");

  if (!licenseKey || !instanceId) {
    console.error("❌ license.lic invalid");
    await controlZammad(false);
    return null;
  }

  const res = await fetch(`${LICENSE_API_BASE}/${licenseKey}`);
  const data = await res.json();

  if (!res.ok || !data.valid) {
    console.error("❌ License invalid or expired");
    await controlZammad(false);
    return null;
  }

  await controlZammad(true);

  return { licenseKey, instanceId };
}

/* =====================================================
   MAIN LOOP
   ===================================================== */

(async function main() {
  console.log("🚀 License agent started (Zammad)");
  await sleep(STARTUP_DELAY_MS);

  while (true) {
    const lic = await checkLicense();
    if (!lic) process.exit(1);

    const usage = await fetchZammadData();

    console.log(`✅ Agents: ${usage.agentCount}`);
    console.log(`✅ Tickets: ${usage.ticketCount}`);

    const res = await fetch(`${LICENSE_API_BASE}/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseKey: lic.licenseKey,
        instanceId: lic.instanceId,
        product: "zammad",
        agentCount: usage.agentCount,
        ticketCount: usage.ticketCount
      })
    });

    if (!res.ok) {
      console.error("❌ Failed to push usage data:", res.status);
    } else {
      console.log("✅ Usage data pushed");
    }

    await sleep(CHECK_INTERVAL_MS);
  }
})();
