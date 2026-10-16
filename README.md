# TURBO PITCH

A browser car-soccer game in a single page (`index.html`), with physics ported from RocketSim.
Play against bots or free play from any copy of the file. LAN play (friends on other computers)
needs the website version described below.

## Putting it online with LAN play (Cloudflare)

LAN play uses a small Cloudflare Worker that ships in this repo (`worker/index.js`, configured by
`wrangler.jsonc`). It serves the game from `public/index.html` and gives every 6-digit game code a
"room" on the same website. Because everything goes through the game's own site, it works on
school or office Wi-Fi that blocks other services. When the computers can reach each other directly,
the game connects directly. When they can't, the website relays the game traffic.

**One-time setup (no command line needed):**

1. Sign in at <https://dash.cloudflare.com> and open **Workers & Pages**.
2. Choose **Create** → **Workers** → **Import a repository** and connect your GitHub account if asked.
3. Pick this repository. Set the branch to the one with the latest game. Leave the build command
   empty and keep the deploy command as `npx wrangler deploy`. Then press **Deploy**.
4. When it finishes you get a link like `https://turbo-pitch.<your-name>.workers.dev`. Open that link
   on every computer. Under **Settings → Domains & Routes** you can also add your own domain.

After this, every push to that branch redeploys the site by itself. The Worker and its Durable
Object rooms run on Cloudflare's free plan.

A site that only hosts `index.html` (for example a Cloudflare Pages upload) can still run the game,
but not LAN play. The LAN screen will say "Network play isn't set up on this website yet".

**From a terminal instead:** `npx wrangler login`, then `npx wrangler deploy`.

## How LAN play works

- **Host:** **Play LAN › Host game** opens a room and shows a 6-digit code.
- **Joiners:** **Play LAN › Join game**, then type the code.
- **Who runs the match:** the host's computer runs the match, including the bots. Joiners send their
  controls and draw the host's game.
- **How it connects:** for each joiner the host tries a direct WebRTC connection for 4 seconds. If
  that doesn't open, which is normal on school Wi-Fi, the game goes through the website's room.
  The lobby shows which one each player got: **Direct** or **Via website**.
- **Free plan budget:** relayed play uses the Worker's free daily allowance of Durable Object
  requests. Roughly several hours of 1v1 a day; bigger lobbies use it faster. Direct connections
  use almost none. Usage is shown in the Cloudflare dashboard.

## Development

- `node tools/assemble.mjs` bundles `src/` into `index.html` and `public/index.html`.
- `node tools/run-selftests.mjs` runs the physics and game self-tests.
- `npx wrangler dev --port 8787` runs the website and rooms locally.
- `node tools/e2e-lan.mjs [--relay | --block-p2p]` runs a two-browser LAN test against that local site.

## Car models (Blender)

The Vector body is modelled in Blender by a script, `tools/blender/octane_build.py`: control cages
smoothed with subdivision, creased and marked sharp on hard edges, plus bevelled mechanical parts.
The script writes a compact quantised mesh to `src/render/cars/vectorMesh.js`, which the game
decodes at start-up. Blender material names map to the game's material slots (`paint`, `trim`,
`glass`, `chrome:red` and so on). To rebuild after editing the script:

    uv venv --python 3.13 .bl && uv pip install --python .bl/bin/python bpy
    .bl/bin/python tools/blender/octane_build.py [--blend out.blend]
    node tools/assemble.mjs

`?procedural=1` in the URL shows the older code-built body for comparison.
