// Port of RocketSim CarConfig.cpp hitbox & wheel presets (MIT, ZealanL).
// size: full hitbox extents (length X, width Y, height Z), offset: hitbox centre
// relative to the car origin (centre of mass). Wheel offsets are the suspension
// hard points (right side, mirror y for the left wheels).

const mk = (size, offset, fr, br, frest, brest, fpos, bpos) => ({
  hitboxSize: { x: size[0], y: size[1], z: size[2] },
  hitboxOffset: { x: offset[0], y: 0, z: offset[1] },
  frontWheels: { radius: fr, suspRest: frest, offset: { x: fpos[0], y: fpos[1], z: fpos[2] } },
  backWheels: { radius: br, suspRest: brest, offset: { x: bpos[0], y: bpos[1], z: bpos[2] } },
  dodgeDeadzone: 0.5,
});

export const CAR_CONFIGS = {
  OCTANE:   mk([120.507, 86.6994, 38.6591], [13.8757, 20.755], 12.5, 15, 38.755, 37.055, [51.25, 25.90, 20.755], [-33.75, 29.50, 20.755]),
  DOMINUS:  mk([130.427, 85.7799, 33.8], [9.0, 15.75], 12, 13.5, 33.95, 33.85, [50.30, 31.10, 15.75], [-34.75, 33.00, 15.75]),
  PLANK:    mk([131.32, 87.1704, 31.8944], [9.00857, 12.0942], 12.5, 17, 31.9242, 27.9242, [49.97, 27.80, 12.0942], [-35.43, 20.28, 12.0942]),
  BREAKOUT: mk([133.992, 83.021, 32.8], [12.5, 11.75], 13.5, 15, 29.7, 29.666, [51.50, 26.67, 11.75], [-35.75, 35.00, 11.75]),
  HYBRID:   mk([129.519, 84.6879, 36.6591], [13.8757, 20.755], 12.5, 15, 38.755, 37.055, [51.25, 25.90, 20.755], [-34.00, 29.50, 20.755]),
  MERC:     mk([123.22, 79.2103, 44.1591], [11.3757, 21.505], 15, 15, 39.505, 39.105, [51.25, 25.90, 21.505], [-33.75, 29.50, 21.505]),
};

// Wheel order follows RocketSim: 0 front-right, 1 front-left, 2 back-right, 3 back-left
export function wheelLayout(cfg) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const front = i < 2, left = (i % 2) === 1;
    const w = front ? cfg.frontWheels : cfg.backWheels;
    out.push({
      front, left,
      radius: w.radius,
      suspRest: w.suspRest,
      restLen: w.suspRest - 12, // MAX_SUSPENSION_TRAVEL
      offset: { x: w.offset.x, y: left ? -w.offset.y : w.offset.y, z: w.offset.z },
    });
  }
  return out;
}
