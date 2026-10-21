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

The Vector (Octane) car is the Blender model in `tools/blender/models/octane.blend`.
`tools/blender/import_octane.py` converts it for the game:

- **Body:** reduced to about 26k triangles and written to `src/render/cars/vectorMesh.js`.
- **Wheel:** one wheel (front right), reduced to about 7k triangles and written to
  `src/render/cars/vectorWheel.js`. The game uses it for all four wheels.
- **Placement:** the model is placed so its wheel centres land on the game's wheel positions.
- **Materials:** Blender material names map to the game's material slots:
  - `Paint_Primary_Blue` becomes the team colour.
  - Glass, trim, chrome and metals, and the lights keep their own looks.
  - `Emit_Boost_Blue` glows in the team colour and brightens while boosting.

The ball is the Blender model in `tools/blender/models/ball.blend`, converted by
`tools/blender/import_ball.py` into `src/render/cars/ballMesh.js`. The importer:

- **Core:** replaces the honeycomb core (about a million displaced faces) with a 5k-triangle sphere
  that keeps the model's UVs. The game redraws the hex holes per pixel from those UVs, with the same
  spacing, size, colours and recess as the honeycomb texture.
- **Other parts:** reduces the scale panels and armour to fit a budget, keeps the small parts (lenses,
  vents, clips) close to their original shape, and gives the lettering its own budget.
- **Lights:** the lenses glow cyan in midfield and blue or orange in each team's half. The whole ball
  lights up briefly when a car hits it.

Arena props are modelled by a script, `tools/blender/arena_assets.py`: the goal structure, both
boost pads, the floodlight rigs and the roof trusses. It saves them to
`tools/blender/models/arena_assets.blend` and exports `src/render/env/arenaAssets.js`. Material names
start with the game slot they map to (`paint`, `metal`, `dark`, `glow`, `light`). The wall ribs,
the rim and the glass frame follow the arena's curved walls exactly, so they are built in code
(`src/render/env/wallDetail.js`) from the same profile as the collision walls. All Blender scripts
share `tools/blender/meshpack.py` for export.

Skins are alternative looks on an existing hitbox, unlocked by modifier codes (`src/game/modifiers.js`).
The classic jeep (code `JEEP`, Octane hitbox) comes from `tools/blender/models/jeep.blend` through
`tools/blender/import_jeep.py`. The importer scales the model to the Octane's wheels, and the game
side lives in `src/render/cars/skins.js`.

To rebuild after editing a model:

    uv venv --python 3.13 .bl && uv pip install --python .bl/bin/python bpy
    .bl/bin/python tools/blender/import_octane.py [--target 26000] [--wheel 7000]
    .bl/bin/python tools/blender/import_ball.py [--target 46000] [--print 9000]
    .bl/bin/python tools/blender/arena_assets.py [--preview out_prefix]
    .bl/bin/python tools/blender/import_jeep.py
    node tools/assemble.mjs

`tools/blender/octane_build.py` is the earlier script-built body. To use it again, run it in place
of the importer. `?procedural=1` in the URL shows the older code-built car and ball for comparison.
