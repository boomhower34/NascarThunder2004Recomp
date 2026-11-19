// race-bot.mjs — a simple driver for unattended test races: keeps the player's car in a lane with the virtual pad.
//
// It drives from the race's own track-relative state of the car (the per-car race entry, 0x68 bytes, table at
// [0x2F32D8], car index = car record +0x0C; player 0's car record is 0x2951E0):
//   +0x14  sideways position on the track (units; drifts steadily when the car runs straight in a turn)
//   +0x30  speed (units/s)               +0x34  heading relative to the track direction (degrees)
//   +0x3C  track segment, +0x40 distance left in it     +0x54  current lap time (s; 9999 before the first line)
//   +0x5C  low 16 bits: laps started
// Steering (left stick X: negative = left; left lock moves the car toward negative lane values) =
// -(k_lane * (lane - target) + k_head * heading + integral): a car off to the positive side or pointing that way gets
// left lock, which turns it back. (The first version had the sign the other way round: the car then rode the outside
// wall at lane ~15-19, slowly, which looked like lane keeping.) Throttle holds a target speed; if the
// car stops making progress it backs up for a moment with the wheel the other way.
//
// Pit stops: bot.pitOnLap = n makes it pit on lap n: from segment pitFrom[0] with less than pitFrom[1] to go (past the
// pit wall along the front stretch at the default track; going in earlier hits it) it moves to pit road (lane pitLane, about -115 at
// the default track, where the entry lies near the end of segment 1) below the 70 mph limit (pitSpeed 95 ft/s). Once
// the game takes the car over (race state 5 = pit road, 6 = in the stall; the pit menu 10/1 opens, pit status word
// 0x2B9E84 goes 4 -> 5 -> 6 -> 0) the bot leaves the pad alone, and after the car is back in state 3 it returns to its
// racing line. pitFrom[2] (optional): the least distance to go; a track whose other straight has the same segment
// value (Milwaukee: both straights read 3) starts the approach only on the long front one.
//
// usage, with the race running and control handed over (A on the grid intro 3/10): const bot = new RaceBot(game);
// then each frame bot.drive(); bot.state() reads the entry.

const REC = 0x2951e0;

export class RaceBot {
  constructor(game, { target = 0, kLane = 0.035, kHead = 0.07, kInt = 0.0004, speed = 95, pitOnLap = 0, pitLane = -115, pitSpeed = 95, pitFrom = [3, 800] } = {}) {
    this.g = game; this.m = game.mem; this.target = target; this.kLane = kLane; this.kHead = kHead; this.kInt = kInt; this.speedTarget = speed;
    this.pitOnLap = pitOnLap; this.pitLane = pitLane; this.pitSpeed = pitSpeed; this.pitFrom = pitFrom; this.pit = "none"; this.pits = 0;
    this.frames = 0; this.stuck = 0; this.reverse = 0; this.lastDist = null; this.progress = 0;
  }
  entry(car = 0) { const idx = this.m.r32(REC + car * 0x5c0 + 0x0c); return this.m.r32(0x2f32d8) + idx * 0x68; }
  state(car = 0) {
    const e = this.entry(car), f = o => this.m.rf(e + o);
    return { lane: f(0x14), speed: f(0x30), heading: f(0x34), segment: this.m.r32(e + 0x3c), toGo: f(0x40), lapTime: f(0x54), laps: this.m.r32(e + 0x5c) & 0xffff, raceState: this.m.r32(e) };
  }
  drive() {
    this.frames++;
    const s = this.state();
    // pit stop: approach, then hands off while the game drives the car through pit road and the stall
    if (this.pit === "none" && this.pitOnLap && s.laps === this.pitOnLap && s.raceState === 3 && s.segment === this.pitFrom[0] && s.toGo < this.pitFrom[1] && !(s.toGo < (this.pitFrom[2] ?? -Infinity))) this.pit = "approach";
    if (this.pit === "approach" && (s.raceState === 5 || s.raceState === 6)) this.pit = "in";
    if (this.pit === "in" && s.raceState === 3) { this.pit = "done"; this.pits++; this.integ = 0; this.stuck = 0; this.progress = 10; }
    if (this.pit === "in" || (s.raceState !== 3 && s.raceState !== 4)) {
      this.g.pads.set(0, { buttons: 0, analog: [0, 0, 0, 0, 0, 0, 0, 0], lx: 0, ly: 0 }); this.last = { ...s, steer: 0, throttle: 0 }; this.lastDist = s.toGo; return;
    }
    const target = this.pit === "approach" ? this.pitLane : this.target, speedTarget = this.pit === "approach" ? this.pitSpeed : this.speedTarget;
    // progress: distance to the segment end goes down while the car moves forward (it jumps up at a new segment)
    if (this.lastDist !== null) { const d = this.lastDist - s.toGo; if (d > 0 && d < 20) this.progress = this.progress * 0.95 + d * 60 * 0.05; else if (d <= 0 && d > -20) this.progress *= 0.95; }
    this.lastDist = s.toGo;
    // integral term: the turns need a steady lock, which a P-only controller only holds with a steady lane error
    const err = s.lane - target;
    this.integ = Math.max(-0.8, Math.min(0.8, (this.integ ?? 0) + this.kInt * Math.max(-20, Math.min(20, err))));
    let steer = -(this.kLane * err + this.kHead * s.heading + this.integ);
    steer = Math.max(-1, Math.min(1, steer));
    let throttle = Math.max(0, Math.min(255, Math.round(140 + (speedTarget - s.speed) * 8))), brake = s.speed > speedTarget + 5 ? 160 : 0;
    if (Math.abs(s.heading) > 25) throttle = Math.min(throttle, 90);
    // stuck: no forward progress for 2 s -> reverse 1.5 s with the opposite lock
    if (this.reverse > 0) { this.reverse--; this.g.pads.set(0, { buttons: 0, analog: [0, 0, 0, 0, 0, 0, 255, 0], lx: Math.round(-steer * 32767), ly: 0 }); this.last = { ...s, steer: -steer, throttle: -1 }; return; }
    if (this.frames > 180 && this.progress < 5) this.stuck++; else this.stuck = 0;
    if (this.stuck > 120) { this.stuck = 0; this.reverse = 90; this.progress = 10; }
    this.g.pads.set(0, { buttons: 0, analog: [0, 0, 0, 0, 0, 0, brake, throttle], lx: Math.round(steer * 32767), ly: 0 });
    this.last = { ...s, steer, throttle };
  }
}
