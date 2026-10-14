// TURBO PITCH — UI stylesheet (UI agent). Injected once as a <style> element.
// Everything scales with --u (≈1% of the viewport height on 16:9, width-limited on narrow windows),
// so the UI reads the same from 1080p to 4K.

export const CSS = String.raw`
#ui-root.tp-root {
  --u: min(1vh, 0.5625vw);
  --blue: #2f7bff; --blue-l: #6fa8ff; --blue-d: #0d2f8f;
  --orange: #ff8a1f; --orange-l: #ffb067; --orange-d: #8a3a08;
  --gold: #ffc94a; --gold-l: #ffe38a;
  --panel: rgba(7, 11, 22, 0.86); --panel-2: rgba(14, 20, 38, 0.9);
  --line: rgba(255, 255, 255, 0.12);
  --text: #f2f6ff; --dim: #9aa6c4;
  --f: "Bahnschrift", "DIN Alternate", "DIN Condensed", "Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-family: var(--f); color: var(--text);
  font-stretch: condensed;
  -webkit-font-smoothing: antialiased;
}
#ui-root.tp-root * { box-sizing: border-box; }
#ui-root .tp-hidden { display: none !important; }
#ui-root .tp-layer { position: absolute; inset: 0; pointer-events: none; }
#ui-root .t0 { color: var(--blue-l); }
#ui-root .t1 { color: var(--orange-l); }

/* ================================================================ HUD */
.tp-hud { z-index: 1; }
.tp-hud.sb-open .tp-goal, .tp-hud.sb-open .tp-pops, .tp-hud.sb-open .tp-count, .tp-hud.sb-open .tp-demoed { visibility: hidden; }
.tp-bug { position: absolute; top: 0; left: 50%; transform: translateX(-50%); display: flex; align-items: flex-start;
  height: calc(var(--u) * 7.8); filter: drop-shadow(0 calc(var(--u) * 0.3) calc(var(--u) * 0.8) rgba(0, 0, 0, 0.55)); }
.tp-bug-team { position: relative; width: calc(var(--u) * 7.6); height: 100%; display: flex; align-items: center; justify-content: center;
  font-size: calc(var(--u) * 5.6); font-weight: 800; font-style: italic; color: #fff; font-variant-numeric: tabular-nums; line-height: 1; padding-top: calc(var(--u) * 0.2);
  -webkit-text-stroke: calc(var(--u) * 0.14) rgba(0, 18, 60, 0.55); paint-order: stroke fill; letter-spacing: -0.02em; }
.tp-bug-team.b { background: linear-gradient(180deg, #6a97ff 0%, #2f6cf0 45%, #1d48c4 100%);
  clip-path: polygon(0 0, 100% 0, 100% 100%, 14% 100%); text-shadow: 0 0 calc(var(--u) * 1.2) rgba(160, 200, 255, 0.95), 0 calc(var(--u) * 0.25) calc(var(--u) * 0.5) rgba(0, 20, 80, 0.6); }
.tp-bug-team.o { background: linear-gradient(180deg, #ffad66 0%, #ff8a2a 45%, #e0620c 100%);
  clip-path: polygon(0 0, 100% 0, 86% 100%, 0 100%); text-shadow: 0 0 calc(var(--u) * 1.2) rgba(255, 210, 160, 0.95), 0 calc(var(--u) * 0.25) calc(var(--u) * 0.5) rgba(90, 30, 0, 0.6);
  -webkit-text-stroke-color: rgba(80, 25, 0, 0.55); }
.tp-bug-team::after { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 45%; background: linear-gradient(180deg, rgba(255,255,255,.28), rgba(255,255,255,0)); pointer-events: none; }
.tp-bug-clock { position: relative; width: calc(var(--u) * 17.5); height: 86%; display: flex; align-items: center; justify-content: center;
  background: linear-gradient(90deg, #142a63 0%, #0a0f1e 18%, #070a14 50%, #0a0f1e 82%, #5a2a10 100%);
  font-size: calc(var(--u) * 4.9); font-weight: 500; letter-spacing: 0.08em; color: #fff; font-variant-numeric: tabular-nums;
  text-shadow: 0 0 calc(var(--u) * 0.8) rgba(170, 200, 255, 0.45);
  border-bottom: calc(var(--u) * 0.25) solid rgba(255, 255, 255, 0.18); }
.tp-bug-clock.ot { color: var(--gold-l); }
.tp-bug-glow { position: absolute; top: 55%; width: calc(var(--u) * 11); height: calc(var(--u) * 6); border-radius: 50%; pointer-events: none; filter: blur(calc(var(--u) * 1.4)); opacity: 0.75; z-index: -1; }
.tp-bug-glow.b { left: calc(var(--u) * -1.6); background: radial-gradient(closest-side, rgba(60, 130, 255, 0.95), rgba(60, 130, 255, 0)); }
.tp-bug-glow.o { right: calc(var(--u) * -1.6); background: radial-gradient(closest-side, rgba(255, 140, 40, 0.95), rgba(255, 140, 40, 0)); }
.tp-bug-tag { position: absolute; top: 100%; left: 50%; transform: translateX(-50%); margin-top: calc(var(--u) * 0.5);
  padding: calc(var(--u) * 0.25) calc(var(--u) * 1.4); white-space: nowrap; font-size: max(11px, calc(var(--u) * 1.6)); font-weight: 700;
  letter-spacing: 0.16em; color: #1a1000; background: linear-gradient(90deg, #ffb340, #ffd970);
  clip-path: polygon(calc(var(--u) * 0.8) 0, 100% 0, calc(100% - calc(var(--u) * 0.8)) 100%, 0 100%); }
.tp-bug-tag.wait { color: #fff; background: rgba(8, 12, 24, 0.85); font-weight: 500; letter-spacing: 0.1em; top: calc(100% + var(--u) * 3); }
.tp-bug-fp { position: absolute; top: 0; left: 50%; transform: translateX(-50%); height: calc(var(--u) * 6);
  padding: 0 calc(var(--u) * 4); display: flex; align-items: center; font-size: calc(var(--u) * 3.4); font-style: italic; font-weight: 700; letter-spacing: 0.12em;
  background: linear-gradient(90deg, rgba(47,123,255,.9), rgba(7,10,20,.92) 30%, rgba(7,10,20,.92) 70%, rgba(255,138,31,.9));
  clip-path: polygon(0 0, 100% 0, calc(100% - calc(var(--u) * 2)) 100%, calc(var(--u) * 2) 100%); }

/* boost meter */
.tp-boost { position: absolute; right: calc(var(--u) * 3.8); bottom: calc(var(--u) * 3); width: calc(var(--u) * 24); height: calc(var(--u) * 24); }
.tp-boost svg { width: 100%; height: 100%; overflow: visible; filter: drop-shadow(0 0 calc(var(--u) * 0.6) rgba(0, 0, 0, 0.6)); }
.tp-boost .tk { stroke: rgba(150, 175, 230, 0.28); stroke-width: 6.2; stroke-linecap: butt; }
.tp-boost .tk.on { stroke: url(#tpBoostGrad); }
.tp-boost.full .tk.on { stroke: #fff6e0; }
.tp-boost .num { fill: #fff; font-family: var(--f); font-size: 60px; font-weight: 300; letter-spacing: 2px; }
.tp-boost.low .num { fill: #8fb8ff; }
.tp-boost .lbl { fill: #6fa8ff; font-family: var(--f); font-size: 12px; letter-spacing: 3px; font-weight: 600; }
.tp-boost.active svg { filter: drop-shadow(0 0 calc(var(--u) * 1.2) rgba(255, 150, 40, 0.55)); }

/* event feed */
.tp-feed { position: absolute; top: calc(var(--u) * 2.2); right: calc(var(--u) * 2.2); display: flex; flex-direction: column; align-items: flex-end; gap: calc(var(--u) * 0.6); }
.tp-fi { display: flex; align-items: center; gap: calc(var(--u) * 0.7); font-size: max(12px, calc(var(--u) * 2)); line-height: 1; white-space: nowrap;
  padding: calc(var(--u) * 0.45) calc(var(--u) * 1.2) calc(var(--u) * 0.45) calc(var(--u) * 1.4);
  background: linear-gradient(90deg, rgba(6, 10, 22, 0.35), rgba(6, 10, 22, 0.8) 25%);
  clip-path: polygon(calc(var(--u) * 1) 0, 100% 0, 100% 100%, 0 100%);
  animation: tp-feed-in 0.28s ease-out; transition: opacity 0.6s, transform 0.6s; }
.tp-fi.out { opacity: 0; transform: translateX(calc(var(--u) * 3)); }
.tp-fi .nm { font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; }
.tp-fi .pill { padding: calc(var(--u) * 0.25) calc(var(--u) * 0.9); border-radius: calc(var(--u) * 1.2); color: #fff; font-weight: 700; text-transform: uppercase; }
.tp-fi .pill.t0 { background: linear-gradient(90deg, #2f7bff, #1f52c8); color: #fff; }
.tp-fi .pill.t1 { background: linear-gradient(90deg, #ff8a1f, #d4600c); color: #fff; }
.tp-fi .ev { color: var(--dim); font-size: 0.8em; letter-spacing: 0.12em; text-transform: uppercase; }
.tp-fi .ico { width: 1.25em; height: 1.25em; flex: none; }
.tp-fi.chat { background: linear-gradient(90deg, rgba(6,10,22,.35), rgba(20,26,48,.85) 25%); }
.tp-fi.chat .msg { color: #fff; font-style: italic; }
.tp-fi.sys .msg { color: var(--gold-l); letter-spacing: 0.08em; }
@keyframes tp-feed-in { from { opacity: 0; transform: translateX(calc(var(--u) * 4)); } to { opacity: 1; transform: none; } }

/* points pop-ups */
.tp-pops { position: absolute; right: calc(var(--u) * 30); top: 50%; display: flex; flex-direction: column; align-items: flex-end; gap: calc(var(--u) * 0.5); }
.tp-pop { display: flex; align-items: baseline; gap: calc(var(--u) * 1); font-style: italic; text-transform: uppercase; white-space: nowrap;
  animation: tp-pop 2.6s ease-out forwards; text-shadow: 0 calc(var(--u) * 0.2) calc(var(--u) * 0.6) rgba(0, 0, 0, 0.85); }
.tp-pop .k { font-size: calc(var(--u) * 2.7); font-weight: 700; letter-spacing: 0.05em; color: #fff; }
.tp-pop .p { font-size: calc(var(--u) * 3.1); font-weight: 800; color: var(--gold); }
.tp-pop.big .k { font-size: calc(var(--u) * 3.4); color: var(--gold-l); }
.tp-pop.big .p { font-size: calc(var(--u) * 3.8); }
@keyframes tp-pop { 0% { opacity: 0; transform: translateX(calc(var(--u) * 5)) scale(1.15); } 8% { opacity: 1; transform: none; }
  80% { opacity: 1; transform: none; } 100% { opacity: 0; transform: translateY(calc(var(--u) * -2)); } }

/* countdown */
.tp-count { position: absolute; left: 50%; top: 32%; transform: translate(-50%, -50%); font-size: calc(var(--u) * 15); font-weight: 300; line-height: 1;
  color: var(--gold-l); -webkit-text-stroke: calc(var(--u) * 0.12) rgba(60, 30, 0, 0.55);
  text-shadow: 0 0 calc(var(--u) * 2.2) rgba(255, 190, 60, 0.8), 0 calc(var(--u) * 0.3) calc(var(--u) * 0.8) rgba(0,0,0,.65); }
.tp-count.anim { animation: tp-count 1s ease-out forwards; }
.tp-count.go { font-size: calc(var(--u) * 19); font-weight: 800; font-style: italic; color: #fff; letter-spacing: 0.02em;
  text-shadow: 0 0 calc(var(--u) * 2.5) rgba(255, 210, 90, 0.95), 0 0 calc(var(--u) * 0.4) rgba(0,0,0,.6); }
.tp-count.go.anim { animation: tp-go 1.1s ease-out forwards; }
@keyframes tp-count { 0% { opacity: 0; transform: translate(-50%, -50%) scale(1.9); } 18% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  100% { opacity: 1; transform: translate(-50%, -50%) scale(0.94); } }
@keyframes tp-go { 0% { opacity: 0; transform: translate(-50%, -50%) scale(0.6); } 15% { opacity: 1; transform: translate(-50%, -50%) scale(1.08); }
  60% { opacity: 1; transform: translate(-50%, -50%) scale(1); } 100% { opacity: 0; transform: translate(-50%, -50%) scale(1.5); } }

/* goal banner */
.tp-goal { position: absolute; left: 0; right: 0; top: 19%; display: flex; flex-direction: column; align-items: center; animation: tp-goal-in 0.45s cubic-bezier(.2,1.4,.4,1); }
.tp-goal-band { position: relative; padding: calc(var(--u) * 0.8) calc(var(--u) * 14); transform: skewX(-14deg); }
.tp-goal-band.t0 { background: linear-gradient(90deg, rgba(47,123,255,0), rgba(47,123,255,.92) 22%, rgba(31,72,200,.95) 78%, rgba(47,123,255,0)); }
.tp-goal-band.t1 { background: linear-gradient(90deg, rgba(255,138,31,0), rgba(255,138,31,.92) 22%, rgba(214,90,10,.95) 78%, rgba(255,138,31,0)); }
.tp-goal-title { transform: skewX(14deg); font-size: calc(var(--u) * 9); font-weight: 800; font-style: italic; letter-spacing: 0.04em; color: #fff; line-height: 1.05;
  text-shadow: 0 calc(var(--u) * 0.3) calc(var(--u) * 1) rgba(0, 0, 0, 0.45); white-space: nowrap; }
.tp-goal-sub { margin-top: calc(var(--u) * 1.2); display: flex; gap: calc(var(--u) * 2.5); align-items: baseline; padding: calc(var(--u) * 0.6) calc(var(--u) * 3);
  background: rgba(6, 10, 22, 0.8); font-size: calc(var(--u) * 2.6); text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; }
.tp-goal-sub .lbl { color: var(--dim); font-size: 0.7em; letter-spacing: 0.14em; margin-right: 0.4em; }
.tp-goal-sub .v { font-weight: 700; }
@keyframes tp-goal-in { from { opacity: 0; transform: scale(1.4); } to { opacity: 1; transform: none; } }

/* replay */
#ui-root .tp-replay { pointer-events: auto; cursor: pointer; }
.tp-replay-edge { position: absolute; inset: 0; box-shadow: inset 0 0 calc(var(--u) * 10) rgba(0, 0, 0, 0.55); }
.tp-replay-tag { position: absolute; left: calc(var(--u) * 4); bottom: calc(var(--u) * 4); display: flex; align-items: center; gap: calc(var(--u) * 1);
  font-size: calc(var(--u) * 4); font-weight: 300; letter-spacing: 0.08em; color: #ff5a48; text-shadow: 0 0 calc(var(--u) * 1) rgba(255, 60, 40, 0.5); }
.tp-replay-tag .dot { width: calc(var(--u) * 1.6); height: calc(var(--u) * 1.6); border-radius: 50%; background: #ff3b2a; box-shadow: 0 0 calc(var(--u) * 1) #ff3b2a; animation: tp-blink 1s steps(2, start) infinite; }
@keyframes tp-blink { to { visibility: hidden; } }
.tp-replay-card { position: absolute; left: 50%; bottom: calc(var(--u) * 11); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; min-width: calc(var(--u) * 46); }
.tp-replay-card .hd { font-size: calc(var(--u) * 1.8); letter-spacing: 0.2em; color: var(--blue-l); margin-bottom: calc(var(--u) * 0.6); }
.tp-replay-card .bar { width: 100%; display: flex; align-items: center; gap: calc(var(--u) * 1.6); padding: calc(var(--u) * 0.9) calc(var(--u) * 2.4);
  clip-path: polygon(0 0, 100% 0, calc(100% - var(--u) * 1.6) 100%, 0 100%); }
.tp-replay-card .bar.t0 { background: linear-gradient(90deg, #1f52c8, #2f7bff 70%, rgba(47,123,255,.6)); }
.tp-replay-card .bar.t1 { background: linear-gradient(90deg, #c8500c, #ff8a1f 70%, rgba(255,138,31,.6)); }
.tp-replay-card .who { color: #fff; font-size: calc(var(--u) * 3.6); font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; }
.tp-replay-card .ast { font-size: calc(var(--u) * 1.8); color: rgba(255, 255, 255, 0.88); text-transform: uppercase; letter-spacing: 0.08em; }
.tp-replay-card .meta { display: flex; gap: calc(var(--u) * 3); margin-top: calc(var(--u) * 1); font-size: calc(var(--u) * 2.4); color: #dfe8ff; }
.tp-replay-card .meta small { font-size: 0.65em; color: var(--dim); letter-spacing: 0.12em; margin-left: 0.3em; }
.tp-replay-skip { position: absolute; right: calc(var(--u) * 4); bottom: calc(var(--u) * 4.4); display: flex; align-items: center; gap: calc(var(--u) * 0.8);
  font-size: calc(var(--u) * 2); letter-spacing: 0.1em; text-transform: uppercase; color: #fff; }
.tp-key { display: inline-flex; align-items: center; justify-content: center; min-width: 1.8em; height: 1.6em; padding: 0 0.45em; border: calc(var(--u) * 0.18) solid rgba(255, 255, 255, 0.75);
  border-radius: 0.35em; font-size: 0.85em; font-weight: 700; letter-spacing: 0.02em; background: rgba(0, 0, 0, 0.35); color: #fff; font-style: normal; text-transform: none; }
.tp-key.pad { border-radius: 50%; min-width: 1.6em; padding: 0; }

/* ball cam + free play hints */
.tp-ballcam { position: absolute; left: calc(var(--u) * 4.5); bottom: calc(var(--u) * 3.5); }
.tp-ballcam .t { display: flex; align-items: center; gap: calc(var(--u) * 0.8); font-size: calc(var(--u) * 3.2); font-weight: 300; letter-spacing: 0.05em; color: #ff6b5c; }
.tp-ballcam .t .dot { width: calc(var(--u) * 1.1); height: calc(var(--u) * 1.1); border-radius: 50%; background: #ff5a48; }
.tp-ballcam .s { margin-top: calc(var(--u) * 0.4); font-size: max(10.5px, calc(var(--u) * 1.6)); letter-spacing: 0.1em; color: #fff; text-transform: uppercase; display: flex; gap: .5em; align-items: center; }
.tp-ballcam.off .t { color: rgba(255,255,255,.55); }
.tp-ballcam.off .t .dot { background: rgba(255,255,255,.4); }
.tp-root.dbg .tp-fphint { display: none; }
.tp-fphint { position: absolute; left: calc(var(--u) * 2.2); top: calc(var(--u) * 2.2); padding: calc(var(--u) * 1) calc(var(--u) * 1.6); background: rgba(6, 10, 22, 0.72);
  border-left: calc(var(--u) * 0.35) solid var(--gold); font-size: calc(var(--u) * 1.7); line-height: 1.7; letter-spacing: 0.05em; text-transform: uppercase; }
.tp-fphint .hd { font-size: 1.2em; font-weight: 700; font-style: italic; color: var(--gold); letter-spacing: 0.1em; }
.tp-fphint .on { color: #7dffa8; } .tp-fphint .offv { color: #ff8a80; }
.tp-demoed { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%); text-align: center; }
.tp-demoed .t { font-size: calc(var(--u) * 6); font-weight: 800; font-style: italic; color: #ff5040; letter-spacing: 0.06em; text-shadow: 0 0 calc(var(--u) * 1.5) rgba(255, 40, 20, 0.6); }
.tp-demoed .s { font-size: calc(var(--u) * 2.2); letter-spacing: 0.1em; text-transform: uppercase; }

/* ================================================================ scoreboard (shared by HUD overlay and end screen) */
.tp-sbwrap { position: absolute; left: 50%; top: 31%; transform: translateX(-50%); width: calc(var(--u) * 92); max-width: 96vw; z-index: 5; }
.tp-sb-team { margin-bottom: calc(var(--u) * 2.2); }
.tp-sb-hd { display: grid; align-items: end; padding-bottom: calc(var(--u) * 0.5); }
.tp-sb-hd .tn { display: flex; align-items: baseline; gap: calc(var(--u) * 1.4); font-size: calc(var(--u) * 4.4); font-weight: 300; letter-spacing: 0.04em; line-height: 1; white-space: nowrap; }
.tp-sb-hd .tn .sc { font-weight: 400; }
.tp-sb-hd .tn .win { position: absolute; transform: translateY(-110%); font-size: max(11px, calc(var(--u) * 1.9)); letter-spacing: 0.18em; color: var(--gold-l); }
.tp-sb-hd .ch { text-align: center; font-size: max(10.5px, calc(var(--u) * 1.45)); font-weight: 600; letter-spacing: 0.08em; color: #e6ecff; }
.tp-sb-row { display: grid; align-items: center; height: calc(var(--u) * 5); margin-bottom: calc(var(--u) * 0.35); position: relative;
  clip-path: polygon(0 0, 100% 0, calc(100% - var(--u) * 1) 100%, 0 100%); }
.tp-sb-team.t0 .tp-sb-row { background: linear-gradient(90deg, rgba(28, 72, 210, 0.98), rgba(20, 52, 160, 0.96) 60%, rgba(14, 34, 112, 0.92)); }
.tp-sb-team.t1 .tp-sb-row { background: linear-gradient(90deg, rgba(222, 102, 22, 0.98), rgba(168, 68, 12, 0.96) 60%, rgba(118, 44, 8, 0.92)); }
.tp-sb-team.t0 .tn { color: #7fb0ff; } .tp-sb-team.t1 .tn { color: #ffae6a; }
.tp-sb-row .pn, .tp-sb-row .st, .tp-sb-row .av { color: #fff; }
.tp-sb-row.me { box-shadow: inset calc(var(--u) * 0.7) 0 0 var(--gold), inset 0 0 0 calc(var(--u) * 0.18) rgba(255, 214, 110, 0.85); filter: brightness(1.18) saturate(1.1); }
.tp-sb-row.me .pn { color: var(--gold-l); }
.tp-sb-row .av { width: calc(var(--u) * 4.2); height: calc(var(--u) * 4.2); margin-left: calc(var(--u) * 0.4); display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.3); border: calc(var(--u) * 0.15) solid rgba(255, 255, 255, 0.55); font-size: calc(var(--u) * 1.6); font-weight: 800; }
.tp-sb-row .pn { padding-left: calc(var(--u) * 1.2); font-size: calc(var(--u) * 2.4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: calc(var(--u) * 0.8); }
.tp-sb-row .pn .bot { font-size: max(10px, calc(var(--u) * 1.3)); letter-spacing: 0.14em; padding: 0.1em 0.5em; background: rgba(0, 0, 0, 0.35); color: #dfe6ff; }
.tp-sb-row .st { text-align: center; font-size: calc(var(--u) * 2.4); font-variant-numeric: tabular-nums; }
.tp-sb-row .mvp { width: calc(var(--u) * 3.2); height: calc(var(--u) * 3.2); flex: none; }
.tp-sb-clock { text-align: center; margin-bottom: calc(var(--u) * 2); font-size: calc(var(--u) * 2); letter-spacing: 0.18em; color: var(--dim); }
.tp-sb-overlay { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 55%, rgba(2, 4, 12, 0.72), rgba(2, 4, 12, 0.45) 75%); backdrop-filter: blur(4px) saturate(0.8); -webkit-backdrop-filter: blur(4px) saturate(0.8); z-index: 5; }

/* ================================================================ menus */
.tp-menus { z-index: 10; }
.tp-shade-l { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(0, 0, 0, 0.6) 0%, rgba(0, 0, 0, 0.25) 35%, rgba(0, 0, 0, 0) 60%), linear-gradient(0deg, rgba(0,0,0,.55), rgba(0,0,0,0) 18%); }
.tp-shade-full { position: absolute; inset: 0; background: rgba(2, 4, 10, 0.62); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); }
.tp-page { position: absolute; inset: 0; pointer-events: none; }
.tp-page.anim { animation: tp-page-in 0.22s ease-out; }
@keyframes tp-page-in { from { transform: translateX(calc(var(--u) * -1.5)); } to { transform: none; } }

.tp-logo { position: absolute; left: calc(var(--u) * 4); top: calc(var(--u) * 8); width: calc(var(--u) * 44); }
.tp-logo svg { width: 100%; height: auto; display: block; overflow: visible; filter: drop-shadow(0 calc(var(--u) * 0.5) calc(var(--u) * 1.4) rgba(0,0,0,.6)); }
.tp-logo .tag { margin-top: calc(var(--u) * 0.6); padding-left: calc(var(--u) * 1.2); font-size: calc(var(--u) * 1.5); letter-spacing: 0.42em; color: rgba(255,255,255,.7); text-transform: uppercase; }

.tp-nav.right { left: auto; right: calc(var(--u) * 3.2); top: 26%; }
.tp-side.below { top: calc(26% + var(--u) * 33.5); width: calc(var(--u) * 35); padding: calc(var(--u) * 1.4) calc(var(--u) * 2); }
.tp-side.below .body { min-height: 0; font-size: calc(var(--u) * 1.7); }
.tp-shade-r { position: absolute; inset: 0; background: linear-gradient(270deg, rgba(0, 0, 0, 0.6) 0%, rgba(0, 0, 0, 0.3) 28%, rgba(0, 0, 0, 0) 50%), linear-gradient(0deg, rgba(0,0,0,.55), rgba(0,0,0,0) 18%); }
.tp-nav { position: absolute; left: calc(var(--u) * 3.2); top: 40%; width: calc(var(--u) * 35); display: flex; flex-direction: column; gap: calc(var(--u) * 0.55); pointer-events: auto; }
.tp-btn { position: relative; display: flex; align-items: center; height: calc(var(--u) * 4.7); padding: 0 calc(var(--u) * 2.4); border: 0; margin: 0;
  font-family: var(--f); font-size: calc(var(--u) * 2.35); font-weight: 500; letter-spacing: 0.05em; text-transform: uppercase; text-align: left; color: #fff;
  background: rgba(6, 8, 10, 0.88); cursor: pointer; outline: none;
  clip-path: polygon(0 0, 100% 0, calc(100% - var(--u) * 1.4) 100%, 0 100%); transition: background 0.12s, color 0.12s, padding 0.12s; }
.tp-btn .sub { margin-left: auto; font-size: 0.62em; letter-spacing: 0.14em; color: var(--dim); }
.tp-btn:hover, .tp-btn.tp-focus { background: linear-gradient(90deg, rgba(170, 92, 12, 0.96), rgba(110, 55, 6, 0.92) 55%, rgba(45, 22, 3, 0.9)); color: var(--gold); padding-left: calc(var(--u) * 2.9); }
.tp-btn:hover .sub, .tp-btn.tp-focus .sub { color: #ffe0a0; }
.tp-btn:active { transform: translateY(1px); }
.tp-btn.ital { font-style: italic; }
.tp-btn.primary { background: linear-gradient(90deg, #ff9a2a, #ff7a10); color: #1a0c00; font-weight: 800; font-style: italic; justify-content: center; font-size: calc(var(--u) * 2.8); height: calc(var(--u) * 5.6); }
.tp-btn.primary:hover, .tp-btn.primary.tp-focus { background: linear-gradient(90deg, #ffc04a, #ff9a2a); color: #1a0c00; padding-left: calc(var(--u) * 2.4); box-shadow: 0 0 calc(var(--u) * 2) rgba(255, 160, 40, 0.6); }
.tp-btn[disabled] { opacity: 0.45; cursor: default; }

.tp-head { position: absolute; left: 0; right: 0; top: 0; height: calc(var(--u) * 15.5); pointer-events: none;
  background: linear-gradient(180deg, rgba(2, 4, 10, 0.94) 0%, rgba(2, 4, 10, 0.82) 55%, rgba(2, 4, 10, 0) 100%); }
.tp-title { position: absolute; left: calc(var(--u) * 4); top: calc(var(--u) * 3.6); display: flex; align-items: baseline; gap: calc(var(--u) * 1.6); }
.tp-title .main { font-size: calc(var(--u) * 5); font-weight: 800; font-style: italic; letter-spacing: 0.04em; text-transform: uppercase; text-shadow: 0 calc(var(--u)*.3) calc(var(--u)*1) rgba(0,0,0,.6); }
.tp-title .crumb { font-size: calc(var(--u) * 1.7); letter-spacing: 0.2em; color: var(--dim); text-transform: uppercase; }
.tp-title::after { content: ''; position: absolute; left: 0; bottom: calc(var(--u) * -1); width: calc(var(--u) * 10); height: calc(var(--u) * 0.4); background: linear-gradient(90deg, var(--blue), var(--orange)); }

.tp-footer { position: absolute; left: 0; right: 0; bottom: 0; height: calc(var(--u) * 6.2); display: flex; align-items: center; gap: calc(var(--u) * 1.4);
  padding: 0 calc(var(--u) * 3.2); background: linear-gradient(0deg, rgba(2, 4, 10, 0.92), rgba(2, 4, 10, 0.6)); border-top: 1px solid var(--line); pointer-events: auto; }
.tp-footer .tp-btn { height: calc(var(--u) * 4); font-size: calc(var(--u) * 1.9); padding: 0 calc(var(--u) * 2.2); font-style: italic; }
.tp-footer .hint { margin-left: auto; font-size: calc(var(--u) * 1.6); letter-spacing: 0.1em; color: var(--dim); text-transform: uppercase; display: flex; gap: calc(var(--u) * 1.6); align-items: center; }
.tp-card { display: flex; align-items: center; gap: calc(var(--u) * 1.2); padding-right: calc(var(--u) * 3); height: calc(var(--u) * 4.6);
  background: linear-gradient(90deg, rgba(40, 60, 140, 0.85), rgba(20, 30, 70, 0.4)); clip-path: polygon(0 0, 100% 0, calc(100% - var(--u) * 1.4) 100%, 0 100%); }
.tp-card .av { width: calc(var(--u) * 4.6); height: calc(var(--u) * 4.6); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: calc(var(--u) * 2.2); }
.tp-card .nm { font-size: calc(var(--u) * 2.1); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.tp-card .sub { font-size: max(10px, calc(var(--u) * 1.3)); letter-spacing: 0.12em; color: #c7d4ff; text-transform: uppercase; }

.tp-panel { position: absolute; pointer-events: auto; background: var(--panel); border-top: calc(var(--u) * 0.35) solid var(--blue);
  box-shadow: 0 calc(var(--u) * 1) calc(var(--u) * 4) rgba(0, 0, 0, 0.5); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.tp-panel.accent-o { border-top-color: var(--orange); }
.tp-scroll { overflow-y: auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.25) transparent; }
.tp-scroll::-webkit-scrollbar { width: calc(var(--u) * 0.6); } .tp-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,.25); }

.tp-side { position: absolute; right: calc(var(--u) * 3.2); top: 40%; width: calc(var(--u) * 38); padding: calc(var(--u) * 2) calc(var(--u) * 2.4); pointer-events: auto;
  background: linear-gradient(180deg, rgba(14, 28, 70, 0.88), rgba(7, 11, 22, 0.88)); border-top: calc(var(--u) * 0.35) solid var(--blue-l); }
.tp-side .hd { font-size: calc(var(--u) * 1.5); letter-spacing: 0.24em; color: var(--blue-l); text-transform: uppercase; }
.tp-side .ttl { margin-top: calc(var(--u) * 0.6); font-size: calc(var(--u) * 3); font-weight: 800; font-style: italic; text-transform: uppercase; letter-spacing: 0.03em; }
.tp-side .body { margin-top: calc(var(--u) * 1); font-size: calc(var(--u) * 1.9); line-height: 1.45; color: #d7e0f7; min-height: calc(var(--u) * 11); }
.tp-side .dots { display: flex; gap: calc(var(--u) * 0.6); margin-top: calc(var(--u) * 1.4); }
.tp-side .dots i { width: calc(var(--u) * 2.4); height: calc(var(--u) * 0.4); background: rgba(255, 255, 255, 0.25); }
.tp-side .dots i.on { background: var(--blue-l); }

/* form groups */
.tp-group { margin-bottom: calc(var(--u) * 2.4); }
.tp-group > .lbl { font-size: calc(var(--u) * 1.6); letter-spacing: 0.22em; color: var(--dim); text-transform: uppercase; margin-bottom: calc(var(--u) * 0.9); }
.tp-seg { display: flex; gap: calc(var(--u) * 0.5); flex-wrap: wrap; }
.tp-opt { flex: 1 1 0; min-width: calc(var(--u) * 10); height: calc(var(--u) * 5.2); border: calc(var(--u) * 0.2) solid rgba(255, 255, 255, 0.12); background: rgba(255, 255, 255, 0.05);
  color: #dfe6f8; font-family: var(--f); font-size: calc(var(--u) * 2.3); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer; outline: none;
  transform: skewX(-10deg); transition: background 0.12s, border-color 0.12s; display: flex; align-items: center; justify-content: center; gap: .5em; }
.tp-opt > span { transform: skewX(10deg); display: inline-flex; flex-direction: column; align-items: center; }
.tp-opt > span.sw-wrap { flex-direction: row; gap: 0.45em; }
.tp-panel .tp-btn.primary { width: 100%; margin-top: calc(var(--u) * 0.6); }
.tp-opt:hover, .tp-opt.tp-focus { border-color: rgba(255, 201, 74, 0.8); background: rgba(255, 201, 74, 0.1); }
.tp-opt.sel { background: linear-gradient(180deg, rgba(47, 123, 255, 0.9), rgba(25, 70, 190, 0.9)); border-color: #8db8ff; color: #fff; }
.tp-opt.sel.or { background: linear-gradient(180deg, rgba(255, 138, 31, 0.95), rgba(200, 90, 10, 0.95)); border-color: #ffc690; }
.tp-opt .sw { width: 0.8em; height: 0.8em; border-radius: 50%; display: inline-block; }
.tp-opt small { display: block; font-size: max(10px, 0.55em); letter-spacing: 0.14em; color: rgba(255,255,255,.7); font-weight: 500; }

.tp-tabs { display: flex; gap: calc(var(--u) * 0.4); padding: 0 calc(var(--u) * 2); border-bottom: 1px solid var(--line); }
.tp-tab { padding: calc(var(--u) * 1.3) calc(var(--u) * 2.4); border: 0; background: transparent; color: var(--dim); font-family: var(--f); font-size: calc(var(--u) * 2.1);
  font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; cursor: pointer; outline: none; border-bottom: calc(var(--u) * 0.35) solid transparent; }
.tp-tab:hover, .tp-tab.tp-focus { color: #fff; }
.tp-tab.sel { color: #fff; border-bottom-color: var(--orange); }

.tp-rows { padding: calc(var(--u) * 1.4) calc(var(--u) * 3); }
.tp-sect { margin: calc(var(--u) * 1.6) 0 calc(var(--u) * 0.6); font-size: calc(var(--u) * 1.5); letter-spacing: 0.24em; color: var(--blue-l); text-transform: uppercase; }
.tp-row { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.4fr) calc(var(--u) * 8); align-items: center; gap: calc(var(--u) * 2);
  min-height: calc(var(--u) * 5); padding: calc(var(--u) * 0.4) calc(var(--u) * 1.4); border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
.tp-row:hover, .tp-row.tp-focus-row { background: rgba(255, 255, 255, 0.05); }
.tp-row .nm { font-size: calc(var(--u) * 2); letter-spacing: 0.04em; text-transform: uppercase; }
.tp-row .nm small { display: block; font-size: 0.7em; color: var(--dim); text-transform: none; letter-spacing: 0.02em; margin-top: 0.2em; }
.tp-row .val { text-align: right; font-size: calc(var(--u) * 2); font-variant-numeric: tabular-nums; color: var(--gold-l); }
.tp-row .tp-seg .tp-opt { height: calc(var(--u) * 3.8); font-size: calc(var(--u) * 1.7); min-width: calc(var(--u) * 7); }

.tp-range { -webkit-appearance: none; appearance: none; width: 100%; height: calc(var(--u) * 3); background: transparent; cursor: pointer; outline: none; margin: 0; }
.tp-range::-webkit-slider-runnable-track { height: calc(var(--u) * 0.6); background: linear-gradient(90deg, var(--orange) var(--p, 50%), rgba(255, 255, 255, 0.16) var(--p, 50%)); }
.tp-range::-moz-range-track { height: calc(var(--u) * 0.6); background: rgba(255, 255, 255, 0.16); }
.tp-range::-moz-range-progress { height: calc(var(--u) * 0.6); background: var(--orange); }
.tp-range::-webkit-slider-thumb { -webkit-appearance: none; width: calc(var(--u) * 1.4); height: calc(var(--u) * 2.8); margin-top: calc(var(--u) * -1.1); background: #fff; border: 0; transform: skewX(-12deg); box-shadow: 0 0 calc(var(--u) * 0.6) rgba(0,0,0,.6); }
.tp-range::-moz-range-thumb { width: calc(var(--u) * 1.4); height: calc(var(--u) * 2.8); background: #fff; border: 0; border-radius: 0; }
.tp-range:focus-visible::-webkit-slider-thumb, .tp-range.tp-focus::-webkit-slider-thumb { background: var(--gold); box-shadow: 0 0 calc(var(--u) * 1) var(--gold); }

.tp-toggle { justify-self: start; position: relative; width: calc(var(--u) * 8); height: calc(var(--u) * 3.4); border: calc(var(--u) * 0.2) solid rgba(255, 255, 255, 0.25); background: rgba(255, 255, 255, 0.06);
  cursor: pointer; outline: none; transform: skewX(-10deg); padding: 0; }
.tp-toggle::after { content: ''; position: absolute; top: calc(var(--u) * 0.35); left: calc(var(--u) * 0.4); width: calc(var(--u) * 3.3); height: calc(var(--u) * 2.3); background: rgba(255, 255, 255, 0.55); transition: left 0.14s, background 0.14s; }
.tp-toggle.on { background: rgba(255, 138, 31, 0.3); border-color: var(--orange); }
.tp-toggle.on::after { left: calc(100% - var(--u) * 3.7); background: var(--orange); }
.tp-toggle:hover, .tp-toggle.tp-focus { border-color: var(--gold); }

.tp-input { height: calc(var(--u) * 4.4); padding: 0 calc(var(--u) * 1.2); width: 100%; border: calc(var(--u) * 0.2) solid rgba(255, 255, 255, 0.2); background: rgba(0, 0, 0, 0.35);
  color: #fff; font-family: var(--f); font-size: calc(var(--u) * 2.1); letter-spacing: 0.04em; outline: none; pointer-events: auto; user-select: text; -webkit-user-select: text; }
.tp-input:focus, .tp-input.tp-focus { border-color: var(--gold); }

/* bindings */
.tp-bind { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr); gap: calc(var(--u) * 0.6) calc(var(--u) * 1.2); align-items: center; }
.tp-bind .hd { font-size: calc(var(--u) * 1.5); letter-spacing: 0.2em; color: var(--dim); text-transform: uppercase; padding: calc(var(--u) * 0.6) calc(var(--u) * 1.4); }
.tp-bind .an { font-size: calc(var(--u) * 2); letter-spacing: 0.04em; text-transform: uppercase; padding-left: calc(var(--u) * 1.4); }
.tp-bindbtn { height: calc(var(--u) * 4); border: calc(var(--u) * 0.2) solid rgba(255, 255, 255, 0.14); background: rgba(255, 255, 255, 0.05); color: #fff; cursor: pointer; outline: none;
  font-family: var(--f); font-size: calc(var(--u) * 1.9); letter-spacing: 0.04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 calc(var(--u) * 1); }
.tp-bindbtn:hover, .tp-bindbtn.tp-focus { border-color: var(--gold); background: rgba(255, 201, 74, 0.12); }
.tp-bindbtn.na { color: var(--dim); cursor: default; }
.tp-bindbtn.na:hover { border-color: rgba(255, 255, 255, 0.14); background: rgba(255, 255, 255, 0.05); }

.tp-modal { position: absolute; inset: 0; z-index: 20; pointer-events: auto; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.6); }
.tp-modal .box { min-width: calc(var(--u) * 56); padding: calc(var(--u) * 3.4) calc(var(--u) * 4); background: var(--panel-2); border-top: calc(var(--u) * 0.4) solid var(--orange); text-align: center; }
.tp-modal .t1 { font-size: calc(var(--u) * 1.7); letter-spacing: 0.24em; color: var(--dim); text-transform: uppercase; }
.tp-modal .t2 { margin: calc(var(--u) * 1) 0 calc(var(--u) * 0.6); font-size: calc(var(--u) * 4.4); font-weight: 800; font-style: italic; text-transform: uppercase; color: #fff; }
.tp-modal .t3 { font-size: calc(var(--u) * 2.2); color: var(--gold-l); animation: tp-breathe 1.2s ease-in-out infinite; }
.tp-modal .row { display: flex; gap: calc(var(--u) * 1); justify-content: center; }
.tp-modal .t3.static { animation: none; }
.tp-modal .tp-btn { display: inline-flex; margin-top: calc(var(--u) * 2.4); height: calc(var(--u) * 4); font-size: calc(var(--u) * 1.8); }
@keyframes tp-breathe { 50% { opacity: 0.45; } }

/* garage */
.tp-cars { display: grid; grid-template-columns: 1fr 1fr; gap: calc(var(--u) * 0.8); }
.tp-carbtn { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; height: calc(var(--u) * 7.4); padding: 0 calc(var(--u) * 1.8); cursor: pointer; outline: none;
  border: calc(var(--u) * 0.2) solid rgba(255, 255, 255, 0.12); background: rgba(255, 255, 255, 0.05); color: #fff; font-family: var(--f); text-align: left;
  clip-path: polygon(0 0, 100% 0, calc(100% - var(--u) * 1.2) 100%, 0 100%); }
.tp-carbtn .n { font-size: calc(var(--u) * 2.6); font-weight: 800; font-style: italic; text-transform: uppercase; letter-spacing: 0.04em; }
.tp-carbtn .hb { font-size: calc(var(--u) * 1.5); letter-spacing: 0.04em; white-space: nowrap; color: var(--dim); margin-top: calc(var(--u) * 0.3); }
.tp-carbtn:hover, .tp-carbtn.tp-focus { border-color: rgba(255, 201, 74, 0.8); }
.tp-carbtn.sel { background: linear-gradient(90deg, rgba(47, 123, 255, 0.55), rgba(47, 123, 255, 0.15)); border-color: #8db8ff; }
.tp-carbtn.sel .hb { color: #cfe0ff; }
.tp-swatches { display: grid; grid-template-columns: repeat(8, 1fr); gap: calc(var(--u) * 0.7); }
.tp-sw { aspect-ratio: 1; border: calc(var(--u) * 0.25) solid rgba(255, 255, 255, 0.15); cursor: pointer; outline: none; padding: 0; }
.tp-sw:hover, .tp-sw.tp-focus { border-color: var(--gold); }
.tp-sw.sel { border-color: #fff; box-shadow: 0 0 0 calc(var(--u) * 0.25) var(--orange); }
.tp-color { display: flex; align-items: center; gap: calc(var(--u) * 1.2); margin-top: calc(var(--u) * 1); }
.tp-color input[type=color] { width: calc(var(--u) * 7); height: calc(var(--u) * 4); border: calc(var(--u) * 0.2) solid rgba(255,255,255,.3); background: transparent; padding: 0; cursor: pointer; pointer-events: auto; }
.tp-color .hex { font-family: var(--mono); font-size: calc(var(--u) * 1.8); color: var(--dim); }
.tp-hbinfo { margin-top: calc(var(--u) * 0.6); font-size: calc(var(--u) * 1.6); color: var(--dim); line-height: 1.5; }
.tp-hbinfo b { color: #fff; font-weight: 600; }

/* stats + help */
.tp-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: calc(var(--u) * 1.2); }
.tp-tile { padding: calc(var(--u) * 2) calc(var(--u) * 2); background: rgba(255, 255, 255, 0.05); border-left: calc(var(--u) * 0.4) solid var(--blue); }
.tp-tile:nth-child(even) { border-left-color: var(--orange); }
.tp-tile .v { font-size: calc(var(--u) * 5.4); font-weight: 300; line-height: 1; font-variant-numeric: tabular-nums; }
.tp-tile .k { margin-top: calc(var(--u) * 0.6); font-size: calc(var(--u) * 1.5); letter-spacing: 0.22em; color: var(--dim); text-transform: uppercase; }
.tp-help { display: grid; grid-template-columns: 1fr 1fr; gap: calc(var(--u) * 3); }
.tp-ktable { width: 100%; border-collapse: collapse; font-size: calc(var(--u) * 1.85); }
.tp-ktable td { padding: calc(var(--u) * 0.55) calc(var(--u) * 0.8); border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
.tp-ktable td:first-child { color: #dfe6f8; text-transform: uppercase; letter-spacing: 0.04em; }
.tp-ktable td:last-child { text-align: right; }
.tp-ktable .tp-key { font-size: calc(var(--u) * 1.6); margin-left: 0.3em; }
.tp-tips { display: grid; grid-template-columns: repeat(3, 1fr); gap: calc(var(--u) * 1.4); margin-top: calc(var(--u) * 1); }
.tp-tip { padding: calc(var(--u) * 1.6) calc(var(--u) * 1.8); background: rgba(255, 255, 255, 0.05); border-top: calc(var(--u) * 0.3) solid var(--orange); font-size: calc(var(--u) * 1.75); line-height: 1.5; color: #d4dcf2; }
.tp-tip h4 { margin: 0 0 calc(var(--u) * 0.6); font-size: calc(var(--u) * 2.2); font-style: italic; font-weight: 800; text-transform: uppercase; color: #fff; letter-spacing: 0.04em; }
.tp-tip ol { margin: 0; padding-left: 1.2em; }
.tp-pad { display: block; width: 100%; height: auto; margin-bottom: calc(var(--u) * 1); }

/* pause + end */
.tp-paused-title { position: absolute; left: calc(var(--u) * 4); top: 26%; font-size: calc(var(--u) * 7); font-weight: 800; font-style: italic; letter-spacing: 0.06em; }
.tp-paused-title small { display: block; text-transform: uppercase; font-size: 0.26em; font-weight: 500; font-style: normal; letter-spacing: 0.3em; color: var(--dim); margin-top: calc(var(--u) * 0.6); }
.tp-end-banner { position: absolute; left: 0; right: 0; top: calc(var(--u) * 4); display: flex; flex-direction: column; align-items: center; animation: tp-goal-in 0.5s cubic-bezier(.2,1.3,.4,1); }
.tp-end-banner .res { font-size: calc(var(--u) * 2); letter-spacing: 0.4em; color: var(--gold-l); text-transform: uppercase; }
.tp-end-banner .tp-goal-band { margin-top: calc(var(--u) * 0.6); }
.tp-end-banner .tp-goal-title { font-size: calc(var(--u) * 7.2); }
.tp-acc { display: flex; gap: calc(var(--u) * 1.4); margin-top: calc(var(--u) * 1.8); }
.tp-acc .a { min-width: calc(var(--u) * 24); padding: calc(var(--u) * 0.8) calc(var(--u) * 2); text-align: center; background: linear-gradient(180deg, rgba(60, 44, 6, 0.9), rgba(20, 16, 4, 0.9));
  border: calc(var(--u) * 0.2) solid rgba(255, 201, 74, 0.85); }
.tp-acc .a .k { font-size: calc(var(--u) * 2.3); color: var(--gold); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.tp-acc .a .v { font-size: calc(var(--u) * 1.8); color: #fff; }
.tp-end .tp-sbwrap { top: 36%; left: 59%; width: calc(var(--u) * 100); }
.tp-end-shade { position: absolute; inset: 0; background: radial-gradient(ellipse at 58% 60%, rgba(2, 4, 12, 0.78), rgba(2, 4, 12, 0.55) 80%); backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px); }
.tp-end .tp-nav { top: 52%; width: calc(var(--u) * 30); }

/* ================================================================ debug + fps */
.tp-fps { position: absolute; left: calc(var(--u) * 1); top: calc(var(--u) * 1); z-index: 31; padding: calc(var(--u) * 0.3) calc(var(--u) * 0.8); background: rgba(0, 0, 0, 0.55);
  font-family: var(--mono); font-size: calc(var(--u) * 1.5); color: #9dff9d; }
.tp-debug { position: absolute; left: calc(var(--u) * 1); top: calc(var(--u) * 4); z-index: 30; width: max(300px, calc(var(--u) * 42)); pointer-events: auto; padding: calc(var(--u) * 1) calc(var(--u) * 1.2);
  background: rgba(0, 0, 0, 0.78); border-left: calc(var(--u) * 0.3) solid #9dff9d; font-family: var(--mono); font-size: max(10.5px, calc(var(--u) * 1.45)); line-height: 1.45; color: #e6f2e6; }
.tp-debug .hd { color: #9dff9d; font-weight: 700; letter-spacing: 0.1em; margin-bottom: calc(var(--u) * 0.4); }
.tp-debug .kv { display: grid; grid-template-columns: 1fr auto; column-gap: calc(var(--u) * 1); }
.tp-debug .kv span:nth-child(odd) { color: #8fa38f; }
.tp-debug .kv span:nth-child(even) { text-align: right; font-variant-numeric: tabular-nums; }
.tp-debug .yes { color: #9dff9d; } .tp-debug .no { color: #ff9d9d; }
.tp-debug button { margin-top: calc(var(--u) * 0.8); width: 100%; height: calc(var(--u) * 3.4); border: 1px solid #9dff9d; background: rgba(157, 255, 157, 0.1); color: #9dff9d; font-family: var(--mono);
  font-size: calc(var(--u) * 1.45); cursor: pointer; letter-spacing: 0.08em; }
.tp-debug button:hover { background: rgba(157, 255, 157, 0.22); }
.tp-debug button[disabled] { opacity: 0.5; cursor: default; }
.tp-debug .res { margin-top: calc(var(--u) * 0.6); max-height: 36vh; overflow-y: auto; font-size: max(10px, calc(var(--u) * 1.2)); line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
.tp-debug .res .p { color: #9dff9d; } .tp-debug .res .f { color: #ff8a8a; } .tp-debug .res .s { color: #ffe38a; font-weight: 700; }
`;
