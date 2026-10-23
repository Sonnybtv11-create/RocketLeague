# Kart skin sound effects: credits

All sources are real recordings from BigSoundBank (https://bigsoundbank.com), the
English mirror of LaSonotheque by Joseph Sardin. Each source page states
"License CC0 (public domain): Free and royalty-free".
Licence: Creative Commons CC0 1.0 Universal (https://creativecommons.org/publicdomain/zero/1.0/).
Site licence page: https://bigsoundbank.com/licenses.html
Attribution is not required, but it is credited below.

Common processing for all files: decoded from the site's MP3 (320 kbps), downmixed
to mono, resampled, peak-normalised to -1 dBFS, encoded with libmp3lame (CBR).
The LAME gapless header is kept (ffmpeg decodes the exact sample count).

| Output | Source page | Author | Licence | Processing |
|---|---|---|---|---|
| engine_loop.mp3 | "Lawn tractors #2" (small ride-on mower tractor, steady running, outdoor, ME66 mic): https://bigsoundbank.com/lawn-tractors-2-s1768.html | Joseph Sardin | CC0 1.0 | Took the steady section starting at 6.0 s. Loop length 3.665 s, chosen to maximise correlation at the seam (r = 0.93). The tail was crossfaded linearly (120 ms) into the start for a seamless loop. DC removed. 22050 Hz, 80 kbps. |
| horn.mp3 | "Recent Car Horn #7" (5 honks of a Peugeot 107 small city car): https://bigsoundbank.com/recent-car-horn-7-s0969.html | Joseph Sardin | CC0 1.0 | Trimmed 3.785 to 4.900 s, the two short honks ("beep-beep"). 3 ms fade-in, 80 ms fade-out. 44100 Hz, 96 kbps. |
| rattle1.mp3 | "Fall 2 sheet steel bars #2": https://bigsoundbank.com/fall-2-sheet-steel-bars-2-s1777.html | Joseph Sardin | CC0 1.0 | Trimmed 0.065 to 0.800 s. 2 ms fade-in, 120 ms fade-out. 22050 Hz, 80 kbps. |
| rattle2.mp3 | "Fall 2 sheet steel bars #1": https://bigsoundbank.com/fall-2-sheet-steel-bars-1-s1776.html | Joseph Sardin | CC0 1.0 | Trimmed 0.060 to 0.950 s. 2 ms fade-in, 150 ms fade-out. 22050 Hz, 80 kbps. |
| rattle3.mp3 | "Tin can #2" (tin dropped on the ground): https://bigsoundbank.com/tin-can-2-s0247.html | Denis Chardonnet (per page) | CC0 1.0 | Trimmed 0.000 to 0.950 s. Stereo downmixed to mono. 2 ms fade-in, 150 ms fade-out. 22050 Hz, 80 kbps. |
| flag_flap.mp3 | "Flag in the Wind #2" (fabric flapping outdoors, Foley): https://bigsoundbank.com/flag-in-the-wind-2-s1633.html | Joseph Sardin | CC0 1.0 | Took the steadiest loud section starting at 55.5 s. Loop length 3.640 s, with a 400 ms equal-power crossfade of the tail into the start. DC removed. 22050 Hz, 80 kbps. |
| squeak.mp3 | "Coin-Coin (Toy)" (squeak of a plush dog's nose): https://bigsoundbank.com/coin-coin-toy-s0364.html | Joseph Sardin | CC0 1.0 | Trimmed 1.560 to 2.050 s, one squeeze. 2 ms fade-in, 60 ms fade-out. 22050 Hz, 80 kbps. |
