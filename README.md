# Zammad-with-licenseZammad Docker Compose Setup (with License Gate)
Zammad is now gated the same way your Zabbix stack is: license-proxy sits in front of zammad-nginx and only proxies traffic through when your license server says the license is valid. license-agent polls the license server in the background, stops/starts zammad-railsserver if the license goes invalid, and reports usage (agent count, ticket count) back to the license server.

Zammad is now reachable at: http://localhost:8082 — same port as before, but it's now served by license-proxy instead of zammad-nginx directly.

1. Create data directories
mkdir -p data/storage data/backup data/elasticsearch data/postgres data/redis
2. (Linux only) fix Elasticsearch data dir permissions
sudo chown -R 1000:1000 data/elasticsearch
sudo sysctl -w vm.max_map_count=262144
3. Set your license key
Edit license/license.lic and replace the two placeholder lines with your real license key and instance ID (same format as the Zabbix license.lic):

<your-license-key>
<your-instance-id>
4. Set your Zammad API token (for usage reporting)
license-agent needs an admin API token to count agents/tickets. In Zammad: Admin → API → Token Access, create a token with read access, then export it before starting the stack:

export ZAMMAD_API_TOKEN="your-token-here"
Or put it in a .env file next to docker-compose.yml:

ZAMMAD_API_TOKEN=your-token-here
Note: the token can only be generated after Zammad has finished its initial setup wizard once (see step 5), so the first docker compose up can run without it — license-agent will just log a warning and report zero usage until the token is set.

5. Start the stack
docker compose up -d
6. Watch startup logs
docker compose logs -f zammad-init zammad-railsserver license-proxy license-agent
Then open http://localhost:8082 in your browser. If the license is invalid or missing, you'll see the same "License Expired or Invalid" page used by the Zabbix stack instead of the Zammad UI.

How it works
license-proxy (port 8082 → 3333) checks the license on every request against the license server, then proxies through to zammad-nginx:8080 internally. zammad-nginx no longer has a published host port, so it can't be reached except through the proxy.
license-agent runs a loop every 10 minutes: re-checks the license, starts/stops the zammad-railsserver container accordingly, and pushes usage stats (agent count, ticket count) to the license server's /usage endpoint, tagged product: "zammad" so it's distinguishable from the Zabbix usage data on the same
