// Presentational only: a randomly chosen animation (matrix rain, scramble, typewriter, pixelate, iris,
// fireworks, curtain, can, flag) turns the scanned image into the decoded text.
import { STYLES, type RevealStyle } from './reveal-styles';
// Re-exported so existing imports keep working; the list itself lives in a tiny module that the main page can load
// without pulling in all of the animation code.
export { STYLES, idToStyle, styleToId, type RevealStyle } from './reveal-styles';

export interface RevealOptions {
  canvas: HTMLCanvasElement;
  source: CanvasImageSource & { width: number; height: number };
  text: string;
  mode: 'codeart' | 'stego';
  reduceMotion: boolean;
  /** Force one style (default: pick one at random). */
  style?: RevealStyle;
}
export interface RevealHandle {
  done: Promise<void>;
  skip(): void;
}

const GLYPHS = 'アイウエオカキクケコサシスセソ0123456789ABCDEF#$%&*+<>?/=ｱｲｳｴｵ';
const BG = '11,15,20';
const FONT = 'ui-monospace, Consolas, monospace';
const rnd = () => Math.random();
const glyph = (seed: number) => GLYPHS[(Math.imul(seed, 2654435761) >>> 7) % GLYPHS.length];

interface Cell {
  ch: string;
  x: number;
  y: number;
  lock: number;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  hue: number;
}

export function playReveal(o: RevealOptions): RevealHandle {
  const { canvas } = o;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(280, rect.width);
  const H = Math.max(180, rect.height);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Lay out the text (word wrap, truncated to what fits on stage).
  const fs = 17;
  const lh = 24;
  const pad = 20;
  ctx.font = `${fs}px ${FONT}`;
  const cw = ctx.measureText('M').width;
  const cols = Math.max(8, Math.floor((W - pad * 2) / cw));
  const maxLines = Math.max(1, Math.floor((H - pad * 2) / lh));
  const lines: string[] = [];
  for (const para of o.text.replace(/\t/g, '  ').split('\n')) {
    let cur = '';
    for (const word of para.split(' ')) {
      let w = Array.from(word);
      while (w.length > cols) {
        if (cur) {
          lines.push(cur);
          cur = '';
        }
        lines.push(w.slice(0, cols).join(''));
        w = w.slice(cols);
      }
      const ww = w.join('');
      if (!cur) cur = ww;
      else if (Array.from(cur).length + 1 + w.length <= cols) cur += ' ' + ww;
      else {
        lines.push(cur);
        cur = ww;
      }
    }
    lines.push(cur);
  }
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown[maxLines - 1] = Array.from(shown[maxLines - 1]).slice(0, cols - 1).join('') + '…';
  const cells: Cell[] = [];
  // Centre the block on the stage, each line centred within it.
  const top = Math.max(pad, (H - shown.length * lh) / 2);
  shown.forEach((ln, r) => {
    const chars = Array.from(ln);
    const left = Math.max(pad, (W - chars.length * cw) / 2);
    chars.forEach((ch, c) => cells.push({ ch, x: left + c * cw, y: top + (r + 1) * lh - 7, lock: 0 }));
  });
  const visible = cells.filter((c) => c.ch !== ' ');

  const T_SCAN = 1100;
  const T_RAIN = 700;
  const T_RESOLVE = Math.min(2600, Math.max(900, visible.length * 20));
  const style: RevealStyle = o.style ?? STYLES[Math.floor(rnd() * STYLES.length)];
  canvas.dataset.style = style; // which animation is playing (handy for tests)
  // One character at a time, in reading order, with a pause at each line break (typewriter and printer).
  const perChar = Math.min(80, Math.max(25, 3000 / Math.max(1, visible.length)));
  const typeAt: number[] = [];
  let typeAcc = 0;
  visible.forEach((c, i) => {
    if (i > 0 && visible[i - 1].y !== c.y) typeAcc += 220;
    typeAt.push(typeAcc);
    typeAcc += perChar;
  });
  const T_TYPE = typeAcc;
  const lineYs = [...new Set(visible.map((c) => c.y))]; // one entry per printed line, top to bottom
  const RADAR_REV = 1000; // one sweep of the radar
  const wordCount = Math.max(1, visible.filter((c, i) => i === 0 || visible[i - 1].y !== c.y || c.x - visible[i - 1].x >= cw * 1.01).length);
  const AST_DT = Math.min(350, Math.max(60, 2200 / wordCount)); // time between shots
  const AST_FLIGHT = 260; // how long a bullet takes to reach its rock
  const HEART_RISE = 1000; // how long a heart takes to carry its letter up
  const BLOOM = 500; // how long a flower takes to open
  const BOOM_T = 1000; // when the cartoon bomb goes off, measured from the end of the intro
  const WIZ_SPREAD = Math.max(6500, Math.min(13000, visible.length * 160)); // the magic ink takes its time
  const FLIGHT = 500; // how long a letter takes to fall out of the can
  const FALL = 1100; // how long a parachuted word takes to float down
  const SWARM = 700; // how long a speck of dust takes to fly to its letter
  const RISE = 900; // how long a bubble takes to float up to its place
  const WIN = 1000; // the jackpot celebration after the last reel stops
  const INK = 900; // how long invisible ink takes to darken once the flame reaches it
  const MIN_T = 1800; // a minion's whole trip: run in, throw, cheer, run off
  const AIR_T = 2050; // a helicopter's whole trip: fly in, lower, release, fly off
  const HELI_GAP = Math.min(700, Math.max(250, 3200 / Math.max(1, lineYs.length))); // one helicopter carries each line; this is the wait between them
  const BANNER_T = 2600; // how long the banner plane takes to bring the banner home
  const BAL_POP = 700; // a balloon pops this long after its letter's turn
  const BAL_SHRED = 450; // how long the bits of a popped balloon fly
  const COIN_T = 650; // how long a coin takes to fly out of the chest to its letter
  const PP_T = 1000; // a paper plane's whole trip: glide in, land, unfold
  const GHOST_T = 1100; // how long a letter takes to materialise out of the mist
  const DR_FLY = 650; // how long a letter takes to fly out of the dragon's mouth to its place
  const PNK_LT = Math.min(1700, Math.max(700, 5200 / Math.max(1, lineYs.length))); // its creep along one line
  const PNK_GAP = PNK_LT + 80; // one panther at a time: the next line starts when it is done
  const RR_LT = Math.min(900, Math.max(400, 3000 / Math.max(1, lineYs.length))); // the bird's dash along one line
  const RR_GAP = RR_LT + 60; // one chase at a time
  const RR_LAG = 320; // how far behind the bird the coyote runs
  const RR_BANG = 700; // how long the bang lasts
  const GEN_IN = 700; // the genie is out and ready this long after the intro starts; the words begin after that
  const GEN_FLY = 600; // a letter's flight from the genie's hand to its place
  const RA_LT = Math.min(1900, Math.max(900, 7000 / Math.max(1, lineYs.length))); // the formation's pass along one line (a stately pace)
  const RA_GAP = RA_LT + 60; // one pass at a time
  const IMG_FX: RevealStyle[] = ['dissolve', 'sandfall', 'blackhole', 'hammersmash', 'shatter', 'burnaway', 'shredder', 'melt', 'rainwash', 'acidrain', 'icemelt', 'shaken', 'footsmash']; // the styles that destroy the scanned image
  const FX_DUR = 2200; // how long the destruction takes
  const STEAM = 900; // how long a letter takes to drift up from the chimney to its place
  const T_INTRO = style === 'matrix' ? T_SCAN + T_RAIN : ['curtain', 'moon', 'swarm', 'bubbles', 'ufo', 'spotlight', 'jackpot', 'ink', 'safe', 'train', 'oldtype', 'printer', 'ticker', 'radar', 'parade', 'asteroids', 'hearts', 'flowers', 'bomb', 'wizard', 'minions', 'snowglobe', 'rocket', 'lightning', 'helicopters', 'banner', 'balloons', 'quill', 'dominoes', 'treasure', 'paperplanes', 'ghosts', 'seance', 'poltergeist', 'haunted', 'dragon', 'panther', 'roadrunner', 'genie', 'fartgun', 'arrows', 'tiles', 'witches', 'redarrows', 'pirate', 'fogwriter', 'whale', 'submarine', 'bomber', 'kraken', 'thor', 'spiders', 'hatdance', 'lasers', 'earthquake', 'volcano', 'emoji', 'sharks', 'broomball', 'zombies', 'builder', 'oddbods', ...IMG_FX].includes(style) ? 600 : style === 'film' ? 1400 : style === 'can' || style === 'flag' || style === 'plane' ? 800 : 1000;
  const T_RES =
    style === 'iris' ? 1300
    : style === 'fireworks' ? Math.max(T_RESOLVE, 2200)
    : style === 'curtain' ? 1700
    : style === 'flag' ? 1400
    : style === 'moon' ? 2400
    : style === 'plane' ? Math.max(T_RESOLVE, 1400) + FALL + 100
    : style === 'swarm' ? Math.max(T_RESOLVE, 1400) + SWARM + 100
    : style === 'bubbles' ? Math.max(T_RESOLVE, 1400) + RISE + 200
    : style === 'ufo' ? Math.max(T_RESOLVE, 1400) + 400
    : style === 'spotlight' ? 2400
    : style === 'jackpot' ? Math.max(T_RESOLVE, 1400) + WIN
    : style === 'ink' ? Math.max(3500, Math.min(8000, visible.length * 90)) + INK + 100
    : style === 'safe' ? 2200
    : style === 'train' ? Math.max(T_RESOLVE, 1400) + STEAM + 100
    : style === 'oldtype' || style === 'printer' ? T_TYPE + 200
    : style === 'ticker' ? 200 * (lineYs.length - 1) + 1100 + 150
    : style === 'radar' ? RADAR_REV + 700
    : style === 'film' ? 1900
    : style === 'parade' ? Math.max(T_RESOLVE, 1400) + 300
    : style === 'asteroids' ? (wordCount - 1) * AST_DT + AST_FLIGHT + 600
    : style === 'hearts' ? Math.max(T_RESOLVE, 1400) + HEART_RISE + 300
    : style === 'flowers' ? Math.max(T_RESOLVE, 1400) + BLOOM + 500
    : style === 'bomb' ? BOOM_T + 1000
    : style === 'wizard' ? WIZ_SPREAD + 3600
    : style === 'minions' ? Math.max(T_RESOLVE, 1400) + MIN_T + 200
    : style === 'helicopters' ? HELI_GAP * (lineYs.length - 1) + AIR_T + 300
    : style === 'snowglobe' ? Math.max(T_RESOLVE, 2000) + 1800
    : style === 'rocket' ? T_TYPE + 500
    : style === 'lightning' ? 3600
    : style === 'banner' ? BANNER_T + 600
    : style === 'quill' ? T_TYPE + 700
    : style === 'dominoes' ? T_TYPE + 500
    : style === 'treasure' ? Math.max(T_RESOLVE, 1400) + COIN_T + 150
    : style === 'paperplanes' ? Math.max(T_RESOLVE, 1400) + PP_T + 300
    : style === 'ghosts' ? Math.max(T_RESOLVE, 1800) + GHOST_T + 300
    : style === 'seance' ? Math.max(T_RESOLVE, 1600) + 500
    : style === 'poltergeist' ? Math.max(T_RESOLVE, 1800) + 520 + 200
    : style === 'haunted' ? Math.max(T_RESOLVE, 1400) + 1100 + 450
    : style === 'dragon' ? Math.max(T_RESOLVE, 1800) + DR_FLY + 400
    : style === 'panther' ? PNK_GAP * (lineYs.length - 1) + PNK_LT + 700
    : style === 'genie' ? GEN_IN + Math.max(T_RESOLVE, 1800) + GEN_FLY + 300
    : style === 'fartgun' ? Math.max(T_RESOLVE, 1600) + 380 + 450 + 200
    : style === 'arrows' ? Math.max(T_RESOLVE, 1500) + 420 + 1200
    : style === 'tiles' ? Math.max(T_RESOLVE, 1500) + 450 + 250
    : style === 'witches' ? Math.max(T_RESOLVE, 1500) + 700 + 400 + 200
    : style === 'redarrows' ? RA_GAP * (lineYs.length - 1) + RA_LT + 150 + 1500 + 200
    : style === 'pirate' ? Math.max(T_RESOLVE, 1600) + 400 + 450 + 200
    : style === 'fogwriter' ? Math.max(T_RESOLVE, 2800) + 1600 + 200
    : style === 'whale' ? Math.max(T_RESOLVE, 1800) + 750 + 300
    : style === 'submarine' ? Math.max(T_RESOLVE, 1600) + 450 + 450 + 200
    : style === 'bomber' ? Math.max(T_RESOLVE, 1700) + 650 + 400
    : style === 'kraken' ? Math.max(T_RESOLVE, 1800) + 700 + 700 + 200
    : style === 'thor' ? Math.max(T_RESOLVE, 1700) + 880 + 200
    : style === 'spiders' ? Math.max(T_RESOLVE, 1700) + 900 + 800 + 150
    : style === 'hatdance' ? Math.max(T_RESOLVE, 1800) + 700 + 300
    : style === 'lasers' ? Math.max(T_RESOLVE, 2200) + 900 + 300
    : style === 'earthquake' ? Math.max(T_RESOLVE, 1700) + 1100
    : style === 'volcano' ? Math.max(T_RESOLVE, 1800) + 900 + 300
    : style === 'emoji' ? Math.max(T_RESOLVE, 1800) + 600
    : style === 'builder' ? Math.min(4200, Math.max(1600, wordCount * 330)) + 440 + 700
    : style === 'oddbods' ? Math.max(T_RESOLVE, 1500) + 650 + 560 + 180 + 650 + 200
    : IMG_FX.includes(style) ? FX_DUR + 300
    : style === 'sharks' ? Math.max(T_RESOLVE, 1600) + 1400 + 300
    : style === 'broomball' ? Math.max(T_RESOLVE, 1500) + 700 + 400 + 200
    : style === 'zombies' ? Math.max(T_RESOLVE, 1700) + 800 + 600 + 150
    : style === 'roadrunner' ? RR_GAP * (lineYs.length - 1) + RR_LT + RR_LAG + 350 + RR_BANG + 200
    : style === 'balloons' ? Math.max(T_RESOLVE, 1400) + BAL_POP + BAL_SHRED + 100
    : style === 'can' ? Math.max(T_RESOLVE, 1400) + FLIGHT + 100
    : T_RESOLVE;
  const T_END = T_INTRO + T_RES + 250;
  const spread = style === 'fireworks' ? 0.7 : 0.8;
  const T_LOCK =
    style === 'can' ? T_RES - FLIGHT - 100
    : style === 'swarm' ? T_RES - SWARM - 100
    : style === 'bubbles' ? T_RES - RISE - 200
    : style === 'jackpot' ? T_RES - WIN
    : style === 'ink' ? T_RES - INK - 100
    : style === 'parade' ? T_RES - 300
    : style === 'hearts' ? T_RES - HEART_RISE - 300
    : style === 'flowers' ? T_RES - BLOOM - 500
    : style === 'minions' ? T_RES - MIN_T - 200
    : style === 'snowglobe' ? T_RES - 800
    : style === 'balloons' ? T_RES - BAL_POP - BAL_SHRED - 100
    : style === 'treasure' ? T_RES - COIN_T - 150
    : style === 'paperplanes' ? T_RES - PP_T - 300
    : style === 'ghosts' ? T_RES - GHOST_T - 300
    : style === 'seance' ? T_RES - 500
    : style === 'poltergeist' ? T_RES - 520 - 200
    : style === 'haunted' ? T_RES - 1100 - 450
    : style === 'dragon' ? T_RES - DR_FLY - 400
    : style === 'genie' ? T_RES - GEN_IN - GEN_FLY - 300
    : style === 'fartgun' ? T_RES - 380 - 450 - 200
    : style === 'arrows' ? T_RES - 420 - 1200
    : style === 'tiles' ? T_RES - 450 - 250
    : style === 'witches' ? T_RES - 700 - 400 - 200
    : style === 'pirate' ? T_RES - 400 - 450 - 200
    : style === 'whale' ? T_RES - 750 - 300
    : style === 'submarine' ? T_RES - 450 - 450 - 200
    : style === 'bomber' ? T_RES - 650 - 400
    : style === 'kraken' ? T_RES - 700 - 700 - 200
    : style === 'thor' ? T_RES - 880 - 200
    : style === 'fogwriter' ? T_RES - 1600 - 200
    : style === 'spiders' ? T_RES - 900 - 800 - 150
    : style === 'hatdance' ? T_RES - 700 - 300
    : style === 'lasers' ? T_RES - 900 - 300
    : style === 'earthquake' ? T_RES - 1100
    : style === 'volcano' ? T_RES - 900 - 300
    : style === 'emoji' ? T_RES - 600
    : style === 'sharks' ? T_RES - 1400 - 300
    : style === 'broomball' ? T_RES - 700 - 400 - 200
    : style === 'zombies' ? T_RES - 800 - 600 - 150
    : style === 'builder' ? T_RES - 440 - 700
    : style === 'oddbods' ? T_RES - 650 - 560 - 180 - 650 - 200
    : T_RES;
  visible.forEach((c, i) => (c.lock = (i / Math.max(1, visible.length)) * T_LOCK * spread + rnd() * T_LOCK * 0.15));
  const ease = (p: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 3);

  const drawFinal = () => {
    ctx.fillStyle = `rgb(${BG})`;
    ctx.fillRect(0, 0, W, H);
    ctx.font = `${fs}px ${FONT}`;
    ctx.fillStyle = '#e8fff4';
    ctx.shadowColor = 'rgba(80,255,190,.55)';
    ctx.shadowBlur = 6;
    for (const c of cells) if (c.ch !== ' ') ctx.fillText(c.ch, c.x, c.y);
    ctx.shadowBlur = 0;
  };

  if (o.reduceMotion) {
    drawFinal();
    return { done: Promise.resolve(), skip() {} };
  }

  const sc = Math.min((W - 24) / o.source.width, (H - 24) / o.source.height);
  const iw = o.source.width * sc;
  const ih = o.source.height * sc;
  const ix = (W - iw) / 2;
  const iy = (H - ih) / 2;
  const colW = 16;
  const drops = Array.from({ length: Math.ceil(W / colW) }, () => rnd() * -H);

  let skipped = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const t0 = performance.now();
  let rainStarted = false;

  const clear = () => {
    ctx.fillStyle = `rgb(${BG})`;
    ctx.fillRect(0, 0, W, H);
  };

  const rain = (fade: number) => {
    if (fade) {
      ctx.fillStyle = `rgba(${BG},${fade})`;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.font = `14px ${FONT}`;
    drops.forEach((y, i) => {
      ctx.fillStyle = 'rgba(190,255,225,.95)';
      ctx.fillText(glyph(i * 31 + Math.floor(rnd() * 1e6)), i * colW, y);
      drops[i] = y > H + rnd() * 200 ? rnd() * -80 : y + 9 + rnd() * 6;
    });
  };

  /** The image with a sweeping scan line. */
  const drawScan = (p: number, imgAlpha = 1) => {
    clear();
    ctx.globalAlpha = imgAlpha;
    ctx.drawImage(o.source, ix, iy, iw, ih);
    ctx.globalAlpha = 1;
    const sx = ix + iw * p;
    ctx.fillStyle = 'rgba(20,200,170,.22)';
    ctx.fillRect(ix, iy, sx - ix, ih);
    const n = o.mode === 'codeart' ? 90 : 160;
    const sz = o.mode === 'codeart' ? 6 : 1.5;
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = `rgba(190,255,235,${0.15 + rnd() * 0.5})`;
      ctx.fillRect(ix + rnd() * (sx - ix), iy + rnd() * ih, sz, sz);
    }
    const g = ctx.createLinearGradient(sx - 40, 0, sx + 2, 0);
    g.addColorStop(0, 'rgba(60,255,200,0)');
    g.addColorStop(1, 'rgba(120,255,220,.9)');
    ctx.fillStyle = g;
    ctx.fillRect(sx - 40, iy, 42, ih);
  };

  const small = document.createElement('canvas');
  /** The image as coarse blocks (block = source pixels per block). */
  const drawPixels = (block: number, alpha: number) => {
    small.width = Math.max(1, Math.round(iw / block));
    small.height = Math.max(1, Math.round(ih / block));
    small.getContext('2d')!.drawImage(o.source, 0, 0, small.width, small.height);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = alpha;
    ctx.drawImage(small, ix, iy, iw, ih);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
  };

  /** Draws the text cells `on` accepts; the rest show cycling glyphs when `scramble` is set. */
  const drawCells = (r: number, on: (c: Cell, i: number) => boolean, scramble: boolean, glow = true) => {
    ctx.font = `${fs}px ${FONT}`;
    const bucket = Math.floor(r / 70);
    visible.forEach((c, i) => {
      if (on(c, i)) {
        const fresh = glow && r - c.lock < 160;
        ctx.fillStyle = fresh ? '#7dffe0' : '#e8fff4';
        ctx.shadowColor = 'rgba(80,255,190,.6)';
        ctx.shadowBlur = fresh ? 12 : 5;
        ctx.fillText(c.ch, c.x, c.y);
      } else if (scramble) {
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(70,220,160,.75)';
        ctx.fillText(glyph(bucket * 977 + i), c.x, c.y);
      }
    });
    ctx.shadowBlur = 0;
  };

  // Fireworks: rockets climb, burst into sparks, and the text lights up as the bursts go off.
  let sparks: Spark[] = [];
  const bursts = Array.from({ length: 6 }, (_, i) => ({
    at: 350 + (i / 6) * T_RES * 0.7 + rnd() * 120,
    x: W * (0.15 + rnd() * 0.7),
    y: H * (0.2 + rnd() * 0.35),
    fired: false,
  }));
  const explode = (x: number, y: number) => {
    const hue = Math.floor(rnd() * 360);
    for (let i = 0; i < 70; i++) {
      const a = rnd() * Math.PI * 2;
      const v = 1 + rnd() * 3.2;
      sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, hue: hue + rnd() * 40 });
    }
  };
  const drawFireworks = (r: number) => {
    ctx.fillStyle = `rgba(${BG},.28)`;
    ctx.fillRect(0, 0, W, H);
    for (const b of bursts) {
      if (r >= b.at - 350 && r < b.at) {
        const y = H + (b.y - H) * ((r - (b.at - 350)) / 350);
        ctx.fillStyle = '#fff4c0';
        ctx.fillRect(b.x - 1, y, 2, 8);
      } else if (!b.fired && r >= b.at) {
        b.fired = true;
        explode(b.x, b.y);
      }
    }
    sparks = sparks.filter((s) => s.life > 0);
    for (const s of sparks) {
      s.x += s.vx;
      s.y += s.vy;
      s.vy += 0.045;
      s.vx *= 0.985;
      s.life -= 0.014;
      ctx.fillStyle = `hsla(${s.hue},100%,65%,${Math.max(0, s.life)})`;
      ctx.fillRect(s.x, s.y, 2.2, 2.2);
    }
    drawCells(r, (c) => r >= c.lock, false);
  };

  // Old typewriter: a sheet feeds in, keys strike one at a time, and the bell dings at the end of a line.
  const fadeToFinal = (r: number) => {
    if (r > T_RES) {
      ctx.globalAlpha = Math.min(1, (r - T_RES) / 250);
      drawFinal();
      ctx.globalAlpha = 1;
    }
  };
  const latest = (r: number) => {
    let last = -1;
    while (last + 1 < visible.length && r >= typeAt[last + 1]) last++;
    return last;
  };
  const drawOldType = (r: number, t: number) => {
    clear();
    const off = r < 0 ? (1 - ease(t / T_INTRO)) * H : 0;
    ctx.save();
    ctx.translate(0, off);
    const pg = ctx.createLinearGradient(0, 0, 0, H);
    pg.addColorStop(0, '#f6eed8');
    pg.addColorStop(1, '#e6dabb');
    ctx.fillStyle = pg;
    ctx.fillRect(0, -4, W, H + 4);
    ctx.font = `${fs}px ${FONT}`;
    const last = latest(r);
    for (let i = 0; i <= last; i++) {
      const c = visible[i];
      const fresh = r - typeAt[i] < 80; // a fresh strike is inked a little off-line
      ctx.fillStyle = 'rgba(25,25,30,.92)';
      ctx.fillText(c.ch, c.x + (fresh ? Math.sin(i * 12.9898) * 1.2 : 0), c.y + (fresh ? 1 : 0));
    }
    ctx.restore();
    const my = H - 46;
    ctx.fillStyle = '#2a2f36';
    ctx.fillRect(0, my, W, 46);
    ctx.fillStyle = '#8a949e';
    ctx.fillRect(0, my, W, 4);
    ctx.fillStyle = '#14171b'; // platen roller
    ctx.fillRect(0, my - 8, W, 10);
    ctx.fillStyle = '#3b434b';
    ctx.fillRect(0, my - 7, W, 2);
    const nKeys = Math.max(6, Math.floor((W - 30) / 26));
    const cur = last >= 0 ? visible[last] : undefined;
    const age = cur ? r - typeAt[last] : 1e9;
    const pressed = cur ? (cur.ch.charCodeAt(0) * 7 + last) % nKeys : -1;
    for (let k = 0; k < nKeys; k++) {
      const kx = 18 + k * ((W - 36) / (nKeys - 1));
      const down = k === pressed && age < 90 ? 2 : 0;
      ctx.fillStyle = down ? '#555' : '#1a1e23';
      ctx.strokeStyle = '#9aa4ae';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(kx, my + 26 + down, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // The metal type ball rides along the line on its carriage, spins round to the next character, then strikes.
    const nxt = last + 1 < visible.length ? visible[last + 1] : undefined;
    const spinFor = (ch: string) => (ch.charCodeAt(0) * 0.61) % (Math.PI * 2);
    let hx = visible[0] ? visible[0].x + cw / 2 : W / 2;
    let hy = visible[0] ? visible[0].y : H / 2;
    let spin = 0;
    if (cur) {
      const k = nxt ? clamp01((r - typeAt[last]) / (typeAt[last + 1] - typeAt[last])) : 1;
      const ke = ease(k);
      hx = nxt ? cur.x + cw / 2 + (nxt.x - cur.x) * ke : cur.x + cw / 2;
      hy = nxt && nxt.y !== cur.y ? cur.y + (nxt.y - cur.y) * clamp01((k - 0.3) / 0.4) : cur.y; // carriage return
      spin = nxt ? spinFor(cur.ch) + (spinFor(nxt.ch) - spinFor(cur.ch) + Math.PI * 2) * ke : spinFor(cur.ch);
    }
    const strike = cur && age < 70 ? 5 : 0;
    const bR = 13;
    const bcy = hy - fs - 14 + strike; // centre of the ball, above the line being typed
    ctx.fillStyle = '#6b747d'; // the rail the carriage slides on
    ctx.fillRect(0, hy - fs - 40, W, 4);
    ctx.fillStyle = '#4a535c';
    ctx.fillRect(hx - 18, hy - fs - 40, 36, 12);
    ctx.fillRect(hx - 4, hy - fs - 30, 8, bcy - (hy - fs - 30)); // the arm holding the ball
    const bg =ctx.createRadialGradient(hx - 4, bcy - 4, 2, hx, bcy, bR);
    bg.addColorStop(0, '#f4f7fa');
    bg.addColorStop(0.6, '#a3adb8');
    bg.addColorStop(1, '#4a535c');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(hx, bcy, bR, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = 'bold 6px monospace'; // the raised characters round the ball turn with it
    ctx.fillStyle = 'rgba(25,30,36,.85)';
    const faces = 'ETAOINSHRDLUCMFWYPGBVKXQJZ0123456789.,';
    for (let row = 0; row < 3; row++) {
      for (let j = 0; j < 9; j++) {
        const phi = spin + (j / 9) * Math.PI * 2;
        const c = Math.cos(phi);
        if (c < 0.2) continue;
        ctx.save();
        ctx.translate(hx + Math.sin(phi) * (bR - 2), bcy + (row - 1) * 6);
        ctx.scale(c, 1);
        ctx.fillText(faces[(j * 7 + row * 13) % faces.length], -2, 2);
        ctx.restore();
      }
    }
    ctx.fillStyle = '#2a2f36'; // the ribbon guide between the ball and the paper
    ctx.fillRect(hx - 9, bcy + bR - 1, 18, 5);
    if (strike) {
      ctx.fillStyle = 'rgba(20,20,25,.55)';
      ctx.fillRect(hx - 4, hy - fs * 0.75, 8, 3);
    }
    if (cur && age < 350 && (last + 1 >= visible.length || visible[last + 1].y !== cur.y)) {
      ctx.fillStyle = '#c9a227';
      ctx.font = 'italic bold 14px serif';
      ctx.fillText('ding!', W - 56, my - 18);
    }
    fadeToFinal(r);
  };

  // Mechanical printer: greenbar fanfold paper; a print head shuttles along each line and prints it.
  const drawPrinter = (r: number, t: number) => {
    clear();
    const off = r < 0 ? (1 - ease(t / T_INTRO)) * H : 0;
    const holeW = 18;
    ctx.save();
    ctx.translate(0, off);
    ctx.fillStyle = '#f4f6ef';
    ctx.fillRect(0, -4, W, H + 4);
    ctx.fillStyle = '#dcebd5';
    for (let y = 4; y < H; y += lh * 4) ctx.fillRect(holeW, y, W - holeW * 2, lh * 2);
    ctx.fillStyle = '#e6e9df';
    ctx.fillRect(0, -4, holeW, H + 4);
    ctx.fillRect(W - holeW, -4, holeW, H + 4);
    ctx.fillStyle = '#9aa09a';
    for (let y = 8; y < H; y += 16) {
      ctx.beginPath();
      ctx.arc(holeW / 2, y, 3, 0, Math.PI * 2);
      ctx.arc(W - holeW / 2, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(0,0,0,.08)';
    ctx.fillRect(holeW, -4, 1, H + 4);
    ctx.fillRect(W - holeW, -4, 1, H + 4);
    ctx.font = `${fs}px ${FONT}`;
    const last = latest(r);
    for (let i = 0; i <= last; i++) {
      const c = visible[i];
      ctx.fillStyle = 'rgba(27,42,58,.95)';
      ctx.fillText(c.ch, c.x, c.y);
      ctx.fillStyle = 'rgba(27,42,58,.45)'; // second pass, as a dot-matrix head would strike
      ctx.fillText(c.ch, c.x + 0.6, c.y);
    }
    ctx.restore();
    // the head rides a rail across the page, and parks at the side when idle
    const cur = last >= 0 ? visible[last] : undefined;
    const nxt = last + 1 < visible.length ? visible[last + 1] : undefined;
    let hx = holeW + 4;
    let hy = (visible[0]?.y ?? H / 2) + off;
    if (cur) {
      const k = nxt ? Math.min(1, (r - typeAt[last]) / (typeAt[last + 1] - typeAt[last])) : 1;
      hx = nxt ? cur.x + (nxt.x - cur.x) * k : W - holeW - 14;
      hy = cur.y + (nxt ? (nxt.y - cur.y) * (k > 0.5 && nxt.y !== cur.y ? 1 : 0) : 0) + off;
    }
    hy += Math.sin(t * 0.9) * 0.8;
    ctx.fillStyle = '#555c64';
    ctx.fillRect(holeW, hy - 22, W - holeW * 2, 4);
    ctx.fillStyle = '#2b2f36';
    ctx.fillRect(hx - 5, hy - 28, 14, 22);
    ctx.fillStyle = '#8a949e';
    ctx.fillRect(hx - 5, hy - 28, 14, 3);
    ctx.fillStyle = '#2b2f36';
    ctx.beginPath();
    ctx.moveTo(hx - 3, hy - 6);
    ctx.lineTo(hx + 7, hy - 6);
    ctx.lineTo(hx + 2, hy + 1);
    ctx.fill();
    if (cur && r - typeAt[last] < perChar) {
      ctx.fillStyle = 'rgba(40,60,90,.7)';
      ctx.fillRect(hx + 1, hy + 1, 2, 2);
    }
    fadeToFinal(r);
  };

  // Ticker tape: each line is its own strip of paper tape that runs in from the right.
  const lineCells = lineYs.map((ly) => visible.filter((c) => c.y === ly));
  const drawTicker = (r: number) => {
    clear();
    lineYs.forEach((ly, i) => {
      const top = ly - lh + 9;
      const h = lh - 6;
      ctx.fillStyle = 'rgba(255,255,255,.05)'; // the empty guide the tape will run along
      ctx.fillRect(0, top, W, h);
      const p = clamp01((r - i * 200) / 1100);
      if (r < i * 200) return;
      ctx.save();
      ctx.translate((1 - ease(p)) * (W + 40), 0);
      ctx.fillStyle = '#f3ecd6';
      ctx.fillRect(0, top, W, h);
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      ctx.fillRect(0, top, W, 1);
      ctx.fillRect(0, top + h - 1, W, 1);
      ctx.fillRect(0, top, 2, h); // the ragged leading end of the tape
      for (let x = 7; x < W; x += 14) {
        ctx.beginPath();
        ctx.arc(x, top + h / 2, 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.font = `${fs}px ${FONT}`;
      ctx.fillStyle = '#22201a';
      for (const c of lineCells[i]) ctx.fillText(c.ch, c.x, c.y);
      ctx.restore();
    });
    fadeToFinal(r);
  };

  // Radar: a sweep goes round the stage and each letter blips into view as it passes.
  const rcx = W / 2;
  const rcy = H / 2;
  const radarAt = visible.map((c) => (((Math.atan2(c.y - fs * 0.3 - rcy, c.x + cw / 2 - rcx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * RADAR_REV);
  const drawRadar = (r: number) => {
    clear();
    const R = Math.hypot(W, H) / 2;
    ctx.strokeStyle = 'rgba(60,255,140,.18)';
    ctx.lineWidth = 1;
    for (let k = 1; k <= 5; k++) {
      ctx.beginPath();
      ctx.arc(rcx, rcy, ((R * k) / 5) * 0.8, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(rcx, 0);
    ctx.lineTo(rcx, H);
    ctx.moveTo(0, rcy);
    ctx.lineTo(W, rcy);
    ctx.stroke();
    const a = (r / RADAR_REV) * Math.PI * 2;
    for (let k = 0; k < 24; k++) {
      ctx.fillStyle = `rgba(40,255,120,${0.2 * (1 - k / 24)})`;
      ctx.beginPath();
      ctx.moveTo(rcx, rcy);
      ctx.arc(rcx, rcy, R, a - (k + 1) * 0.04, a - k * 0.04);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(140,255,180,.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(rcx, rcy);
    ctx.lineTo(rcx + Math.cos(a) * R, rcy + Math.sin(a) * R);
    ctx.stroke();
    ctx.font = `${fs}px ${FONT}`;
    visible.forEach((c, i) => {
      if (r < radarAt[i]) return;
      const fresh = r - radarAt[i] < 350;
      ctx.fillStyle = fresh ? '#d6ffe4' : '#b8ffd0';
      ctx.shadowColor = 'rgba(60,255,140,.9)';
      ctx.shadowBlur = fresh ? 16 : 5;
      ctx.fillText(c.ch, c.x, c.y);
    });
    ctx.shadowBlur = 0;
    fadeToFinal(r);
  };

  // Old film: a 3-2-1 countdown leader, then the text flickers up through scratches and grain.
  const drawFilm = (r: number, t: number) => {
    ctx.save();
    ctx.translate((rnd() - 0.5) * 3, (rnd() - 0.5) * 3);
    if (r < 0) {
      ctx.fillStyle = '#b8b2a0';
      ctx.fillRect(-4, -4, W + 8, H + 8);
      const rad = Math.min(W, H) * 0.32;
      const cx = W / 2;
      const cy = H / 2;
      ctx.strokeStyle = '#2a2620';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.moveTo(cx - rad * 1.3, cy);
      ctx.lineTo(cx + rad * 1.3, cy);
      ctx.moveTo(cx, cy - rad * 1.3);
      ctx.lineTo(cx, cy + rad * 1.3);
      ctx.stroke();
      const step = Math.min(2, Math.floor(t / 450));
      ctx.fillStyle = 'rgba(30,26,20,.25)'; // the clock wipe
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + ((t % 450) / 450) * Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2a2620';
      ctx.font = `bold ${Math.round(rad * 1.3)}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(3 - step), cx, cy + rad * 0.05);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    } else {
      ctx.fillStyle = '#1b150d';
      ctx.fillRect(-4, -4, W + 8, H + 8);
      ctx.font = `${fs}px ${FONT}`;
      ctx.globalAlpha = clamp01(r / 700) * (0.8 + rnd() * 0.2);
      ctx.fillStyle = '#f4e5bd';
      ctx.shadowColor = 'rgba(255,200,120,.8)';
      ctx.shadowBlur = 4;
      for (const c of visible) ctx.fillText(c.ch, c.x, c.y);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    ctx.fillStyle = `rgba(0,0,0,${rnd() * 0.12})`; // projector flicker
    ctx.fillRect(0, 0, W, H);
    if (rnd() < 0.35) {
      ctx.fillStyle = 'rgba(255,255,255,.25)';
      ctx.fillRect(rnd() * W, 0, 1, H);
    }
    for (let k = 0; k < 14; k++) {
      ctx.fillStyle = `rgba(255,255,255,${0.1 + rnd() * 0.25})`;
      ctx.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 1.5, 1 + rnd() * 1.5);
    }
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) / 2);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,.6)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    fadeToFinal(r);
  };

  // Parade: ticker-tape streamers and confetti rain down; the letters pop in as it falls.
  const confetti = Array.from({ length: 90 }, () => ({ x: rnd() * W, o: rnd() * H, vy: 0.05 + rnd() * 0.08, ph: rnd() * 6, h: Math.floor(rnd() * 360) }));
  const ribbons = Array.from({ length: 14 }, () => ({ x: rnd() * W, v: 0.25 + rnd() * 0.25, ph: rnd() * 6, h: Math.floor(rnd() * 360), d: rnd() * 500 }));
  const drawParade = (r: number, t: number) => {
    clear();
    ctx.lineWidth = 3;
    for (const b of ribbons) {
      const head = ((t - b.d) * b.v) % (H + 160);
      if (t < b.d) continue;
      ctx.strokeStyle = `hsla(${b.h},85%,60%,.85)`;
      ctx.beginPath();
      for (let j = 0; j <= 14; j++) {
        const x = b.x + Math.sin(j * 0.35 + t / 350 + b.ph) * 12;
        if (j === 0) ctx.moveTo(x, head);
        else ctx.lineTo(x, head - j * 10);
      }
      ctx.stroke();
    }
    for (const k of confetti) {
      const y = ((t * k.vy + k.o) % (H + 20)) - 10;
      ctx.save();
      ctx.translate(k.x + Math.sin(t / 400 + k.ph) * 20, y);
      ctx.rotate(t / 150 + k.ph);
      ctx.fillStyle = `hsl(${k.h},85%,62%)`;
      ctx.fillRect(-3, -1.5, 6, 3);
      ctx.restore();
    }
    ctx.font = `${fs}px ${FONT}`;
    for (const c of visible) {
      const k = clamp01((r - c.lock) / 260);
      if (k <= 0) continue;
      ctx.save();
      ctx.translate(c.x + cw / 2, c.y - fs * 0.3);
      ctx.scale(1 + (1 - k) * 0.9, 1 + (1 - k) * 0.9);
      ctx.globalAlpha = k;
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(255,255,255,.8)';
      ctx.shadowBlur = k < 1 ? 10 : 4;
      ctx.fillText(c.ch, -cw / 2, fs * 0.3);
      ctx.restore();
    }
  };

  // Train: a night express rolls through the snow; the letters puff out of its chimney and drift up into place.
  const FLYT = T_INTRO + Math.max(T_RESOLVE, 1400);
  const TX0 = -20; // chimney x at t = 0 (the rest of the train is still off the left edge)
  const TSPAN = W + 320; // chimney travel until the tail has left the right edge
  const trainX = (t: number) => TX0 + TSPAN * (t / FLYT);
  const BASE = H - 22;
  const CHIM_Y = BASE - 46;
  const flakes = Array.from({ length: 45 }, () => ({ x: rnd() * W, ph: rnd(), sp: 0.02 + rnd() * 0.03 }));
  const drawTrain = (t: number) => {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#0e1b33');
    sky.addColorStop(1, '#1d3555');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    for (const s of stars) {
      ctx.fillStyle = `rgba(255,255,255,${0.3 + 0.3 * Math.sin(t / 300 + s.ph)})`;
      ctx.fillRect(s.x, s.y * 0.8, s.s, s.s);
    }
    // snowy ground and rails
    ctx.fillStyle = '#dfe9f2';
    ctx.fillRect(0, BASE, W, H - BASE);
    ctx.fillStyle = '#6b7783';
    ctx.fillRect(0, BASE + 1, W, 2);
    // smoke: stateless puffs left in the air where the chimney was
    const k1 = Math.floor(t / 70);
    for (let k = k1; k > k1 - 14; k--) {
      const tb = k * 70;
      if (tb < 0) continue;
      const age = t - tb;
      const a = 0.4 * (1 - age / 980);
      if (a <= 0) continue;
      ctx.fillStyle = `rgba(235,240,247,${a})`;
      ctx.beginPath();
      ctx.arc(trainX(tb) - age * 0.02 + Math.sin(k) * 3, CHIM_Y - age * 0.05, 4 + age * 0.012, 0, Math.PI * 2);
      ctx.fill();
    }
    // the letters, each one launched when the chimney is under its spot
    ctx.font = `${fs}px ${FONT}`;
    for (const c of visible) {
      const tl = ((c.x - TX0) / TSPAN) * FLYT;
      const q = (t - tl) / STEAM;
      if (q < 0) continue;
      const k = Math.min(1, q);
      const e = ease(k);
      const x = c.x + Math.sin(k * 6) * 10 * (1 - k);
      const y = CHIM_Y + (c.y - CHIM_Y) * e;
      if (k < 1) {
        ctx.fillStyle = `rgba(240,244,250,${0.5 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(x + cw / 2, y - fs * 0.3, 9 + 12 * k, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = k < 1 ? '#ffffff' : '#e8fff4';
      ctx.shadowColor = 'rgba(80,255,190,.6)';
      ctx.shadowBlur = k < 1 ? 10 : 5;
      ctx.fillText(c.ch, x, y);
    }
    ctx.shadowBlur = 0;
    // the train, facing right; origin at the chimney
    ctx.save();
    ctx.translate(trainX(t), BASE);
    for (let k = 0; k < 2; k++) {
      const x0 = -170 - k * 106;
      ctx.fillStyle = '#6d1f2a';
      ctx.fillRect(x0, -38, 100, 34);
      ctx.fillStyle = '#3a1218';
      ctx.fillRect(x0 - 2, -40, 104, 4);
      ctx.fillStyle = '#ffd77a';
      for (let j = 0; j < 5; j++) ctx.fillRect(x0 + 8 + j * 18, -32, 12, 12);
      ctx.fillStyle = '#222';
      for (const wx of [14, 86]) {
        ctx.beginPath();
        ctx.arc(x0 + wx, -4, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillRect(x0 + 100, -14, 6, 3); // coupling
    }
    ctx.fillStyle = '#1d2329'; // boiler
    ctx.fillRect(-60, -34, 96, 22);
    ctx.fillStyle = '#6d1f2a'; // cab
    ctx.fillRect(-62, -48, 34, 36);
    ctx.fillStyle = '#3a1218';
    ctx.fillRect(-65, -50, 40, 4);
    ctx.fillStyle = '#ffd77a';
    ctx.fillRect(-56, -42, 14, 12);
    ctx.fillStyle = '#111'; // chimney with a flared top
    ctx.fillRect(-5, -44, 10, 12);
    ctx.beginPath();
    ctx.moveTo(-9, -46);
    ctx.lineTo(9, -46);
    ctx.lineTo(5, -42);
    ctx.lineTo(-5, -42);
    ctx.fill();
    ctx.fillStyle = '#c9a227'; // dome
    ctx.beginPath();
    ctx.ellipse(-26, -34, 8, 6, 0, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#333'; // cowcatcher
    ctx.beginPath();
    ctx.moveTo(36, -12);
    ctx.lineTo(54, -3);
    ctx.lineTo(36, -3);
    ctx.fill();
    const beam = ctx.createLinearGradient(38, 0, 160, 0);
    beam.addColorStop(0, 'rgba(255,246,176,.35)');
    beam.addColorStop(1, 'rgba(255,246,176,0)');
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(38, -25);
    ctx.lineTo(160, -50);
    ctx.lineTo(160, 0);
    ctx.lineTo(38, -22);
    ctx.fill();
    ctx.fillStyle = '#fff6b0';
    ctx.beginPath();
    ctx.arc(36, -24, 4, 0, Math.PI * 2);
    ctx.fill();
    const spin = trainX(t) * 0.12;
    for (const wx of [-40, -12, 16]) {
      ctx.fillStyle = '#2a2f36';
      ctx.strokeStyle = '#c9a227';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(wx, -9, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(wx + Math.cos(spin) * 8, -9 + Math.sin(spin) * 8);
      ctx.lineTo(wx - Math.cos(spin) * 8, -9 - Math.sin(spin) * 8);
      ctx.stroke();
    }
    ctx.restore();
    // falling snow, in front of everything
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    for (const f of flakes) {
      const y = ((t * f.sp + f.ph * H) % H + H) % H;
      ctx.fillRect(f.x + Math.sin(t / 700 + f.ph * 9) * 6, y, 2, 2);
    }
  };

  // Safe: a vault door; the dial spins to the combination, the bolts slide back, the door swings open.
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
  const drawSafe = (p: number, t: number, intro: boolean) => {
    const open = clamp01((p - 0.6) / 0.4);
    // inside the vault: warm light on the text
    clear();
    const warm = 0.6 * (1 - clamp01((p - 0.9) / 0.1));
    const ig = ctx.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, Math.hypot(W, H) / 2);
    ig.addColorStop(0, `rgba(120,90,30,${warm})`);
    ig.addColorStop(1, `rgba(${BG},0)`);
    ctx.fillStyle = ig;
    ctx.fillRect(0, 0, W, H);
    drawCells(0, () => true, false, false);

    const bolts = clamp01((p - 0.4) / 0.15);
    const dialAng = intro ? t / 180 : Math.sin(clamp01(p / 0.4) * Math.PI * 3) * Math.PI * 2 * (1 - clamp01(p / 0.4) * 0.5);
    const ang = ease(open) * 1.5;
    const sx = Math.max(0.07, Math.cos(ang));
    const alpha = open > 0.92 ? (1 - open) / 0.08 : 1;
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.transform(sx, 0, 0, 1, 0, 0); // swinging about the left-hand hinge
    const dg = ctx.createLinearGradient(0, 0, W, H);
    dg.addColorStop(0, '#7b8793');
    dg.addColorStop(1, '#4a545e');
    ctx.fillStyle = dg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#2f373e';
    ctx.lineWidth = 3;
    ctx.strokeRect(12, 12, W - 24, H - 24);
    ctx.fillStyle = '#9aa6b1';
    for (let x = 22; x < W - 12; x += 34) {
      for (const y of [20, H - 20]) {
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // dial
    const cx = W / 2 - 20;
    const cy = H / 2;
    const R = Math.min(W, H) * 0.28;
    ctx.fillStyle = '#2d343b';
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    const fg = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.1, cx, cy, R * 0.9);
    fg.addColorStop(0, '#c4ccd4');
    fg.addColorStop(1, '#7e8a96');
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.88, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2d343b';
    ctx.lineWidth = 1.5;
    for (let k = 0; k < 40; k++) {
      const a = dialAng + (k / 40) * Math.PI * 2;
      const len = k % 5 === 0 ? 0.2 : 0.1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R * 0.86, cy + Math.sin(a) * R * 0.86);
      ctx.lineTo(cx + Math.cos(a) * R * (0.86 - len), cy + Math.sin(a) * R * (0.86 - len));
      ctx.stroke();
    }
    ctx.fillStyle = '#6b7783';
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d33';
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy - R - 6);
    ctx.lineTo(cx + 5, cy - R - 6);
    ctx.lineTo(cx, cy - R + 4);
    ctx.fill();
    // handle: a lever that swings down as the bolts withdraw
    const hx = cx + R * 1.6;
    ctx.save();
    ctx.translate(hx, cy);
    ctx.rotate(bolts * (Math.PI / 2));
    ctx.fillStyle = '#d6dde4';
    ctx.fillRect(-4, -5, 34, 10);
    ctx.fillStyle = '#2d343b';
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // bolts at the free edge
    ctx.fillStyle = '#c9d1d8';
    const bl = 22 * (1 - bolts);
    for (const f of [0.25, 0.5, 0.75]) ctx.fillRect(W - 4 - bl, H * f - 5, bl, 10);
    ctx.restore();
  };

  // Invisible ink: blank parchment; a flame travels along the writing and the heat makes it appear.
  const drawInk = (r: number, t: number) => {
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, Math.hypot(W, H) / 2);
    g.addColorStop(0, '#ecdcb2');
    g.addColorStop(1, '#c9b27a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.font = `${fs}px ${FONT}`;
    let front = -1;
    visible.forEach((c, i) => {
      const k = (r - c.lock) / INK;
      if (k <= 0) return;
      front = Math.max(front, i);
      const a = Math.min(1, k);
      ctx.fillStyle = `rgba(${Math.round(230 - 156 * a)},${Math.round(120 - 76 * a)},${Math.round(30 - 12 * a)},${Math.min(1, k * 3)})`;
      ctx.fillText(c.ch, c.x, c.y);
    });
    const lead = visible[Math.max(0, front)];
    if (lead) {
      const life = Math.min(1, Math.max(0, 1 - (r - T_LOCK) / 300));
      const fx = lead.x + cw / 2 - (front < 0 ? 30 : 0);
      const fy = lead.y + 12;
      const fl = Math.sin(t / 45) * 2 + Math.sin(t / 23);
      ctx.globalAlpha = life;
      const glow = ctx.createRadialGradient(fx, fy - 4, 2, fx, fy - 4, 46);
      glow.addColorStop(0, 'rgba(255,170,60,.55)');
      glow.addColorStop(1, 'rgba(255,170,60,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(fx - 50, fy - 54, 100, 100);
      ctx.fillStyle = '#ff9a2e';
      ctx.beginPath();
      ctx.ellipse(fx, fy - 4, 4.5, 9 + fl, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff2a8';
      ctx.beginPath();
      ctx.ellipse(fx, fy - 1, 2.2, 5 + fl / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (r > T_RES) {
      // the parchment fades into the dark stage the other styles end on
      ctx.globalAlpha = Math.min(1, (r - T_RES) / 250);
      drawFinal();
      ctx.globalAlpha = 1;
    }
  };

  // Jackpot: every letter is a slot reel; they stop one by one, then lights flash and coins pour down.
  const coins = Array.from({ length: 70 }, () => ({ x: rnd() * W, d: rnd() * 600, vy: 0.25 + rnd() * 0.25, ph: rnd() * 6 }));
  const drawJackpot = (r: number, t: number) => {
    clear();
    const win = r >= T_LOCK;
    const rw = r - T_LOCK;
    if (win) {
      ctx.fillStyle = `rgba(255,200,40,${0.07 + 0.06 * Math.sin(rw / 60)})`;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.font = `${fs}px ${FONT}`;
    visible.forEach((c, i) => {
      const boxTop = c.y - lh + 7;
      if (r < c.lock) {
        const pos = t * 0.5 + i * 13;
        const off = pos % lh;
        ctx.save();
        ctx.beginPath();
        ctx.rect(c.x - 1, boxTop, cw + 2, lh);
        ctx.clip();
        ctx.fillStyle = 'rgba(255,255,255,.07)';
        ctx.fillRect(c.x - 1, boxTop, cw + 2, lh);
        ctx.fillStyle = 'rgba(255,225,130,.85)';
        ctx.fillText(glyph(i * 31 + Math.floor(pos / lh)), c.x, boxTop + off + fs - 4);
        ctx.fillText(glyph(i * 31 + Math.floor(pos / lh) - 1), c.x, boxTop + off - lh + fs - 4);
        ctx.restore();
      } else {
        const k = Math.min(1, (r - c.lock) / 220);
        ctx.fillStyle = win ? '#fff3c0' : '#e8fff4';
        ctx.shadowColor = win ? 'rgba(255,200,40,.9)' : 'rgba(80,255,190,.6)';
        ctx.shadowBlur = win ? 10 : 5;
        ctx.fillText(c.ch, c.x, c.y - Math.sin(k * Math.PI) * 5);
        ctx.shadowBlur = 0;
      }
    });
    if (win && top >= 48) {
      const s = 1 + 0.08 * Math.sin(rw / 70);
      ctx.save();
      ctx.translate(W / 2, top - 16);
      ctx.scale(s, s);
      ctx.font = `bold 22px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffd24a';
      ctx.shadowColor = 'rgba(255,160,0,.95)';
      ctx.shadowBlur = 14;
      ctx.fillText('JACKPOT!', 0, 0);
      ctx.restore();
      ctx.shadowBlur = 0;
    }
    if (win) {
      for (const k of coins) {
        const y = -10 + k.vy * (rw - k.d);
        if (rw < k.d || y > H + 10) continue;
        const w = 1 + 5 * Math.abs(Math.cos(rw / 90 + k.ph));
        ctx.fillStyle = '#ffd24a';
        ctx.strokeStyle = '#b8860b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(k.x, y, w, 6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    // marquee bulbs round the edge, chasing slowly while spinning and flashing fast on the win
    let n = 0;
    const step = Math.floor(t / (win ? 90 : 220));
    const bulb = (x: number, y: number) => {
      ctx.fillStyle = (n++ + step) % 3 === 0 ? '#fff0a0' : 'rgba(255,170,40,.35)';
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    };
    for (let x = 8; x < W - 4; x += 20) bulb(x, 5);
    for (let y = 8; y < H - 4; y += 20) bulb(W - 5, y);
    for (let x = W - 8; x > 4; x -= 20) bulb(x, H - 5);
    for (let y = H - 8; y > 4; y -= 20) bulb(5, y);
  };

  // Swarm: glowing dust drifts about, then each speck flies in and becomes its letter.
  const origin = visible.map(() => ({ x: rnd() * W, y: rnd() * H, ph: rnd() * 6 }));
  const drawSwarm = (r: number, t: number) => {
    clear();
    ctx.font = `${fs}px ${FONT}`;
    visible.forEach((c, i) => {
      const o2 = origin[i];
      const sx = o2.x + Math.sin(t / 500 + o2.ph) * 6;
      const sy = o2.y + Math.cos(t / 420 + o2.ph) * 6;
      const p = (r - c.lock) / SWARM;
      if (p <= 0) {
        ctx.fillStyle = `rgba(160,255,220,${0.4 + 0.4 * Math.sin(t / 200 + o2.ph)})`;
        ctx.fillRect(sx, sy, 2.2, 2.2);
        return;
      }
      const q = ease(p);
      ctx.fillStyle = p < 1 ? `rgba(200,255,235,${0.5 + 0.5 * q})` : '#e8fff4';
      ctx.shadowColor = 'rgba(80,255,190,.6)';
      ctx.shadowBlur = p < 1 ? 10 : 5;
      ctx.fillText(c.ch, sx + (c.x - sx) * q, sy + (c.y - sy) * q);
    });
    ctx.shadowBlur = 0;
  };

  // Bubbles: each letter floats up inside a bubble, which pops when it arrives.
  const drawBubbles = (r: number) => {
    clear();
    ctx.font = `${fs}px ${FONT}`;
    const rad = cw * 0.95;
    visible.forEach((c, i) => {
      const p = (r - c.lock) / RISE;
      if (p < 0) return;
      const k = Math.min(1, p);
      const x = c.x + Math.sin(p * 7 + i) * 8 * (1 - k);
      const y = H + 20 + (c.y - H - 20) * ease(k);
      const bx = x + cw / 2;
      const by = y - fs * 0.3;
      ctx.fillStyle = '#e8fff4';
      ctx.fillText(c.ch, x, y);
      if (p < 1) {
        ctx.fillStyle = 'rgba(150,220,255,.14)';
        ctx.strokeStyle = 'rgba(170,230,255,.85)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(bx, by, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(bx, by, rad * 0.7, Math.PI * 1.1, Math.PI * 1.45);
        ctx.stroke();
      } else if (p < 1.2) {
        const pr = (p - 1) / 0.2;
        ctx.strokeStyle = `rgba(170,230,255,${1 - pr})`;
        ctx.beginPath();
        ctx.arc(bx, by, rad * (1 + pr * 0.9), 0, Math.PI * 2);
        ctx.stroke();
      }
    });
  };

  // UFO: a saucer sweeps across and its beam makes the letters appear as it passes over them.
  const FLYU = T_INTRO + Math.max(T_RESOLVE, 1400);
  const drawUfo = (t: number) => {
    clear();
    for (const s of stars) {
      ctx.fillStyle = `rgba(255,255,255,${0.3 + 0.3 * Math.sin(t / 300 + s.ph)})`;
      ctx.fillRect(s.x, s.y, s.s, s.s);
    }
    const px = -40 + (W + 80) * (t / FLYU);
    if (px > -40 && px < W + 40) {
      const g = ctx.createLinearGradient(0, 24, 0, H);
      g.addColorStop(0, 'rgba(190,255,210,.35)');
      g.addColorStop(1, 'rgba(190,255,210,.05)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(px - 10, 24);
      ctx.lineTo(px + 10, 24);
      ctx.lineTo(px + 50, H);
      ctx.lineTo(px - 50, H);
      ctx.fill();
    }
    ctx.font = `${fs}px ${FONT}`;
    for (const c of visible) {
      const q = Math.min(1, (t - ((c.x + 40) / (W + 80)) * FLYU) / 300);
      if (q <= 0) continue;
      ctx.fillStyle = q < 1 ? `rgba(220,255,235,${q})` : '#e8fff4';
      ctx.shadowColor = 'rgba(160,255,200,.8)';
      ctx.shadowBlur = q < 1 ? 14 : 5;
      ctx.fillText(c.ch, c.x, c.y - (1 - q) * 30);
    }
    ctx.shadowBlur = 0;
    if (px > -40 && px < W + 40) {
      ctx.fillStyle = '#aab6c2';
      ctx.beginPath();
      ctx.ellipse(px, 18, 26, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#7fd6ff';
      ctx.beginPath();
      ctx.ellipse(px, 15, 12, 9, 0, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = '#ffe27a';
      for (let k = -2; k <= 2; k++) ctx.fillRect(px + k * 9 - 1.5, 19, 3, 3);
    }
  };

  // Spotlight: only a roaming pool of light shows the text, then it swells to light the whole stage.
  const drawSpot = (p: number) => {
    clear();
    drawCells(0, () => true, false, false);
    const grow = ease((p - 0.55) / 0.45);
    const rad = 55 + grow * Math.hypot(W, H);
    // the pool wanders back and forth along the text so it is actually found
    const tw = Math.max(...shown.map((l) => Array.from(l).length)) * cw;
    const cx = W / 2 + Math.sin(p * 5.5) * Math.max(40, tw / 2) * (1 - grow);
    const cy = top + (shown.length * lh) / 2 + Math.sin(p * 3.3) * lh * (1 - grow);
    const g = ctx.createRadialGradient(cx, cy, rad * 0.55, cx, cy, rad);
    g.addColorStop(0, `rgba(${BG},0)`);
    g.addColorStop(1, `rgb(${BG})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };

  // Plane: it crosses the sky and parachutes the text out, one word per canopy.
  const FLY = T_INTRO + Math.max(T_RESOLVE, 1400);
  const words: { cells: Cell[]; cx: number; x0: number; x1: number; tl: number; hue: number }[] = [];
  for (const c of visible) {
    const w = words[words.length - 1];
    const last = w?.cells[w.cells.length - 1];
    if (w && last.y === c.y && c.x - last.x < cw * 1.01) w.cells.push(c);
    else words.push({ cells: [c], cx: 0, x0: 0, x1: 0, tl: 0, hue: 0 });
  }
  words.forEach((w, i) => {
    w.x0 = w.cells[0].x;
    w.x1 = w.cells[w.cells.length - 1].x + cw;
    w.cx = (w.x0 + w.x1) / 2;
    w.tl = ((w.cx + 80) / (W + 160)) * FLY;
    w.hue = (i * 47) % 360;
  });
  const planeY = 12;
  const clouds = Array.from({ length: 6 }, () => ({ x: rnd() * W, y: H * (0.25 + rnd() * 0.65), s: 24 + rnd() * 40 }));
  const drawPlane = (t: number) => {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#1d4468');
    sky.addColorStop(1, `rgb(${BG})`);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.08)';
    for (const k of clouds) {
      const x = (((k.x - t * 0.03) % (W + 120)) + W + 120) % (W + 120) - 60;
      ctx.beginPath();
      ctx.ellipse(x, k.y, k.s, k.s * 0.3, 0, 0, Math.PI * 2);
      ctx.ellipse(x + k.s * 0.5, k.y - k.s * 0.12, k.s * 0.6, k.s * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = `${fs}px ${FONT}`;
    for (const w of words) {
      const q = (t - w.tl) / FALL;
      if (q < 0) continue;
      const e = 1 - Math.pow(1 - Math.min(1, q), 2);
      const sway = Math.sin(Math.min(1, q) * 9) * 16 * (1 - Math.min(1, q));
      const dy = (planeY + 6 - w.cells[0].y) * (1 - e);
      const flying = q < 1;
      ctx.fillStyle = flying ? '#ffffff' : '#e8fff4';
      ctx.shadowColor = 'rgba(80,255,190,.55)';
      ctx.shadowBlur = 5;
      for (const c of w.cells) ctx.fillText(c.ch, c.x + sway, c.y + dy);
      ctx.shadowBlur = 0;
      if (flying) {
        const open = 1 - Math.min(1, Math.max(0, (q - 0.8) / 0.2)); // canopy folds up as it lands
        const top = w.cells[0].y + dy - fs;
        const rad = Math.max(16, (w.x1 - w.x0) / 2 + 8);
        const cx = w.cx + sway;
        const ch = 20 * open;
        ctx.globalAlpha = open;
        ctx.strokeStyle = 'rgba(255,255,255,.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - rad, top - 4);
        ctx.lineTo(w.x0 + sway, top + fs * 0.5);
        ctx.moveTo(cx + rad, top - 4);
        ctx.lineTo(w.x1 + sway, top + fs * 0.5);
        ctx.moveTo(cx, top - 4);
        ctx.lineTo(cx, top + fs * 0.5);
        ctx.stroke();
        ctx.fillStyle = `hsl(${w.hue},75%,58%)`;
        ctx.beginPath();
        ctx.ellipse(cx, top - 4, rad, ch, 0, Math.PI, 0);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    // the plane, drawn last so it stays on top
    const px = -80 + ((t / FLY) * (W + 160));
    if (px > -80 && px < W + 80) {
      ctx.save();
      ctx.translate(px, planeY);
      ctx.fillStyle = '#e4ebf2';
      ctx.beginPath();
      ctx.ellipse(0, 0, 30, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath(); // tail fin
      ctx.moveTo(-24, -2);
      ctx.lineTo(-34, -15);
      ctx.lineTo(-16, -3);
      ctx.fill();
      ctx.fillStyle = '#b5c2cf'; // wing
      ctx.beginPath();
      ctx.moveTo(-6, 2);
      ctx.lineTo(8, 2);
      ctx.lineTo(-2, 13);
      ctx.lineTo(-10, 13);
      ctx.fill();
      ctx.fillStyle = '#1d4468';
      for (let k = 0; k < 4; k++) ctx.fillRect(-12 + k * 7, -3, 4, 3);
      ctx.strokeStyle = 'rgba(255,255,255,.6)'; // spinning propeller
      ctx.lineWidth = 2;
      const pa = (t / 20) % Math.PI;
      ctx.beginPath();
      ctx.moveTo(31 + Math.cos(pa) * 1, -Math.sin(pa) * 11);
      ctx.lineTo(31 - Math.cos(pa) * 1, Math.sin(pa) * 11);
      ctx.stroke();
      ctx.restore();
    }
  };

  // Asteroids: a vector-graphics ship shoots a rock for every word; each rock blows up and the word appears.
  const rocks = words.map(() => ({
    pts: Array.from({ length: 10 }, (_, j) => ({ a: (j / 10) * Math.PI * 2, f: 0.75 + rnd() * 0.4 })),
    spin: (rnd() - 0.5) * 0.002,
    ph: rnd() * 6,
    bits: Array.from({ length: 7 }, () => ({ a: rnd() * Math.PI * 2, v: 0.03 + rnd() * 0.05 })),
  }));
  const shipX = words.map((w) => W / 2 + (w.cx - W / 2) * 0.5);
  const SHIP_Y = H - 20;
  const rockPos = (i: number) => ({ x: words[i].cx, y: words[i].cells[0].y - fs * 0.3 });
  const drawAsteroids = (r: number, t: number) => {
    clear();
    const n = words.length;
    if (!n) return;
    ctx.strokeStyle = '#e8fff4';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(160,255,220,.8)';
    ctx.shadowBlur = 4;
    ctx.font = `${fs}px ${FONT}`;
    for (let i = 0; i < n; i++) {
      const hit = i * AST_DT + AST_FLIGHT;
      const { x, y } = rockPos(i);
      const rk = rocks[i];
      if (r < hit) {
        const rad = Math.min(38, Math.max(12, (words[i].x1 - words[i].x0) / 2));
        const cx = x + Math.sin(t / 900 + rk.ph) * 4;
        const cy = y + Math.cos(t / 1100 + rk.ph) * 3;
        ctx.beginPath();
        rk.pts.forEach((p, j) => {
          const a = p.a + t * rk.spin;
          const px = cx + Math.cos(a) * rad * p.f;
          const py = cy + Math.sin(a) * rad * p.f;
          if (j === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.stroke();
        continue;
      }
      const age = r - hit;
      if (age < 500) {
        ctx.globalAlpha = 1 - age / 500;
        for (const b of rk.bits) {
          const d = age * b.v;
          const x0 = x + Math.cos(b.a) * d;
          const y0 = y + Math.sin(b.a) * d;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x0 + Math.cos(b.a + age / 120) * 9, y0 + Math.sin(b.a + age / 120) * 9);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = age < 200 ? '#ffffff' : '#e8fff4';
      for (const c of words[i].cells) ctx.fillText(c.ch, c.x, c.y);
    }
    // the ship swings toward the next rock, fires, and moves on
    const next = Math.min(n - 1, r < 0 ? 0 : Math.floor(r / AST_DT) + 1);
    const mv = Math.min(250, AST_DT);
    const k = clamp01(1 - (next * AST_DT - r) / mv);
    const prevX = next > 0 ? shipX[next - 1] : W / 2;
    const sx = r >= (n - 1) * AST_DT ? shipX[n - 1] : prevX + (shipX[next] - prevX) * ease(k);
    const tg = rockPos(next);
    const ang = Math.atan2(tg.x - sx, -(tg.y - SHIP_Y));
    ctx.save();
    ctx.translate(sx, SHIP_Y);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(8, 9);
    ctx.lineTo(0, 5);
    ctx.lineTo(-8, 9);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
    // bullets in flight
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < n; i++) {
      const q = (r - i * AST_DT) / AST_FLIGHT;
      if (q < 0 || q >= 1) continue;
      const tp = rockPos(i);
      const a = Math.atan2(tp.x - shipX[i], -(tp.y - SHIP_Y));
      const ox = shipX[i] + Math.sin(a) * 12;
      const oy = SHIP_Y - Math.cos(a) * 12;
      ctx.fillRect(ox + (tp.x - ox) * q - 1.5, oy + (tp.y - oy) * q - 1.5, 3, 3);
    }
    ctx.shadowBlur = 0;
  };

  // Wizard's ink: aged parchment on which the writing seeps into view in scattered bits, lit by a wand tip.
  const wizAt: number[] = new Array(visible.length).fill(0);
  {
    const runs: number[][] = []; // the writing arrives in little runs of 1..5 letters, in a random order
    for (let i = 0; i < visible.length; ) {
      const n = Math.min(visible.length - i, 1 + Math.floor(rnd() * 5));
      runs.push(Array.from({ length: n }, (_, j) => i + j));
      i += n;
    }
    for (let k = runs.length - 1; k > 0; k--) {
      const j = Math.floor(rnd() * (k + 1));
      [runs[k], runs[j]] = [runs[j], runs[k]];
    }
    runs.forEach((run, k) => {
      const start = (k / runs.length) * WIZ_SPREAD * 0.95 + rnd() * 120;
      run.forEach((idx, j) => (wizAt[idx] = start + j * 280));
    });
  }
  const stains = Array.from({ length: 9 }, () => ({ x: rnd() * W, y: rnd() * H, rx: 20 + rnd() * 50, ry: 10 + rnd() * 30 }));
  const drawWizard = (r: number, t: number) => {
    const pg = ctx.createRadialGradient(W / 2, H / 2, H * 0.1, W / 2, H / 2, Math.hypot(W, H) / 2);
    pg.addColorStop(0, '#ead8a8');
    pg.addColorStop(1, '#b99b62');
    ctx.fillStyle = pg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(120,80,30,.07)';
    for (const s of stains) {
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, s.rx, s.ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = `${fs}px ${FONT}`;
    let focus = -1;
    visible.forEach((c, i) => {
      const age = r - wizAt[i];
      if (age <= 0) return;
      const k = clamp01(age / 2400); // each letter seeps in very slowly
      if (age < 1500 && (focus < 0 || wizAt[i] > wizAt[focus])) focus = i;
      const bx = c.x + cw / 2;
      const by = c.y - fs * 0.3;
      const blot = ctx.createRadialGradient(bx, by, 0, bx, by, cw * (0.4 + 0.8 * ease(k)));
      blot.addColorStop(0, `rgba(60,35,10,${0.3 * (1 - 0.6 * k)})`);
      blot.addColorStop(1, 'rgba(60,35,10,0)');
      ctx.fillStyle = blot;
      ctx.fillRect(bx - cw * 1.3, by - cw * 1.3, cw * 2.6, cw * 2.6);
      ctx.globalAlpha = k;
      ctx.fillStyle = `rgb(${Math.round(224 - 182 * k)},${Math.round(160 - 134 * k)},${Math.round(48 - 36 * k)})`; // golden, cooling to ink
      ctx.shadowColor = 'rgba(255,190,60,.9)';
      ctx.shadowBlur = 10 * (1 - k);
      ctx.fillText(c.ch, c.x, c.y);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    });
    // the wand: its glowing tip rests on the writing that is appearing
    const tip = focus >= 0 ? { x: visible[focus].x + cw / 2, y: visible[focus].y - fs * 0.3 } : { x: W * 0.2 + Math.sin(t / 500) * 20, y: H * 0.35 + Math.cos(t / 700) * 12 };
    const bob = Math.sin(t / 180) * 2;
    ctx.strokeStyle = '#3b2616';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tip.x + 4, tip.y - 3 + bob);
    ctx.lineTo(tip.x + 40, tip.y - 38 + bob);
    ctx.stroke();
    ctx.lineCap = 'butt';
    const glow = ctx.createRadialGradient(tip.x, tip.y + bob, 0, tip.x, tip.y + bob, 22);
    glow.addColorStop(0, 'rgba(255,240,170,.9)');
    glow.addColorStop(1, 'rgba(255,200,80,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(tip.x - 24, tip.y + bob - 24, 48, 48);
    ctx.fillStyle = 'rgba(255,230,140,.9)';
    for (let k = 0; k < 7; k++) ctx.fillRect(tip.x + (rnd() - 0.5) * 30, tip.y + bob + (rnd() - 0.5) * 30, 1.5, 1.5);
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) / 2);
    vg.addColorStop(0, 'rgba(70,40,10,0)');
    vg.addColorStop(1, 'rgba(70,40,10,.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    fadeToFinal(r);
  };

  // Old cartoon bomb: a round black bomb with a sparking fuse; it goes KA-BOOM and blows the letters into place.
  const bx = W / 2;
  const by = H / 2 + 12;
  const bR = Math.min(30, H * 0.14);
  const fuse = (u: number) => {
    const p0 = { x: bx + bR * 0.3, y: by - bR };
    const p1 = { x: bx + bR * 0.3, y: by - bR - 26 };
    const p2 = { x: bx + bR * 1.4, y: by - bR - 36 };
    return { x: (1 - u) * (1 - u) * p0.x + 2 * (1 - u) * u * p1.x + u * u * p2.x, y: (1 - u) * (1 - u) * p0.y + 2 * (1 - u) * u * p1.y + u * u * p2.y };
  };
  const starburst = (x: number, y: number, ro: number, ri: number, n: number, rot: number) => {
    ctx.beginPath();
    for (let k = 0; k < n * 2; k++) {
      const a = rot + (k / (n * 2)) * Math.PI * 2;
      const rad = k % 2 ? ri : ro;
      ctx.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
    }
    ctx.closePath();
  };
  const smoke = Array.from({ length: 10 }, () => ({ a: rnd() * Math.PI * 2, v: 0.05 + rnd() * 0.07, s: 12 + rnd() * 16 }));
  const drawBomb = (r: number, t: number) => {
    clear();
    const boomAt = BOOM_T;
    const burn = clamp01(t / (T_INTRO + boomAt));
    if (r < boomAt) {
      const shake = Math.sin(t * 0.06) * burn * burn * burn * 3;
      ctx.save();
      ctx.translate(shake, 0);
      ctx.fillStyle = '#34343d'; // dark grey, so the bomb still shows against the dark stage
      ctx.strokeStyle = '#8a8a96';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(bx, by, bR * (1 + 0.04 * Math.sin(t / 60) * burn), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.beginPath();
      ctx.ellipse(bx - bR * 0.4, by - bR * 0.4, bR * 0.22, bR * 0.13, -0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#3a3a42'; // the cap the fuse comes out of
      ctx.fillRect(bx - 5, by - bR - 5, 12, 8);
      // the fuse burns down from its tip towards the bomb
      const f = 1 - burn;
      ctx.strokeStyle = '#c9a66b';
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let u = 0; u <= f + 1e-6; u += 0.05) {
        const q = fuse(Math.min(u, f));
        if (u === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
      const tip = fuse(f);
      ctx.fillStyle = '#ffe14a';
      starburst(tip.x, tip.y, 6 + rnd() * 5, 2.5, 6, rnd() * 6);
      ctx.fill();
      ctx.fillStyle = '#ff7a1a';
      for (let k = 0; k < 5; k++) ctx.fillRect(tip.x + (rnd() - 0.5) * 18, tip.y + (rnd() - 0.5) * 18, 2, 2);
      ctx.restore();
      return;
    }
    const age = r - boomAt;
    // smoke
    for (const s of smoke) {
      const k = clamp01(age / 800);
      ctx.fillStyle = `rgba(150,150,155,${0.5 * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(bx + Math.cos(s.a) * age * s.v * 1.4, by + Math.sin(s.a) * age * s.v - age * 0.02, s.s * (0.5 + k * 1.4), 0, Math.PI * 2);
      ctx.fill();
    }
    // the letters are blown out from the bomb into place
    ctx.font = `${fs}px ${FONT}`;
    visible.forEach((c, i) => {
      const q = clamp01((age - (i % 7) * 15) / 700);
      if (q <= 0) return;
      const e = ease(q);
      ctx.save();
      ctx.translate(bx + (c.x + cw / 2 - bx) * e, by + (c.y - fs * 0.3 - by) * e);
      ctx.rotate((1 - q) * (i % 2 ? 6 : -6));
      ctx.scale(0.5 + 0.5 * e, 0.5 + 0.5 * e);
      ctx.fillStyle = q < 1 ? '#fff6c0' : '#e8fff4';
      ctx.shadowColor = 'rgba(255,170,60,.9)';
      ctx.shadowBlur = q < 1 ? 10 : 4;
      ctx.fillText(c.ch, -cw / 2, fs * 0.3);
      ctx.restore();
    });
    // the comic starburst
    const sb = 1 - clamp01((age - 250) / 350);
    if (sb > 0) {
      const grow = 70 + age * 0.3;
      ctx.globalAlpha = sb;
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#222';
      ctx.fillStyle = '#ff5a1f';
      starburst(bx, by, grow, grow * 0.6, 12, 0.2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffe14a';
      starburst(bx, by, grow * 0.75, grow * 0.45, 12, 0.2);
      ctx.fill();
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(-0.14);
      ctx.font = `italic bold ${Math.round(Math.min(26, grow * 0.3))}px serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#222';
      ctx.strokeText('KA-BOOM!', 0, 8);
      ctx.fillStyle = '#d4121a';
      ctx.fillText('KA-BOOM!', 0, 8);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    if (age < 220) {
      ctx.fillStyle = `rgba(255,255,255,${0.9 * (1 - age / 220)})`;
      ctx.fillRect(0, 0, W, H);
    }
  };

  // Hearts: lots of hearts drift up; each carries a letter into place and pops into little hearts.
  const heartPath = (x: number, y: number, s: number) => {
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.9);
    ctx.bezierCurveTo(x - s * 1.6, y - s * 0.1, x - s * 0.7, y - s * 1.2, x, y - s * 0.4);
    ctx.bezierCurveTo(x + s * 0.7, y - s * 1.2, x + s * 1.6, y - s * 0.1, x, y + s * 0.9);
    ctx.closePath();
  };
  const bgHearts = Array.from({ length: 45 }, () => ({ x: rnd() * W, o: rnd() * (H + 60), vy: 0.03 + rnd() * 0.05, ph: rnd() * 6, s: 5 + rnd() * 9, h: 335 + Math.floor(rnd() * 25) }));
  const drawHearts = (r: number, t: number) => {
    clear();
    for (const b of bgHearts) {
      const y = H + 30 - ((t * b.vy + b.o) % (H + 60));
      ctx.fillStyle = `hsla(${b.h},85%,60%,.28)`;
      heartPath(b.x + Math.sin(t / 600 + b.ph) * 14, y, b.s);
      ctx.fill();
    }
    ctx.font = `${fs}px ${FONT}`;
    const hs = cw * 0.75;
    const settled: Cell[] = []; // arrived letters, drawn last so the popping hearts never cover them
    visible.forEach((c, i) => {
      const p = (r - c.lock) / HEART_RISE;
      if (p < 0) return;
      const k = Math.min(1, p);
      const x = c.x + cw / 2 + Math.sin(p * 6 + i) * 10 * (1 - k);
      const y = H + 20 + (c.y - fs * 0.3 - H - 20) * ease(k);
      if (p < 1) {
        ctx.fillStyle = `hsl(${340 + (i * 7) % 20},85%,58%)`;
        heartPath(x, y, hs);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillText(c.ch, x - cw / 2, y + fs * 0.3);
        return;
      }
      settled.push(c);
      const pop = ((p - 1) * HEART_RISE) / 350; // the heart bursts into little ones
      if (pop < 1) {
        for (let j = 0; j < 4; j++) {
          const a = (j / 4) * Math.PI * 2 + i;
          ctx.fillStyle = `rgba(255,90,140,${1 - pop})`;
          heartPath(c.x + cw / 2 + Math.cos(a) * pop * 14, c.y - fs * 0.3 + Math.sin(a) * pop * 14, 2.5);
          ctx.fill();
        }
      }
    });
    ctx.fillStyle = '#ffe8f0';
    ctx.shadowColor = 'rgba(255,90,140,.8)';
    ctx.shadowBlur = 6;
    for (const c of settled) ctx.fillText(c.ch, c.x, c.y);
    ctx.shadowBlur = 0;
    fadeToFinal(r);
  };

  // Flowers: a flower blooms around every letter until the whole stage is a garden.
  const petal = (x: number, y: number, rad: number, rot: number, hue: number, centre: string) => {
    ctx.fillStyle = `hsl(${hue},85%,78%)`;
    for (let k = 0; k < 6; k++) {
      const a = rot + (k / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.ellipse(x + Math.cos(a) * rad * 0.55, y + Math.sin(a) * rad * 0.55, rad * 0.5, rad * 0.28, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = centre;
    ctx.beginPath();
    ctx.arc(x, y, rad * 0.38, 0, Math.PI * 2);
    ctx.fill();
  };
  const stems = Array.from({ length: 14 }, (_, i) => ({ x: ((i + 0.5) / 14) * W + (rnd() - 0.5) * 16, hgt: 30 + rnd() * 40, h: Math.floor(rnd() * 360), ph: rnd() * 6 }));
  const drawFlowers = (r: number, t: number) => {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#16324a');
    sky.addColorStop(1, '#1f4a2c');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    for (const s of stems) {
      const sway = Math.sin(t / 700 + s.ph) * 5;
      const grow = clamp01((t + 200) / 700);
      ctx.strokeStyle = '#3f9c4f';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.x, H);
      ctx.quadraticCurveTo(s.x + sway * 0.4, H - s.hgt * grow * 0.5, s.x + sway, H - s.hgt * grow);
      ctx.stroke();
      petal(s.x + sway, H - s.hgt * grow, 9 * grow, t / 2000 + s.ph, s.h, '#ffd23f');
    }
    ctx.font = `${fs}px ${FONT}`;
    const open: Cell[] = []; // letters are drawn after all the petals so no flower covers a neighbour
    visible.forEach((c, i) => {
      const p = (r - c.lock) / BLOOM;
      if (p <= 0) return;
      const k = Math.min(1, p);
      const grow = 1 + 0.25 * Math.sin(k * Math.PI) * (k < 1 ? 1 : 0); // a little overshoot as it opens
      petal(c.x + cw / 2, c.y - fs * 0.3, cw * 0.85 * ease(k) * grow, i * 0.7 + k * 0.8, (i * 47) % 360, '#fff4b0');
      open.push(c);
    });
    ctx.fillStyle = '#3a1830';
    for (const c of open) ctx.fillText(c.ch, c.x, c.y);
    fadeToFinal(r);
  };

  // Moon: the Earth climbs over the lunar horizon and pushes the text up into view.
  const stars = Array.from({ length: 70 }, () => ({ x: rnd() * W, y: rnd() * H, s: 0.6 + rnd() * 1.4, ph: rnd() * 6 }));
  const craters = Array.from({ length: 9 }, () => ({ x: rnd(), y: rnd(), rx: 8 + rnd() * 26, ry: 3 + rnd() * 7 }));
  const earthR = Math.max(40, Math.min(W, H) * 0.22);
  const textBottom = top + shown.length * lh;
  const land = [[-0.35, -0.2, 0.32, 0.22], [0.25, 0.1, 0.3, 0.3], [-0.1, 0.5, 0.25, 0.16], [0.6, -0.4, 0.18, 0.14]];
  const drawMoon = (rise: number, pan: number, tt: number) => {
    clear();
    for (const s of stars) {
      ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.35 * Math.sin(tt / 300 + s.ph)})`;
      ctx.fillRect(s.x, s.y, s.s, s.s);
    }
    const hy = H * 0.88 + pan * H * 0.3;
    const dy = (1 - rise) * H;
    // Earth, directly under the text block so it looks like it is pushing it up
    const ex = W / 2;
    const ey = textBottom + dy + earthR + 10;
    ctx.save();
    ctx.shadowColor = 'rgba(110,180,255,.7)';
    ctx.shadowBlur = 22;
    const eg = ctx.createRadialGradient(ex - earthR * 0.35, ey - earthR * 0.35, earthR * 0.1, ex, ey, earthR);
    eg.addColorStop(0, '#7cc4ff');
    eg.addColorStop(1, '#16418a');
    ctx.fillStyle = eg;
    ctx.beginPath();
    ctx.arc(ex, ey, earthR, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.clip();
    for (const [lx, ly, lw, lhh] of land) {
      const gx = (((lx + tt / 9000) % 1.4) + 1.4) % 1.4 - 0.7; // slow spin
      ctx.fillStyle = 'rgba(70,160,80,.9)';
      ctx.beginPath();
      ctx.ellipse(ex + gx * earthR * 1.6, ey + ly * earthR, lw * earthR, lhh * earthR, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.ellipse(ex + Math.sin(k * 2 + tt / 4000) * earthR * 0.6, ey + (k - 1.5) * earthR * 0.4, earthR * 0.4, earthR * 0.07, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    // the text it is lifting
    ctx.font = `${fs}px ${FONT}`;
    ctx.fillStyle = '#e8fff4';
    ctx.shadowColor = 'rgba(80,255,190,.55)';
    ctx.shadowBlur = 6;
    for (const c of cells) if (c.ch !== ' ') ctx.fillText(c.ch, c.x, c.y + dy);
    ctx.shadowBlur = 0;
    // lunar surface on top, hiding whatever is still below the horizon
    const sg = ctx.createLinearGradient(0, hy - 20, 0, H);
    sg.addColorStop(0, '#b9b9b4');
    sg.addColorStop(1, '#55554f');
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.moveTo(0, H + 2);
    ctx.lineTo(0, hy + 18);
    ctx.quadraticCurveTo(W / 2, hy - 18, W, hy + 18);
    ctx.lineTo(W, H + 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(60,60,55,.45)';
    for (const k of craters) {
      ctx.beginPath();
      ctx.ellipse(k.x * W, hy + 20 + k.y * Math.max(0, H - hy - 24), k.rx, k.ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  // Curtain: red velvet panels draw apart to show the text.
  const drawCurtain = (open: number) => {
    clear();
    drawCells(0, () => true, false, false);
    const pw = (W / 2) * (1 - open);
    const panel = (x0: number, x1: number) => {
      for (let x = x0; x < x1; x += 8) {
        const shade = 0.5 + 0.5 * Math.sin(x * 0.55);
        ctx.fillStyle = `rgb(${Math.round(105 + 55 * shade)},${Math.round(18 + 14 * shade)},${Math.round(32 + 18 * shade)})`;
        ctx.fillRect(x, 0, Math.min(8, x1 - x), H);
      }
    };
    panel(0, pw);
    panel(W - pw, W);
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fillRect(pw - 3, 0, 3, H);
    ctx.fillRect(W - pw, 0, 3, H);
    ctx.fillStyle = '#c9a227';
    ctx.fillRect(0, 0, W, 12);
    ctx.fillStyle = '#7a5f0c';
    ctx.fillRect(0, 12, W, 2);
  };

  // Can: a tin tips over at the top right and the letters tumble out of it into place.
  const canAngle = -1.75;
  const canCx = W - 46;
  const canCy = 46;
  const mouthX = canCx + 30 * Math.sin(canAngle);
  const mouthY = canCy - 30 * Math.cos(canAngle);
  const drawCan = (tilt: number, dx: number, wobble: number) => {
    ctx.save();
    ctx.translate(canCx + dx, canCy);
    ctx.rotate(canAngle * tilt + wobble);
    ctx.fillStyle = '#9aa7b3';
    ctx.fillRect(-22, -30, 44, 60);
    ctx.fillStyle = '#e07b39';
    ctx.fillRect(-22, -12, 44, 24);
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.fillRect(-14, -30, 6, 60);
    ctx.fillStyle = '#5c6670';
    ctx.beginPath();
    ctx.ellipse(0, -30, 22, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#10151a';
    ctx.beginPath();
    ctx.ellipse(0, -30, 17, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  // Flag: a toy gun goes BANG and a banner with the text unfurls from its barrel.
  const gunY = H / 2;
  const MUZZLE = 130;
  const drawGun = (mx: number) => {
    ctx.fillStyle = '#3a444e';
    ctx.fillRect(mx - 110, gunY - 10, 110, 20);
    ctx.fillStyle = '#56626d';
    ctx.fillRect(mx - 110, gunY - 10, 110, 5);
    ctx.fillStyle = '#2b333a';
    ctx.beginPath();
    ctx.moveTo(mx - 100, gunY + 10);
    ctx.lineTo(mx - 70, gunY + 10);
    ctx.lineTo(mx - 78, gunY + 52);
    ctx.lineTo(mx - 106, gunY + 52);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#2b333a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(mx - 62, gunY + 18, 9, 0, Math.PI);
    ctx.stroke();
    ctx.fillStyle = '#0b0e11';
    ctx.fillRect(mx - 4, gunY - 5, 4, 10);
  };

  // ---- Minions, snow globe, rocket, lightning and helicopters ------------------------------------
  const wt = words.map((w, i) => ({ w, i, t0: Math.min(...w.cells.map((c) => c.lock)) }));
  const textLit = (c: Cell, color: string, glow: string, blur = 5, x = c.x, y = c.y, alpha = 1) => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.shadowColor = glow;
    ctx.shadowBlur = blur;
    ctx.fillText(c.ch, x, y);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  };
  const circ = (x: number, y: number, rad: number) => {
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  };

  // Minions: a little yellow helper runs in carrying a word, tosses it up into place, cheers and runs off.
  const RUNIN = 650;
  const THROW = 450;
  const minion = (x: number, gy: number, dir: number, ph: number, eyes: number, up: number, hop: number) => {
    ctx.save();
    ctx.translate(x, gy - hop);
    ctx.scale(dir * 0.95, 0.95);
    const sw = Math.sin(ph);
    ctx.fillStyle = '#1b1b1f';
    ctx.fillRect(-8 + sw * 2, -4, 7, 4);
    ctx.fillRect(1 - sw * 2, -4, 7, 4);
    ctx.fillStyle = '#ffd83a';
    ctx.beginPath();
    ctx.moveTo(-9, -4);
    ctx.lineTo(-9, -27);
    ctx.arc(0, -27, 9, Math.PI, 0);
    ctx.lineTo(9, -4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#2f5fa8';
    ctx.fillRect(-9, -13, 18, 9);
    ctx.fillRect(-5, -17, 10, 5);
    ctx.strokeStyle = '#2f5fa8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-5, -17);
    ctx.lineTo(-9, -24);
    ctx.moveTo(5, -17);
    ctx.lineTo(9, -24);
    ctx.stroke();
    ctx.fillStyle = '#4a4a52';
    ctx.fillRect(-9, -30, 18, 4);
    const er = eyes === 1 ? 5.4 : 4.1;
    for (const ex of eyes === 1 ? [0] : [-4, 4]) {
      ctx.fillStyle = '#c9ced6';
      circ(ex, -28, er + 1.3);
      ctx.fillStyle = '#ffffff';
      circ(ex, -28, er);
      ctx.fillStyle = '#5a3a1a';
      circ(ex + 1, -28, er * 0.45);
      ctx.fillStyle = '#111111';
      circ(ex + 1.3, -28, er * 0.2);
    }
    ctx.strokeStyle = '#222222';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-3, -35.5);
    ctx.lineTo(-4, -40);
    ctx.moveTo(0, -36);
    ctx.lineTo(0, -41);
    ctx.moveTo(3, -35.5);
    ctx.lineTo(4, -40);
    ctx.stroke();
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(1, -21, 2.5, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    ctx.strokeStyle = '#ffd83a';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    for (const s of [-1, 1]) {
      const hx = (11 - 2 * up) * s;
      const hy = -6 - 27 * up + (1 - up) * sw * 2 * s;
      ctx.beginPath();
      ctx.moveTo(9 * s, -15);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.fillStyle = '#222222';
      circ(hx, hy, 2.2);
    }
    ctx.lineCap = 'butt';
    ctx.restore();
  };
  const drawMinions = (r: number, t: number) => {
    const gy = H - 12;
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#16324a');
    bg.addColorStop(1, '#1d2f3c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.07)';
    ctx.fillRect(0, gy + 2, W, H - gy);
    ctx.font = `${fs}px ${FONT}`;
    const settled: Cell[] = [];
    const carried: { c: Cell; x: number; y: number }[] = [];
    for (const { w, i, t0 } of wt) {
      const rr = r - t0;
      if (rr < 0) continue;
      const dirIn = i % 2 ? -1 : 1; // 1: runs in from the left
      const edge = dirIn > 0 ? -30 : W + 30;
      const eyes = i % 3 === 0 ? 1 : 2;
      const wy = gy - 52 - (i % 3) * 15; // carried words ride at three heights so they do not pile up
      if (rr < RUNIN) {
        const q = rr / RUNIN;
        const x = edge + (w.cx - edge) * (1 - Math.pow(1 - q, 2));
        const ph = rr / 70;
        minion(x, gy, dirIn, ph, eyes, 1, Math.abs(Math.sin(ph)) * 2.5);
        for (const c of w.cells) carried.push({ c, x: c.x + (x - w.cx), y: wy });
      } else if (rr < RUNIN + THROW) {
        const p = (rr - RUNIN) / THROW;
        minion(w.cx, gy, dirIn, 0, eyes, 1 - p, Math.sin(p * Math.PI) * 6);
        for (const c of w.cells) carried.push({ c, x: c.x, y: wy + (c.y - wy) * ease(p) - Math.sin(p * Math.PI) * 18 });
      } else {
        settled.push(...w.cells);
        const e = rr - RUNIN - THROW;
        if (e < 150) minion(w.cx, gy, dirIn, 0, eyes, 1, Math.abs(Math.sin((e / 150) * Math.PI)) * 7);
        else if (e < 700) {
          const q = (e - 150) / 550;
          const target = dirIn > 0 ? W + 30 : -30;
          minion(w.cx + (target - w.cx) * q * q, gy, dirIn, e / 70, eyes, 0, Math.abs(Math.sin(e / 70)) * 2.5);
        }
      }
    }
    for (const k of carried) textLit(k.c, '#fff3b0', 'rgba(255,216,58,.7)', 6, k.x, k.y);
    for (const c of settled) textLit(c, '#fff3b0', 'rgba(255,216,58,.5)', 4);
    fadeToFinal(r);
  };

  // Snow globe: shaken, the snow swirls, then settles and the writing appears under it.
  const globeFlakes = Array.from({ length: 150 }, () => ({ x: rnd() * W, y: rnd() * H, s: 1 + rnd() * 2.4, ph: rnd() * 6, v: 0.25 + rnd() * 0.6 }));
  const drawSnowglobe = (r: number, t: number) => {
    const settle = clamp01(r / (T_RES - 700));
    const shake = 1 - settle;
    const jolt = Math.max(0, 1 - t / (T_INTRO + 500));
    ctx.save();
    ctx.translate(Math.sin(t / 22) * 6 * jolt, Math.cos(t / 27) * 4 * jolt);
    const bg = ctx.createRadialGradient(W / 2, H * 0.45, 10, W / 2, H * 0.5, Math.max(W, H) * 0.7);
    bg.addColorStop(0, '#1d3f6e');
    bg.addColorStop(1, '#0a1530');
    ctx.fillStyle = bg;
    ctx.fillRect(-10, -10, W + 20, H + 20);
    const gh = 14 + 26 * settle;
    ctx.fillStyle = '#e8f1fb';
    ctx.beginPath();
    ctx.moveTo(0, H);
    ctx.lineTo(0, H - gh);
    ctx.quadraticCurveTo(W / 2, H - gh - 14, W, H - gh);
    ctx.lineTo(W, H);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    for (const f of globeFlakes) {
      const y = (((f.y + t * 0.04 * f.v + Math.cos(t / 260 + f.ph) * 70 * shake) % H) + H) % H;
      const x = (((f.x + Math.sin(t / 340 + f.ph) * (14 + 70 * shake)) % W) + W) % W;
      circ(x, y, f.s);
    }
    ctx.font = `${fs}px ${FONT}`;
    for (const c of visible) textLit(c, '#f4fbff', 'rgba(160,210,255,.9)', 6, c.x, c.y, clamp01((r - c.lock) / 600));
    ctx.restore();
    fadeToFinal(r);
  };

  // Rocket: it skywrites the message, one letter at a time, trailing rocketSmoke.
  const nightStars = Array.from({ length: 50 }, () => ({ x: rnd() * W, y: rnd() * H, s: 0.5 + rnd() * 1.3, p: rnd() * 6 }));
  const rocketSmoke: { x: number; y: number; t0: number }[] = [];
  let rvx = 1;
  let rvy = 0;
  const rocketPos = (r: number) => {
    if (!visible.length) return { x: W / 2, y: H / 2 };
    if (r < 0) {
      const q = ease((r + T_INTRO) / T_INTRO);
      return { x: -50 + (visible[0].x - 6 + 50) * q, y: visible[0].y - fs * 0.3 };
    }
    const k = Math.max(0, latest(r));
    const cur = visible[k];
    const nxt = visible[k + 1];
    if (!nxt) {
      const d = Math.max(0, r - typeAt[k]);
      return { x: cur.x + cw / 2 + d * 0.9, y: cur.y - fs * 0.3 - d * 0.25 };
    }
    const f = clamp01((r - typeAt[k]) / Math.max(1, typeAt[k + 1] - typeAt[k]));
    return { x: cur.x + cw / 2 + (nxt.x - cur.x) * f, y: cur.y - fs * 0.3 + (nxt.y - cur.y) * f };
  };
  const drawRocket = (r: number, t: number) => {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#050a18');
    sky.addColorStop(1, '#14264a');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    for (const s of nightStars) {
      ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.4 * Math.sin(t / 400 + s.p)})`;
      ctx.fillRect(s.x, s.y, s.s, s.s);
    }
    const p = rocketPos(r);
    const q = rocketPos(r - 40);
    rvx += (p.x - q.x - rvx) * 0.25;
    rvy += (p.y - q.y - rvy) * 0.25;
    const ang = Math.hypot(rvx, rvy) > 0.2 ? Math.atan2(rvy, rvx) : 0;
    rocketSmoke.push({ x: p.x - Math.cos(ang) * 30, y: p.y - Math.sin(ang) * 30, t0: t });
    if (rocketSmoke.length > 140) rocketSmoke.shift();
    for (const s of rocketSmoke) {
      const age = t - s.t0;
      const a = 0.4 * (1 - age / 1000);
      if (a <= 0) continue;
      ctx.fillStyle = `rgba(220,225,235,${a})`;
      circ(s.x, s.y - age * 0.01, 3 + age / 110);
    }
    ctx.font = `${fs}px ${FONT}`;
    visible.forEach((c, i) => {
      if (r < typeAt[i]) return;
      const fresh = r - typeAt[i] < 260;
      textLit(c, fresh ? '#ffe2b0' : '#eaf6ff', fresh ? 'rgba(255,170,60,.9)' : 'rgba(120,180,255,.6)', fresh ? 12 : 5);
    });
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(ang);
    ctx.scale(0.85, 0.85);
    const fl = 9 + 6 * Math.sin(t / 40);
    ctx.fillStyle = '#ffb02e';
    ctx.beginPath();
    ctx.moveTo(-34, -3);
    ctx.lineTo(-34 - fl, 0);
    ctx.lineTo(-34, 3);
    ctx.fill();
    ctx.fillStyle = '#e0443a';
    ctx.beginPath();
    ctx.moveTo(-34, -4.5);
    ctx.lineTo(-40, -10);
    ctx.lineTo(-24, -4.5);
    ctx.moveTo(-34, 4.5);
    ctx.lineTo(-40, 10);
    ctx.lineTo(-24, 4.5);
    ctx.fill();
    ctx.fillStyle = '#f3f6fa';
    ctx.fillRect(-34, -4.5, 24, 9);
    ctx.fillStyle = '#e0443a';
    ctx.beginPath();
    ctx.moveTo(-10, -4.5);
    ctx.lineTo(0, 0);
    ctx.lineTo(-10, 4.5);
    ctx.fill();
    ctx.fillStyle = '#7fc4ff';
    circ(-19, 0, 2.6);
    ctx.restore();
    fadeToFinal(r);
  };

  // Lightning: a storm; each flash lights up part of the message.
  const FLS = 5;
  const makeBolt = (x0: number, yEnd: number) => {
    const pts: [number, number][] = [[x0, 0]];
    let x = x0;
    let y = 0;
    while (y < yEnd) {
      y += 14 + rnd() * 16;
      x += (rnd() - 0.5) * 34;
      pts.push([x, y]);
    }
    return pts;
  };
  const flashes = [{ at: -250, bolt: makeBolt(W * 0.8, H * 0.5) }, ...Array.from({ length: FLS }, (_, i) => ({ at: 250 + i * 600, bolt: makeBolt(W * (0.12 + rnd() * 0.76), H * (0.45 + rnd() * 0.4)) }))];
  const rainDrops = Array.from({ length: 90 }, () => ({ x: rnd() * W, y: rnd() * H, l: 8 + rnd() * 10, v: 0.6 + rnd() * 0.5 }));
  const groupOf = (i: number) => Math.min(FLS - 1, Math.floor((i / Math.max(1, visible.length)) * FLS));
  const drawStorm = (r: number, t: number) => {
    let f = 0;
    for (const s of flashes) {
      if (r >= s.at) f = Math.max(f, Math.exp(-(r - s.at) / 120));
      if (r >= s.at + 170) f = Math.max(f, 0.5 * Math.exp(-(r - s.at - 170) / 90));
    }
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, `rgb(${10 + f * 90},${14 + f * 100},${28 + f * 120})`);
    sky.addColorStop(1, `rgb(${6 + f * 40},${9 + f * 44},${16 + f * 60})`);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = `rgba(${30 + f * 150},${36 + f * 160},${60 + f * 170},.9)`;
    for (let x = -20; x < W + 40; x += 70) {
      ctx.beginPath();
      ctx.ellipse(x, 6, 55, 26 + ((x * 7) % 11), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(170,190,230,.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const d of rainDrops) {
      const y = (d.y + t * d.v * 0.9) % H;
      const x = (d.x - t * 0.12 * d.v + W * 4) % W;
      ctx.moveTo(x, y);
      ctx.lineTo(x - 2, y + d.l);
    }
    ctx.stroke();
    for (const s of flashes) {
      const age = r - s.at;
      if (age < 0 || age > 200) continue;
      ctx.strokeStyle = `rgba(235,245,255,${1 - age / 200})`;
      ctx.shadowColor = '#9cf';
      ctx.shadowBlur = 14;
      ctx.lineWidth = 3;
      ctx.beginPath();
      s.bolt.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.font = `${fs}px ${FONT}`;
    visible.forEach((c, i) => {
      if (r >= flashes[1 + groupOf(i)].at) textLit(c, '#d4e3ff', 'rgba(150,190,255,.9)', 3 + 14 * f);
    });
    if (f > 0.02) {
      ctx.fillStyle = `rgba(200,220,255,${f * 0.35})`;
      ctx.fillRect(0, 0, W, H);
    }
    fadeToFinal(r);
  };

  // Helicopters: each word is slung under a helicopter, flown over its spot and lowered into place.
  const IN = 750;
  const LOW = 550;
  const HOLD = 150;
  const heli = (x: number, y: number, dir: number, t: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir, 1);
    ctx.fillStyle = '#4d6a3f';
    ctx.beginPath();
    ctx.moveTo(-14, -4);
    ctx.lineTo(-46, -8);
    ctx.lineTo(-46, -3);
    ctx.lineTo(-14, 5);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-46, -8);
    ctx.lineTo(-52, -17);
    ctx.lineTo(-43, -8);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#5b7a4a';
    ctx.beginPath();
    ctx.ellipse(0, 0, 22, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#bfe6ff';
    ctx.beginPath();
    ctx.ellipse(10, -2, 9, 6, -0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-16, 17);
    ctx.lineTo(18, 17);
    ctx.moveTo(-8, 11);
    ctx.lineTo(-10, 17);
    ctx.moveTo(8, 11);
    ctx.lineTo(10, 17);
    ctx.moveTo(0, -12);
    ctx.lineTo(0, -18);
    ctx.stroke();
    const bl = 8 + 34 * Math.abs(Math.cos(t / 38));
    ctx.strokeStyle = 'rgba(210,220,230,.9)';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(-bl, -18);
    ctx.lineTo(bl, -18);
    ctx.stroke();
    ctx.fillStyle = 'rgba(200,210,220,.12)';
    ctx.beginPath();
    ctx.ellipse(0, -18, 38, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    const tb = 3 + 7 * Math.abs(Math.sin(t / 30));
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(210,220,230,.9)';
    ctx.beginPath();
    ctx.moveTo(-48, -9 - tb);
    ctx.lineTo(-48, -9 + tb);
    ctx.stroke();
    ctx.restore();
  };
  // One helicopter per line of text; it hovers over the left or right of the line and slings the whole line.
  const heliLines = lineYs.map((y, k) => {
    const cs = visible.filter((c) => c.y === y);
    const x0 = cs[0].x;
    const x1 = cs[cs.length - 1].x + cw;
    return { w: { cells: cs, x0, x1, cx: x0 + (x1 - x0) * (k % 2 ? 0.3 : 0.7) }, i: k, t0: k * HELI_GAP };
  });
  const heliClouds = Array.from({ length: 6 }, () => ({ x: rnd() * W, y: H * (0.2 + rnd() * 0.6), s: 24 + rnd() * 40 }));
  const drawHelis = (r: number, t: number) => {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#27486b');
    sky.addColorStop(1, `rgb(${BG})`);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.08)';
    for (const k of heliClouds) {
      const x = (((k.x - t * 0.03) % (W + 120)) + W + 120) % (W + 120) - 60;
      ctx.beginPath();
      ctx.ellipse(x, k.y, k.s, k.s * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = `${fs}px ${FONT}`;
    const hanging: { c: Cell; x: number; y: number }[] = [];
    const settled: Cell[] = [];
    for (const { w, i, t0 } of heliLines) {
      const rr = r - t0;
      if (rr < 0) continue;
      const dirIn = i % 2 ? -1 : 1;
      const edge = dirIn > 0 ? -70 : W + 70;
      const hy = Math.max(26, w.cells[0].y - 74);
      const hang = hy + 52;
      let hx = w.cx;
      let hyy = hy + Math.sin(t / 160 + i) * 2;
      let ropes = true;
      if (rr < IN) {
        const q = rr / IN;
        hx = edge + (w.cx - edge) * (1 - Math.pow(1 - q, 2));
      } else if (rr >= IN + LOW) {
        settled.push(...w.cells);
        const e = rr - IN - LOW;
        if (e >= HOLD) {
          ropes = false;
          const q = (e - HOLD) / (AIR_T - IN - LOW - HOLD);
          if (q >= 1) continue;
          const target = dirIn > 0 ? W + 80 : -80;
          hx = w.cx + (target - w.cx) * q * q;
          hyy = hy - 30 * q;
        }
      }
      const p = rr < IN ? 0 : clamp01((rr - IN) / LOW);
      const ox = hx - w.cx;
      const lowered = (cy: number) => hang + (cy - hang) * ease(p);
      if (ropes) {
        const top = lowered(w.cells[0].y) - fs + 2;
        ctx.strokeStyle = '#d9c9a0';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(hx - 7, hyy + 17);
        ctx.lineTo(w.x0 + ox, top);
        ctx.moveTo(hx + 7, hyy + 17);
        ctx.lineTo(w.x1 + ox, top);
        ctx.stroke();
      }
      heli(hx, hyy, dirIn, t);
      if (rr < IN + LOW) for (const c of w.cells) hanging.push({ c, x: c.x + ox, y: lowered(c.y) });
    }
    for (const k of hanging) textLit(k.c, '#fff3d8', 'rgba(255,220,150,.6)', 5, k.x, k.y);
    for (const c of settled) textLit(c, '#fff3d8', 'rgba(255,220,150,.45)', 4);
    fadeToFinal(r);
  };
  // Banner plane: a plane tows a banner carrying the message across the sky and leaves it hanging in place.
  const bPad = 12;
  const bx0 = Math.min(...visible.map((c) => c.x)) - bPad;
  const bx1 = Math.max(...visible.map((c) => c.x + cw)) + bPad;
  const by0 = Math.min(...visible.map((c) => c.y)) - fs - 4;
  const by1 = Math.max(...visible.map((c) => c.y)) + 8;
  const bPlaneY = Math.max(26, by0 - 46);
  const towPlane = (x: number, y: number, t: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(-1, 1); // drawn facing right, flown facing left
    ctx.fillStyle = '#d23b3b';
    ctx.beginPath();
    ctx.moveTo(-26, -1);
    ctx.lineTo(-32, -13);
    ctx.lineTo(-19, -2);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-24, 1, 8, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, 0, 27, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f4f4f4';
    ctx.beginPath();
    ctx.ellipse(0, 2.5, 23, 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#bfe6ff';
    ctx.beginPath();
    ctx.ellipse(5, -6, 7, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#b32e2e';
    ctx.beginPath();
    ctx.ellipse(-2, 5, 15, 3.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(8, 8);
    ctx.lineTo(8, 12);
    ctx.stroke();
    ctx.fillStyle = '#2a2a2a';
    circ(8, 13, 2.6);
    const bl = 3 + 11 * Math.abs(Math.sin(t / 22));
    ctx.strokeStyle = 'rgba(225,225,225,.9)';
    ctx.beginPath();
    ctx.moveTo(28, -bl);
    ctx.lineTo(28, bl);
    ctx.stroke();
    ctx.restore();
  };
  const bannerClouds = Array.from({ length: 6 }, () => ({ x: rnd() * W, y: H * (0.2 + rnd() * 0.6), s: 24 + rnd() * 40 }));
  const drawBanner = (r: number, t: number) => {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#2d5b87');
    sky.addColorStop(1, `rgb(${BG})`);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.08)';
    for (const k of bannerClouds) {
      const x = (((k.x - t * 0.03) % (W + 120)) + W + 120) % (W + 120) - 60;
      ctx.beginPath();
      ctx.ellipse(x, k.y, k.s, k.s * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const q = clamp01((r + T_INTRO) / (T_INTRO + BANNER_T));
    const px = W + 70 + (bx0 - 80 - (W + 70)) * (1 - Math.pow(1 - q, 2.2));
    const gone = clamp01((r - BANNER_T) / 600); // once the banner is home the plane climbs away
    const planeX = px - gone * 160;
    const planeY = bPlaneY - gone * 90;
    const damp = 1 - 0.85 * clamp01((r - BANNER_T + 300) / 600);
    const bL = px + 80;
    const ox = bL - bx0;
    const bw = bx1 - bx0;
    const wv = (x: number) => 7 * damp * (0.15 + 0.85 * clamp01((x - bL) / bw)) * Math.sin((x - bL) * 0.05 - t * 0.012);
    if (gone < 1) {
      ctx.strokeStyle = `rgba(217,207,168,${1 - gone})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(planeX + 30, planeY + 3);
      ctx.lineTo(bL, by0 + wv(bL));
      ctx.moveTo(planeX + 30, planeY + 3);
      ctx.lineTo(bL, by1 + wv(bL));
      ctx.stroke();
    }
    const cloth = () => {
      ctx.beginPath();
      ctx.moveTo(bL, by0 + wv(bL));
      for (let x = bL + 6; x < bL + bw; x += 6) ctx.lineTo(x, by0 + wv(x));
      ctx.lineTo(bL + bw, by0 + wv(bL + bw));
      ctx.lineTo(bL + bw, by1 + wv(bL + bw));
      for (let x = bL + bw - 6; x > bL; x -= 6) ctx.lineTo(x, by1 + wv(x));
      ctx.lineTo(bL, by1 + wv(bL));
      ctx.closePath();
    };
    ctx.save();
    cloth();
    ctx.clip();
    ctx.fillStyle = '#f6f0dc';
    ctx.fillRect(bL - 2, by0 - 12, bw + 4, by1 - by0 + 24);
    for (let x = bL; x < bL + bw; x += 6) {
      const s = Math.cos((x - bL) * 0.05 - t * 0.012);
      ctx.fillStyle = s > 0 ? `rgba(255,255,255,${0.25 * s * damp})` : `rgba(80,60,20,${-0.12 * s * damp})`;
      ctx.fillRect(x, by0 - 12, 6, by1 - by0 + 24);
    }
    ctx.font = `${fs}px ${FONT}`;
    ctx.fillStyle = '#7a1424';
    for (const c of visible) ctx.fillText(c.ch, c.x + ox, c.y + wv(c.x + ox));
    ctx.restore();
    cloth();
    ctx.strokeStyle = '#b83a3a';
    ctx.lineWidth = 2;
    ctx.stroke();
    towPlane(planeX, planeY, t);
    fadeToFinal(r);
  };

  // Balloons: a bunch floats up with a letter behind each; they pop one by one to show the message.
  const balloons = visible.map((c, i) => ({ c, hue: (i * 47 + rnd() * 30) % 360, rs: -T_INTRO + rnd() * 400, ph: rnd() * 6 }));
  const drawBalloons = (r: number, t: number) => {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#1b2c4f');
    sky.addColorStop(1, '#2a1f4a');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    const rad = cw * 0.95;
    const letters: Cell[] = [];
    for (const b of balloons) {
      const pt = b.c.lock + BAL_POP;
      const cx0 = b.c.x + cw / 2;
      const cy0 = b.c.y - fs * 0.3;
      if (r >= pt) {
        letters.push(b.c);
        const a = (r - pt) / BAL_SHRED;
        if (a < 1) {
          if (a < 0.18) {
            ctx.fillStyle = `rgba(255,240,160,${1 - a / 0.18})`;
            ctx.beginPath();
            for (let k = 0; k < 10; k++) {
              const ang = (k / 10) * Math.PI * 2;
              const rr = (k % 2 ? rad * 0.6 : rad * 1.5) * (0.5 + a * 4);
              ctx.lineTo(cx0 + Math.cos(ang) * rr, cy0 + Math.sin(ang) * rr);
            }
            ctx.closePath();
            ctx.fill();
          }
          for (let k = 0; k < 6; k++) {
            const ang = (k / 6) * Math.PI * 2 + b.ph;
            const d = a * 22;
            ctx.fillStyle = `hsla(${b.hue},80%,60%,${1 - a})`;
            circ(cx0 + Math.cos(ang) * d, cy0 + Math.sin(ang) * d + a * a * 14, 2.2 * (1 - a * 0.5));
          }
        }
        continue;
      }
      if (r < b.rs) continue;
      const rise = clamp01((r - b.rs) / 900);
      const y = H + 40 + (cy0 - (H + 40)) * ease(rise) + Math.sin(t / 500 + b.ph) * 2 * rise;
      const x = cx0 + Math.sin(t / 700 + b.ph) * 1.5;
      const sw = 1 + 0.25 * clamp01((r - (pt - 160)) / 160); // it swells just before it pops
      const ry = rad * 1.18 * sw;
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y + ry);
      ctx.quadraticCurveTo(x + 5, y + ry + 9, x - 2, y + ry + 18);
      ctx.stroke();
      ctx.fillStyle = `hsl(${b.hue},78%,58%)`;
      ctx.beginPath();
      ctx.ellipse(x, y, rad * sw, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - 2, y + ry - 1);
      ctx.lineTo(x + 2, y + ry - 1);
      ctx.lineTo(x, y + ry + 4);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.45)';
      ctx.beginPath();
      ctx.ellipse(x - rad * 0.35 * sw, y - rad * 0.4 * sw, rad * 0.2, rad * 0.32, -0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = `${fs}px ${FONT}`;
    for (const c of letters) textLit(c, '#fff6d0', 'rgba(255,200,90,.7)', 6);
    fadeToFinal(r);
  };
  // Quill: a feather pen rises out of an ink pot and writes the message in cursive on parchment.
  const QFONT = (px: number) => `italic ${px}px 'Segoe Script','Snell Roundhand','Brush Script MT','Lucida Handwriting','Apple Chancery',cursive`;
  const qLines = lineYs.map((y) => {
    const first = visible.findIndex((c) => c.y === y);
    let last = first;
    for (let i = first; i < visible.length && visible[i].y === y; i++) last = i;
    return { y, text: cells.filter((c) => c.y === y).map((c) => c.ch).join(''), t0: typeAt[first], t1: typeAt[last] + perChar, w: 0, x0: 0 };
  });
  let qs = fs * 1.3;
  ctx.font = QFONT(qs);
  const qWidest = Math.max(1, ...qLines.map((l) => ctx.measureText(l.text).width));
  if (qWidest > W - pad * 2) qs *= (W - pad * 2) / qWidest;
  ctx.font = QFONT(qs);
  for (const l of qLines) {
    l.w = ctx.measureText(l.text).width;
    l.x0 = (W - l.w) / 2;
  }
  const potX = W - 56;
  const potY = H - 22;
  const mouth = { x: potX - 2, y: potY - 36 };
  const nibAt = (l: { y: number }, x: number) => ({ x, y: l.y - qs * 0.2 });
  const penAt = (r: number) => {
    const first = qLines[0];
    if (r < 0) {
      const e = ease((r + T_INTRO) / T_INTRO);
      const s = nibAt(first, first.x0);
      return { x: mouth.x + (s.x - mouth.x) * e, y: mouth.y + (s.y - mouth.y) * e - 60 * Math.sin(Math.PI * e) };
    }
    let k = 0;
    qLines.forEach((l, i) => {
      if (r >= l.t0) k = i;
    });
    const l = qLines[k];
    if (r <= l.t1) {
      const f = clamp01((r - l.t0) / Math.max(1, l.t1 - l.t0));
      const n = nibAt(l, l.x0 + l.w * f);
      return { x: n.x, y: n.y + Math.sin(r / 55) * 2.5 };
    }
    const a = nibAt(l, l.x0 + l.w);
    const nx = qLines[k + 1];
    if (nx) {
      const b = nibAt(nx, nx.x0);
      const f = ease((r - l.t1) / Math.max(1, nx.t0 - l.t1));
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f - 14 * Math.sin(Math.PI * f) };
    }
    const f = ease((r - l.t1) / 500);
    return { x: a.x + (mouth.x - a.x) * f, y: a.y + (mouth.y - a.y) * f - 40 * Math.sin(Math.PI * f) };
  };
  const drawQuill = (r: number, t: number) => {
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#efe0b8');
    bg.addColorStop(1, '#dcc48c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(90,60,20,0)');
    vg.addColorStop(1, 'rgba(90,60,20,.3)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#24180c';
    for (const l of qLines) {
      const p = r < l.t0 ? 0 : clamp01((r - l.t0) / Math.max(1, l.t1 - l.t0));
      if (p <= 0) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(l.x0 - 6, l.y - qs * 1.4, l.w * p + (p >= 1 ? 24 : 2), qs * 2);
      ctx.clip();
      ctx.font = QFONT(qs);
      ctx.fillText(l.text, l.x0, l.y);
      ctx.restore();
    }
    // the ink pot
    ctx.fillStyle = '#1d2b3a';
    ctx.beginPath();
    ctx.moveTo(potX - 24, potY);
    ctx.lineTo(potX - 24, potY - 22);
    ctx.quadraticCurveTo(potX - 24, potY - 30, potX - 12, potY - 31);
    ctx.lineTo(potX + 12, potY - 31);
    ctx.quadraticCurveTo(potX + 24, potY - 30, potX + 24, potY - 22);
    ctx.lineTo(potX + 24, potY);
    ctx.quadraticCurveTo(potX, potY + 8, potX - 24, potY);
    ctx.fill();
    ctx.fillStyle = 'rgba(160,200,240,.25)';
    ctx.beginPath();
    ctx.ellipse(potX - 15, potY - 14, 3, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#050708';
    ctx.beginPath();
    ctx.ellipse(potX, potY - 33, 12, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    // the quill itself
    const p = penAt(r);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-0.08 + Math.sin(t / 380) * 0.02);
    ctx.fillStyle = '#f7f3e8';
    ctx.strokeStyle = '#a79f8c';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(5, -14);
    ctx.bezierCurveTo(-26, -52, -10, -102, 62, -132);
    ctx.bezierCurveTo(48, -98, 42, -56, 5, -14);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    for (let k = 1; k < 8; k++) {
      const f = k / 8;
      const sx = 62 * f;
      const sy = -132 * f;
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx - 16 * Math.sin(f * 3), sy + 9);
    }
    ctx.stroke();
    ctx.strokeStyle = '#7d725d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(62, -132);
    ctx.stroke();
    ctx.fillStyle = '#24180c';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(4, -10);
    ctx.lineTo(-3, -9);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    fadeToFinal(r);
  };

  // Dominoes: a row of tiles stands over the writing and topples in a chain, uncovering each letter.
  const domH = fs * 1.1;
  const domW = cw * 0.72;
  const drawDominoes = (r: number) => {
    clear();
    ctx.font = `${fs}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    for (const y of lineYs) ctx.fillRect(pad / 2, y + 3, W - pad, 1);
    visible.forEach((c, i) => {
      const appear = clamp01((r + T_INTRO - (i / visible.length) * (T_INTRO - 150)) / 150);
      if (appear <= 0) return;
      const fall = clamp01((r - typeAt[i]) / 170);
      ctx.save();
      ctx.globalAlpha = appear;
      ctx.translate(c.x + cw / 2 + domW / 2, c.y + 3);
      ctx.rotate(fall * (Math.PI / 2 - 0.05));
      ctx.fillStyle = `hsl(${(i * 23) % 360},65%,46%)`;
      ctx.fillRect(-domW, -domH, domW, domH);
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.fillRect(-domW, -domH * 0.55, domW, 1.2);
      ctx.restore();
    });
    visible.forEach((c, i) => {
      const age = r - typeAt[i] - 60;
      if (age < 0) return;
      textLit(c, age < 250 ? '#ffffff' : '#e8fff4', 'rgba(80,255,190,.6)', age < 250 ? 10 : 5);
    });
    fadeToFinal(r);
  };

  // Treasure chest: the lid creaks open and gold coins fly out, each landing as a letter.
  const chX = W / 2;
  const chY = H - 16;
  const chH = 34;
  const coinFrom = { x: chX, y: chY - chH - 8 };
  const drawTreasure = (r: number, t: number) => {
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0e1a26');
    bg.addColorStop(1, '#1a2530');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    const open = ease((r + T_INTRO) / T_INTRO);
    const glow = ctx.createRadialGradient(chX, chY - chH, 4, chX, chY - chH, 90);
    glow.addColorStop(0, `rgba(255,214,90,${0.55 * open})`);
    glow.addColorStop(1, 'rgba(255,214,90,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#6b4423';
    ctx.fillRect(chX - 35, chY - chH, 70, chH);
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    for (let k = 1; k < 4; k++) ctx.fillRect(chX - 35, chY - chH + k * (chH / 4), 70, 1);
    ctx.fillStyle = '#3a3f47';
    ctx.fillRect(chX - 36, chY - chH, 72, 4);
    ctx.fillRect(chX - 26, chY - chH, 5, chH);
    ctx.fillRect(chX + 21, chY - chH, 5, chH);
    ctx.fillStyle = '#ffd23f';
    ctx.fillRect(chX - 8, chY - chH + 8, 16, 9);
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath();
    ctx.ellipse(chX, chY - chH + 1, 30, 5 * open, 0, 0, Math.PI * 2);
    ctx.fill();
    const lidY = chY - chH - 16 - open * 26;
    ctx.fillStyle = open > 0.5 ? '#4a1a14' : '#7a4f2a';
    ctx.fillRect(chX - (35 - open * 5), lidY, 70 - open * 10, 16);
    ctx.fillStyle = '#3a3f47';
    ctx.fillRect(chX - (36 - open * 5), lidY, 72 - open * 10, 3);
    ctx.font = `${fs}px ${FONT}`;
    const landed: Cell[] = [];
    for (const c of visible) {
      const q = (r - c.lock) / COIN_T;
      if (q < 0) continue;
      const tx = c.x + cw / 2;
      const ty = c.y - fs * 0.3;
      if (q >= 1) {
        landed.push(c);
        const a = (q - 1) * COIN_T;
        if (a < 260) {
          ctx.fillStyle = `rgba(255,224,120,${0.6 * (1 - a / 260)})`;
          circ(tx, ty, 4 + a / 26);
        }
        continue;
      }
      const e = q * q * (3 - 2 * q);
      const x = coinFrom.x + (tx - coinFrom.x) * e;
      const y = coinFrom.y + (ty - coinFrom.y) * e - (50 + Math.abs(tx - coinFrom.x) * 0.15) * 4 * q * (1 - q);
      const sq = Math.max(0.15, Math.abs(Math.cos(q * 14 + c.x)));
      ctx.fillStyle = '#b8870b';
      ctx.beginPath();
      ctx.ellipse(x, y, 5 * sq + 0.8, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffd23f';
      ctx.beginPath();
      ctx.ellipse(x, y, 4 * sq, 4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const c of landed) textLit(c, r - c.lock - COIN_T < 260 ? '#ffe59a' : '#e8fff4', 'rgba(255,200,80,.7)', 6);
    fadeToFinal(r);
    void t;
  };

  // Paper planes: each word is folded into a plane that glides in, lands on its spot and unfolds into the word.
  const ppStart = wt.map(() => 16 + rnd() * H * 0.4);
  const planePos = (i: number, w: { cx: number; cells: Cell[] }, q: number) => {
    const sx = i % 2 ? W + 30 : -30;
    const ex = w.cx;
    const ey = w.cells[0].y - fs * 0.3;
    const e = q * q * (3 - 2 * q);
    return { x: sx + (ex - sx) * e, y: ppStart[i] + (ey - ppStart[i]) * e + Math.sin(q * Math.PI * 2) * 20 * (1 - q) };
  };
  const drawPlanes = (r: number) => {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#223a5c');
    sky.addColorStop(1, `rgb(${BG})`);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    ctx.font = `${fs}px ${FONT}`;
    const shown: Cell[] = [];
    const FLY_T = PP_T - 200;
    for (const { w, i, t0 } of wt) {
      const rr = r - t0;
      if (rr < 0) continue;
      if (rr >= FLY_T) {
        shown.push(...w.cells);
        const a = (rr - FLY_T) / 200;
        if (a < 1) {
          ctx.fillStyle = `rgba(255,255,255,${0.5 * (1 - a)})`;
          ctx.beginPath();
          ctx.ellipse(w.cx, w.cells[0].y - fs * 0.3, (w.x1 - w.x0) / 2 + 6 * a, 10 + 8 * a, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        continue;
      }
      const q = rr / FLY_T;
      for (let k = 6; k >= 1; k--) {
        const pq = q - k * 0.035;
        if (pq < 0) continue;
        const tp = planePos(i, w, pq);
        ctx.fillStyle = `rgba(255,255,255,${0.35 - k * 0.05})`;
        circ(tp.x, tp.y, 1.6);
      }
      const p = planePos(i, w, q);
      const n = planePos(i, w, Math.min(1, q + 0.02));
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.atan2(n.y - p.y, n.x - p.x));
      ctx.fillStyle = '#f4f4f8';
      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(-10, -7);
      ctx.lineTo(-2, 0);
      ctx.fill();
      ctx.fillStyle = '#c4c8d6';
      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(-10, 5);
      ctx.lineTo(-2, 0);
      ctx.fill();
      ctx.restore();
    }
    for (const c of shown) textLit(c, '#f4f8ff', 'rgba(150,200,255,.7)', 5);
    fadeToFinal(r);
  };
  // Ghostly letters: pale sheets drift through a moonlit mist and each letter materialises out of it, shivering, then settles.
  const ghostSheet = (x: number, y: number, sz: number, ph: number, alpha: number, dir: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir * sz, sz);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#dff3ff';
    ctx.shadowColor = 'rgba(160,220,255,.8)';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(-18, 22);
    ctx.quadraticCurveTo(-20, -22, 0, -22);
    ctx.quadraticCurveTo(20, -22, 18, 22);
    for (let k = 0; k < 4; k++) {
      const x1 = 18 - (k + 0.5) * 9;
      ctx.quadraticCurveTo(x1 + 2, 22 + (k % 2 ? 7 : -3) + Math.sin(ph + k) * 3, 18 - (k + 1) * 9, 22);
    }
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#16233a';
    ctx.beginPath();
    ctx.ellipse(-6, -8, 3, 5, 0, 0, Math.PI * 2);
    ctx.ellipse(6, -8, 3, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, 4, 3.5, 5 + Math.sin(ph) * 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  };
  const ghosts = [0, 1, 2].map((k) => ({ y: H * (0.2 + 0.3 * k) + rnd() * 20, sp: 0.045 + rnd() * 0.03, off: rnd() * W, sz: 0.9 + rnd() * 0.5 }));
  const drawGhosts = (r: number) => {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#0e1a30');
    sky.addColorStop(1, `rgb(${BG})`);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(235,245,255,.9)';
    circ(W * 0.86, H * 0.16, 16);
    for (let k = 0; k < 4; k++) {
      const fx = ((k * 0.31 + r * 0.00004 * (k + 1)) % 1.4) * W - W * 0.2;
      const g = ctx.createRadialGradient(fx, H * (0.25 + 0.2 * k), 5, fx, H * (0.25 + 0.2 * k), W * 0.3);
      g.addColorStop(0, 'rgba(170,200,230,.13)');
      g.addColorStop(1, 'rgba(170,200,230,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    const fade = r > T_RES - 300 ? Math.max(0, 1 - (r - T_RES + 300) / 300) : 1;
    ghosts.forEach((g, k) => {
      const span = W + 120;
      const gx = (((g.off + (r + T_INTRO) * g.sp * (k % 2 ? -1 : 1)) % span) + span) % span - 60;
      ghostSheet(gx, g.y + Math.sin(r / 400 + k * 2) * 12, g.sz, r / 200 + k, 0.28 * fade, k % 2 ? -1 : 1);
    });
    ctx.font = `${fs}px ${FONT}`;
    for (const c of visible) {
      const rr = r - c.lock;
      if (rr < 0) continue;
      const q = Math.min(1, rr / GHOST_T);
      const flick = q < 1 ? 0.65 + 0.35 * Math.sin(rr / 55 + c.x) : 1;
      const wob = Math.sin(rr / 90 + c.x * 0.37) * (1 - q) * 4;
      const rise = (1 - ease(q)) * 16;
      if (q < 1) textLit(c, '#bfe4ff', 'rgba(150,210,255,.6)', 10, c.x + wob * 1.6, c.y + rise + 10, 0.22 * q * flick);
      textLit(c, '#e6f6ff', 'rgba(150,220,255,.85)', 8 + (1 - q) * 6, c.x + wob, c.y + rise, Math.min(1, (0.15 + q) * flick));
    }
    fadeToFinal(r);
  };
  // Seance: a planchette glides across a candle-lit board and spells each word out.
  const clamp1 = (v: number) => Math.min(1, Math.max(0, v));
  const drawSeance = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#2b1a10');
    g.addColorStop(1, '#150c07');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    for (const cx of [26, W - 26]) {
      ctx.fillStyle = '#e8dcc0';
      ctx.fillRect(cx - 5, H - 46, 10, 40);
      const fl = 1 + Math.sin(r / 70 + cx) * 0.18;
      const halo = ctx.createRadialGradient(cx, H - 54, 2, cx, H - 54, 70);
      halo.addColorStop(0, 'rgba(255,190,90,.35)');
      halo.addColorStop(1, 'rgba(255,190,90,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(cx - 80, H - 130, 160, 140);
      ctx.fillStyle = '#ffcf6a';
      ctx.beginPath();
      ctx.ellipse(cx, H - 54, 4, 9 * fl, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = `${fs}px ${FONT}`;
    for (const c of visible) {
      const rr = r - c.lock;
      if (rr < 0) continue;
      textLit(c, '#ffe9b0', 'rgba(255,190,90,.85)', 9 - 4 * clamp1(rr / 500), c.x, c.y, clamp1(rr / 450));
    }
    let cur = -1;
    for (const x of wt) if (x.t0 <= r) cur = x.i;
    const spot = (k: number) => (k < 0 ? { x: W / 2, y: H * 0.8 } : { x: wt[k].w.cx, y: wt[k].w.cells[0].y - fs * 0.3 });
    const to = spot(cur);
    const from = spot(cur - 1);
    const e = cur < 0 ? 0 : ease((r - wt[cur].t0) / 320);
    const px = from.x + (to.x - from.x) * e + (cur < 0 ? Math.sin(r / 300) * 12 : 0);
    const py = from.y + (to.y - from.y) * e;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(Math.sin(r / 260) * 0.08);
    ctx.fillStyle = '#6b4a2a';
    ctx.shadowColor = 'rgba(0,0,0,.6)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(0, -22);
    ctx.quadraticCurveTo(26, 6, 0, 22);
    ctx.quadraticCurveTo(-26, 6, 0, -22);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(235,225,200,.55)';
    circ(0, 2, 7);
    ctx.restore();
    fadeToFinal(r);
  };

  // Poltergeist: the letters whirl around the room, then are flung into their places one by one.
  const POLT_T = 520;
  const orbit = (i: number, r: number) => {
    const m = Math.min(W, H);
    const ang = r / 380 + i * 0.9;
    const rad = m * (0.14 + (i % 5) * 0.06) + Math.sin(r / 300 + i) * 10;
    return { x: W / 2 + Math.cos(ang) * rad * 1.7, y: H / 2 + Math.sin(ang) * rad };
  };
  const drawPolter = (r: number) => {
    const g = ctx.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, W * 0.7);
    g.addColorStop(0, '#12261f');
    g.addColorStop(1, `rgb(${BG})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.font = `${fs}px ${FONT}`;
    const open = clamp1((r + T_INTRO) / T_INTRO);
    visible.forEach((c, i) => {
      const rr = r - c.lock;
      if (rr >= POLT_T) {
        textLit(c, '#e4fff0', 'rgba(120,255,190,.8)', rr < POLT_T + 200 ? 16 : 6);
      } else if (rr >= 0) {
        const q = ease(rr / POLT_T);
        const o = orbit(i, c.lock);
        textLit(c, '#c9ffe2', 'rgba(120,255,190,.8)', 10, o.x + (c.x - o.x) * q, o.y + (c.y - o.y) * q + Math.sin(q * Math.PI) * -26, 0.9);
      } else {
        const o = orbit(i, r);
        textLit(c, '#9fe8c4', 'rgba(120,255,190,.5)', 6, o.x, o.y, 0.7 * open);
      }
    });
    fadeToFinal(r);
  };

  // Haunted house: a ghost slips out of a window, carries each word to its place and leaves it there.
  const HAUNT_T = 1100;
  const drawHaunted = (r: number) => {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#12122a');
    sky.addColorStop(1, `rgb(${BG})`);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(240,240,220,.9)';
    circ(W * 0.12, H * 0.16, 15);
    const hx = W / 2;
    ctx.fillStyle = '#05070c';
    ctx.fillRect(hx - 70, H - 70, 140, 70);
    ctx.fillRect(hx + 40, H - 112, 26, 46);
    ctx.beginPath();
    ctx.moveTo(hx - 82, H - 70);
    ctx.lineTo(hx, H - 118);
    ctx.lineTo(hx + 82, H - 70);
    ctx.fill();
    const wins = [hx - 48, hx - 8, hx + 32].map((x, k) => ({ x, y: H - 54, on: 0.7 + 0.3 * Math.sin(r / 110 + k * 2) }));
    for (const w of wins) {
      ctx.fillStyle = `rgba(255,210,90,${w.on})`;
      ctx.fillRect(w.x, w.y, 16, 22);
    }
    ctx.font = `${fs}px ${FONT}`;
    const fade = r > T_RES - 300 ? clamp1(1 - (r - T_RES + 300) / 300) : 1;
    for (const { w, i, t0 } of wt) {
      const rr = r - t0;
      if (rr < 0) continue;
      const win = wins[i % 3];
      const ey = w.cells[0].y - fs * 0.9;
      if (rr < HAUNT_T) {
        const q = rr / HAUNT_T;
        const e = q * q * (3 - 2 * q);
        ghostSheet(win.x + 8 + (w.cx - win.x - 8) * e + Math.sin(q * 7 + i) * 16 * (1 - q), win.y + (ey - win.y) * e, 0.55 + 0.45 * q, rr / 150, 0.6 * fade, w.cx > win.x ? 1 : -1);
        continue;
      }
      const out = rr - HAUNT_T;
      if (out < 450) ghostSheet(w.cx + out * 0.1, ey - out * 0.18, 1, rr / 150, 0.6 * (1 - out / 450) * fade, 1);
      for (const c of w.cells) textLit(c, '#eaf6ff', 'rgba(160,210,255,.8)', 8 - 3 * clamp1(out / 500), c.x, c.y, clamp1(out / 250));
    }
    fadeToFinal(r);
  };

  // Dragon: a scaly dragon sits in the bottom-left corner and breathes the words out in a stream of fire;
  // each letter flies from its mouth to its place, white-hot, and cools there.
  const du = Math.min(1.3, Math.max(0.6, H / 300)); // the dragon is drawn in a 300-unit-high space and scaled
  const drMouth = { x: 172 * du, y: H - 102 * du };
  const scaled = (path: () => void, base0: string, base1: string, y0: number, y1: number) => {
    ctx.save();
    path();
    ctx.clip();
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, base0);
    g.addColorStop(1, base1);
    ctx.fillStyle = g;
    ctx.fillRect(-20, y0 - 10, 320, y1 - y0 + 20);
    ctx.strokeStyle = 'rgba(190,255,200,.32)';
    ctx.lineWidth = 1.2;
    for (let row = 0, y = y0; y < y1 + 10; row++, y += 8) {
      for (let x = -20 + (row % 2) * 5; x < 300; x += 10) {
        ctx.beginPath();
        ctx.arc(x, y, 5.5, 0.1, Math.PI - 0.1);
        ctx.stroke();
      }
    }
    ctx.restore();
  };
  const drawDragonBody = (open: number, r: number) => {
    ctx.save();
    ctx.translate(0, H);
    ctx.scale(du, du);
    ctx.fillStyle = '#5a1a2c'; // folded wing
    ctx.beginPath();
    ctx.moveTo(-5, -70);
    ctx.lineTo(-22, -160);
    ctx.lineTo(70, -98);
    ctx.closePath();
    ctx.fill();
    scaled(() => { // tail along the floor
      ctx.beginPath();
      ctx.moveTo(90, 0);
      ctx.lineTo(110, -16);
      ctx.quadraticCurveTo(190, -26, 245, -3);
      ctx.lineTo(245, 0);
      ctx.closePath();
    }, '#2f7a4c', '#1c4a31', -26, 0);
    scaled(() => { // body
      ctx.beginPath();
      ctx.ellipse(50, -45, 78, 52, 0, 0, Math.PI * 2);
    }, '#3f9a5f', '#1f5a3a', -97, 7);
    scaled(() => { // neck
      ctx.beginPath();
      ctx.moveTo(40, -60);
      ctx.quadraticCurveTo(50, -120, 85, -135);
      ctx.lineTo(125, -110);
      ctx.quadraticCurveTo(105, -95, 105, -50);
      ctx.closePath();
    }, '#4aa86b', '#2a6e48', -135, -50);
    ctx.fillStyle = '#d8c9a0'; // horns
    ctx.beginPath();
    ctx.moveTo(92, -135);
    ctx.lineTo(70, -168);
    ctx.lineTo(114, -131);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(110, -131);
    ctx.lineTo(100, -158);
    ctx.lineTo(126, -127);
    ctx.fill();
    if (open > 0.03) { // the glowing throat
      ctx.fillStyle = `rgba(255,${Math.round(110 + 80 * Math.sin(r / 60) ** 2)},30,.95)`;
      ctx.beginPath();
      ctx.moveTo(100, -104);
      ctx.lineTo(168, -104);
      ctx.lineTo(150, -104 + 22 * open);
      ctx.lineTo(100, -96 + 8 * open);
      ctx.fill();
    }
    scaled(() => { // upper head
      ctx.beginPath();
      ctx.moveTo(80, -135);
      ctx.lineTo(150, -129);
      ctx.quadraticCurveTo(178, -120, 174, -106);
      ctx.lineTo(100, -104);
      ctx.quadraticCurveTo(78, -100, 74, -118);
      ctx.closePath();
    }, '#55b877', '#2f7a4c', -135, -104);
    ctx.save(); // lower jaw swings down from its hinge
    ctx.translate(100, -104);
    ctx.rotate(open * 0.55);
    ctx.translate(-100, 104);
    scaled(() => {
      ctx.beginPath();
      ctx.moveTo(100, -104);
      ctx.lineTo(168, -104);
      ctx.quadraticCurveTo(164, -92, 132, -89);
      ctx.lineTo(96, -92);
      ctx.closePath();
    }, '#3f9a5f', '#2a6e48', -104, -89);
    ctx.fillStyle = '#f2ecd6'; // teeth
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.moveTo(122 + k * 12, -104);
      ctx.lineTo(126 + k * 12, -96);
      ctx.lineTo(130 + k * 12, -104);
      ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = '#ffd24a'; // eye with a slit pupil, and a nostril
    ctx.beginPath();
    ctx.ellipse(128, -121, 5, 3.6, -0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#16100a';
    ctx.fillRect(127, -125, 1.8, 7);
    ctx.beginPath();
    ctx.ellipse(160, -120, 2.6, 1.6, 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
  const drPath = (c: Cell, q: number) => {
    const cx = (drMouth.x + c.x) / 2;
    const cy = Math.min(drMouth.y, c.y) - 50 * du;
    const a = (1 - q) * (1 - q);
    const b = 2 * q * (1 - q);
    return { x: a * drMouth.x + b * cx + q * q * c.x, y: a * drMouth.y + b * cy + q * q * c.y };
  };
  const drFirst = Math.min(...visible.map((c) => c.lock));
  const drLast = Math.max(...visible.map((c) => c.lock));
  const drawDragon = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#2a0f1c');
    g.addColorStop(1, `rgb(${BG})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const active = r >= drFirst - 150 && r <= drLast + DR_FLY * 0.5;
    const open = active ? 0.6 + 0.4 * Math.sin(r / 110) ** 2 : 0;
    const glow = ctx.createRadialGradient(drMouth.x, drMouth.y, 5, drMouth.x, drMouth.y, W * 0.5);
    glow.addColorStop(0, `rgba(255,140,40,${active ? 0.22 : 0.04})`);
    glow.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    drawDragonBody(open, r);
    if (active) { // the fire stream, aimed at the middle of the text
      const aim = Math.atan2(H * 0.4 - drMouth.y, W * 0.55 - drMouth.x);
      const len = Math.min(W * 0.3, 240);
      for (let j = 0; j < 18; j++) {
        const p = j / 17;
        const wob = Math.sin(r / 45 + j * 1.7) * 6 * p * du;
        const x = drMouth.x + Math.cos(aim) * len * p - Math.sin(aim) * wob;
        const y = drMouth.y + Math.sin(aim) * len * p + Math.cos(aim) * wob;
        ctx.fillStyle = p < 0.35 ? `rgba(255,230,130,${0.6 - p})` : `rgba(255,${Math.round(150 - 90 * p)},40,${0.55 - 0.3 * p})`;
        circ(x, y, (4 + 16 * p) * du);
      }
    }
    ctx.font = `${fs}px ${FONT}`;
    for (const c of visible) {
      const rr = r - c.lock;
      if (rr < 0) continue;
      if (rr < DR_FLY) {
        const q = rr / DR_FLY;
        for (let k = 4; k >= 1; k--) {
          const pq = q - k * 0.06;
          if (pq < 0) continue;
          const tp = drPath(c, pq);
          ctx.fillStyle = `rgba(255,${Math.round(190 - 25 * k)},50,${0.5 - k * 0.1})`;
          circ(tp.x, tp.y, 3.4 - k * 0.5);
        }
        const p = drPath(c, q);
        textLit(c, '#fff6c0', 'rgba(255,150,40,.95)', 14, p.x, p.y, 0.4 + 0.6 * q);
        continue;
      }
      const p = clamp1((rr - DR_FLY) / 500);
      ctx.fillStyle = `rgb(${Math.round(255 - 23 * p)},${Math.round(246 + 9 * p)},${Math.round(192 + 52 * p)})`;
      ctx.shadowColor = `rgba(255,${Math.round(140 + 70 * p)},40,${0.95 - 0.35 * p})`;
      ctx.shadowBlur = 14 - 8 * p;
      ctx.fillText(c.ch, c.x, c.y);
      ctx.shadowBlur = 0;
    }
    fadeToFinal(r);
  };
  // Pink panther: a sleek pink cat sneaks along each line in creeping bursts, glancing about, and writes the words with a big pen.
  const pnkSpan = lineYs.map((y) => {
    const xs = visible.filter((c) => c.y === y).map((c) => c.x);
    return { y, x0: Math.min(...xs), x1: Math.max(...xs) };
  });
  const stopGo = (f: number) => f - (0.9 * Math.sin(2 * Math.PI * 5 * f)) / (2 * Math.PI * 5); // 5 creeps with a pause between
  const pnkPen = (k: number, f: number) => {
    const ln = pnkSpan[k];
    const run = ln.x1 - ln.x0;
    return k % 2 ? ln.x1 + 30 - f * (run + 60) : ln.x0 - 30 + f * (run + 60);
  };
  const pink = (x: number, y: number, dir: number, ph: number, sz: number, tipUp: number, glance: boolean, writing: boolean, t: number) => {
    ctx.save();
    ctx.translate(x, y + Math.abs(Math.sin(ph)) * -1.5 * sz);
    ctx.scale(dir * sz, sz);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#ee6aa1';
    ctx.lineWidth = 6;
    ctx.beginPath(); // tail
    ctx.moveTo(-24, -24);
    ctx.bezierCurveTo(-50, -26, -52 + Math.sin(ph) * 3, -50, -42, -66);
    ctx.stroke();
    ctx.strokeStyle = '#d9568d'; // far legs
    for (const lx of [-14, 14]) {
      ctx.beginPath();
      ctx.moveTo(lx, -16);
      ctx.lineTo(lx - Math.sin(ph + 2) * 7, -1);
      ctx.stroke();
    }
    ctx.fillStyle = '#ff86b6'; // body
    ctx.beginPath();
    ctx.ellipse(0, -25, 27, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffa6c9';
    ctx.beginPath();
    ctx.ellipse(2, -20, 20, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ee6aa1'; // near back leg
    ctx.beginPath();
    ctx.moveTo(-8, -16);
    ctx.lineTo(-8 + Math.sin(ph + Math.PI) * 7, -1);
    ctx.stroke();
    ctx.beginPath(); // near front leg
    ctx.moveTo(20, -16);
    ctx.lineTo(20 + Math.sin(ph) * 7, -1);
    ctx.stroke();
    ctx.fillStyle = '#ff86b6'; // head
    ctx.beginPath();
    ctx.arc(30, -37, 11, 0, Math.PI * 2);
    ctx.arc(26, -47, 4, 0, Math.PI * 2);
    ctx.arc(35, -48, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffc2d9';
    ctx.beginPath();
    ctx.ellipse(40, -34, 7, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5a1d3a';
    ctx.beginPath();
    ctx.ellipse(46, -36, 2.4, 1.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff'; // a half-lidded eye that glances back while it checks nobody is watching
    ctx.beginPath();
    ctx.ellipse(36, -40, 4.2, 3.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#16101a';
    circ(glance ? 34.4 : 37.4, -39.2, 1.7);
    ctx.fillStyle = '#ff86b6';
    ctx.beginPath();
    ctx.ellipse(36, -41.4, 4.8, glance ? 1.4 : 2.4, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ee6aa1'; // the arm, holding the pen out in front
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(16, -26);
    ctx.lineTo(50, -24);
    ctx.stroke();
    ctx.strokeStyle = '#2a2a45'; // the pen: a big fountain pen
    ctx.lineWidth = 5.4;
    ctx.beginPath();
    ctx.moveTo(40, -58);
    ctx.lineTo(58, -tipUp - 3);
    ctx.stroke();
    ctx.strokeStyle = '#f2c44a';
    ctx.lineWidth = 4.6;
    ctx.beginPath();
    ctx.moveTo(54, -tipUp - 12);
    ctx.lineTo(55.5, -tipUp - 8);
    ctx.stroke();
    ctx.fillStyle = '#ff86b6'; // paw over the pen
    circ(50, -24, 3.6);
    ctx.fillStyle = '#d8d8e8'; // nib
    ctx.beginPath();
    ctx.moveTo(56, -tipUp - 4);
    ctx.lineTo(61, -tipUp - 4);
    ctx.lineTo(60, -tipUp);
    ctx.fill();
    if (writing) {
      ctx.fillStyle = '#ff5aa5';
      circ(60, -tipUp + 1, 1.8 + Math.sin(t / 40) * 0.5);
    }
    ctx.restore();
  };
  const drawPink = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#2a1030');
    g.addColorStop(1, `rgb(${BG})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const sz = Math.min(1.3, Math.max(0.8, fs / 16));
    let spot: { x: number; y: number } | null = null;
    pnkSpan.forEach((ln, k) => {
      const rb = r - k * PNK_GAP;
      if (rb < -200 || rb > PNK_LT + 300) return;
      const f = clamp1(rb / PNK_LT);
      const gf = stopGo(f);
      const dir = k % 2 ? -1 : 1;
      const pen = pnkPen(k, gf);
      const py = ln.y + fs * 0.75 * sz + 4;
      const slow = 1 - 0.9 * Math.cos(2 * Math.PI * 5 * f) < 0.4;
      spot = { x: pen, y: py - 30 };
      pink(pen - dir * 60 * sz, py, dir, gf * 60, sz, (py - (ln.y - fs * 0.3)) / sz, slow && f > 0.02 && f < 0.98, f > 0.02 && f < 0.98 && !slow, r);
    });
    if (spot) {
      const s = spot as { x: number; y: number };
      const lg = ctx.createRadialGradient(s.x, s.y, 8, s.x, s.y, 130);
      lg.addColorStop(0, 'rgba(255,170,210,.22)');
      lg.addColorStop(1, 'rgba(255,170,210,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.font = `${fs}px ${FONT}`;
    for (const c of visible) {
      const k = lineYs.indexOf(c.y);
      const rb = r - k * PNK_GAP;
      if (rb < 0) continue;
      const dist = (k % 2 ? -1 : 1) * (pnkPen(k, stopGo(clamp1(rb / PNK_LT))) - c.x);
      if (dist < 0) continue;
      const p = clamp1(dist / (fs * 2));
      textLit(c, p < 1 ? '#ffd1e6' : '#ffe8f2', 'rgba(255,110,180,.8)', 12 - 6 * p, c.x, c.y, clamp1(dist / (fs * 0.8)));
      if (dist < fs * 1.1) {
        const a = 1 - dist / (fs * 1.1);
        ctx.strokeStyle = `rgba(255,255,255,${a})`;
        ctx.lineWidth = 1.2;
        const sx = c.x + cw / 2;
        const sy = c.y - fs * 0.4;
        const rad = 3 + 4 * (1 - a);
        ctx.beginPath();
        ctx.moveTo(sx - rad, sy);
        ctx.lineTo(sx + rad, sy);
        ctx.moveTo(sx, sy - rad);
        ctx.lineTo(sx, sy + rad);
        ctx.stroke();
      }
    }
    fadeToFinal(r);
  };

  // Road chase: a fast blue bird races along each line leaving the words behind it, with a coyote on a rocket
  // always a step behind. After the last line the coyote's rocket flies on, off the edge, and ends with a bang.
  const rrTime = (c: Cell) => {
    const k = lineYs.indexOf(c.y);
    const ln = pnkSpan[k];
    const f = (c.x - ln.x0) / Math.max(1, ln.x1 - ln.x0);
    return k * RR_GAP + (k % 2 ? 1 - f : f) * RR_LT;
  };
  const rrEnd = (lineYs.length - 1) * RR_GAP + RR_LT + RR_LAG; // when the coyote leaves the last line
  const rrBang = rrEnd + 350; // and when it hits the edge
  const runner = (x: number, y: number, dir: number, ph: number, sz: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir * sz, sz);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#f0a030'; // legs: a whirl of orange
    ctx.lineWidth = 3;
    for (let j = 0; j < 4; j++) {
      const a = ph * 3 + (j * Math.PI) / 2;
      ctx.beginPath();
      ctx.moveTo(0, -14);
      ctx.lineTo(Math.cos(a) * 11, -14 + Math.abs(Math.sin(a)) * 12 + (Math.sin(a) < 0 ? -2 : 0));
      ctx.stroke();
    }
    ctx.fillStyle = '#26338f'; // tail feathers
    ctx.beginPath();
    ctx.moveTo(-14, -28);
    ctx.lineTo(-42, -38 + Math.sin(ph * 2) * 2);
    ctx.lineTo(-14, -21);
    ctx.fill();
    ctx.fillStyle = '#3f6fd8'; // body
    ctx.beginPath();
    ctx.ellipse(0, -26, 17, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#3f6fd8'; // neck
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(10, -30);
    ctx.lineTo(23, -50);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(26, -55, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#7a4fd0'; // crest
    ctx.lineWidth = 2.2;
    for (let j = 0; j < 3; j++) {
      ctx.beginPath();
      ctx.moveTo(24 - j, -60);
      ctx.lineTo(18 - j * 3, -70 - j);
      ctx.stroke();
    }
    ctx.fillStyle = '#f0a030'; // beak
    ctx.beginPath();
    ctx.moveTo(31, -57);
    ctx.lineTo(46, -54);
    ctx.lineTo(31, -52);
    ctx.fill();
    ctx.fillStyle = '#fff';
    circ(28, -57, 2.6);
    ctx.fillStyle = '#111';
    circ(29, -57, 1.2);
    ctx.restore();
  };
  const coyote = (x: number, y: number, dir: number, t: number, sz: number) => {
    ctx.save();
    ctx.translate(x, y - 6 * sz);
    ctx.scale(dir * sz, sz);
    const fl = 14 + Math.sin(t / 35) * 5;
    ctx.fillStyle = '#ffb02e'; // rocket flame
    ctx.beginPath();
    ctx.moveTo(-30, -20);
    ctx.lineTo(-30 - fl * 1.6, -17);
    ctx.lineTo(-30, -13);
    ctx.fill();
    ctx.fillStyle = '#fff3b0';
    ctx.beginPath();
    ctx.moveTo(-30, -18.5);
    ctx.lineTo(-30 - fl * 0.8, -17);
    ctx.lineTo(-30, -15.5);
    ctx.fill();
    ctx.fillStyle = '#c93030'; // rocket
    ctx.fillRect(-30, -22, 46, 10);
    ctx.beginPath();
    ctx.moveTo(16, -22);
    ctx.quadraticCurveTo(30, -17, 16, -12);
    ctx.fill();
    ctx.fillStyle = '#7d1c1c';
    ctx.beginPath();
    ctx.moveTo(-30, -22);
    ctx.lineTo(-38, -30);
    ctx.lineTo(-22, -22);
    ctx.fill();
    ctx.fillStyle = '#c89b66'; // the coyote, riding it
    ctx.beginPath();
    ctx.ellipse(-4, -32, 12, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#c89b66';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-2, -26);
    ctx.lineTo(4, -20);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(12, -38, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(8, -44);
    ctx.lineTo(9, -59);
    ctx.lineTo(15, -45);
    ctx.moveTo(13, -45);
    ctx.lineTo(19, -58);
    ctx.lineTo(20, -43);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(18, -41);
    ctx.lineTo(33, -35);
    ctx.lineTo(18, -32);
    ctx.fill();
    ctx.fillStyle = '#222';
    circ(33, -35, 2.4);
    ctx.fillStyle = '#fff';
    circ(14, -40, 3.2);
    ctx.fillStyle = '#111';
    circ(15.2, -39.6, 1.4);
    ctx.restore();
  };
  const drawRoad = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#3a2a55');
    g.addColorStop(0.55, '#b0643a');
    g.addColorStop(1, '#5a2f1c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(40,20,20,.35)'; // far mesas
    for (const [mx, mw, mh] of [[0.1, 90, 50], [0.45, 130, 70], [0.8, 100, 45]]) {
      ctx.fillRect(W * mx, H * 0.55 - mh, mw, mh);
    }
    const sz = Math.min(1.3, Math.max(0.8, fs / 16));
    const bang = r - rrBang;
    const shake = bang > 0 && bang < 300 ? (1 - bang / 300) * 6 : 0;
    ctx.save();
    ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    pnkSpan.forEach((ln, k) => {
      const rb = r - k * RR_GAP;
      const dir = k % 2 ? -1 : 1;
      const run = ln.x1 - ln.x0;
      const py = ln.y + fs * 0.75 * sz + 4;
      const at = (f: number) => (dir > 0 ? ln.x0 - 40 + f * (run + 80) : ln.x1 + 40 - f * (run + 80));
      if (rb > -100 && rb < RR_LT + 150) {
        const f = clamp1(rb / RR_LT);
        for (let j = 1; j <= 5; j++) { // dust
          ctx.fillStyle = `rgba(235,205,170,${0.4 - j * 0.07})`;
          circ(at(f) - dir * j * 14 * sz, py - 4 - j, (3 + j * 2) * sz);
        }
        runner(at(f), py, dir, r / 60, sz);
      }
      const rc = r - k * RR_GAP - RR_LAG;
      const last = k === lineYs.length - 1;
      if (rc > 0 && (last ? r < rrBang : rc < RR_LT + 60)) {
        let cx = at(rc / RR_LT);
        if (last && rc > RR_LT) {
          const edge = dir > 0 ? W - 24 : 24;
          cx = at(1) + (edge - at(1)) * clamp1((rc - RR_LT) / 350);
        }
        coyote(cx, py, dir, r, sz);
      }
    });
    ctx.font = `${fs}px ${FONT}`;
    for (const c of visible) {
      const rr = r - rrTime(c);
      if (rr < 0) continue;
      const p = clamp1(rr / 400);
      textLit(c, p < 1 ? '#d6e4ff' : '#f4f0e6', 'rgba(120,170,255,.8)', 10 - 5 * p, c.x, c.y, clamp1(rr / 150));
    }
    ctx.restore();
    if (bang > 0 && bang < RR_BANG) {
      const lastY = pnkSpan[pnkSpan.length - 1].y + fs * 0.75 * sz + 4;
      const bx = (lineYs.length - 1) % 2 ? 24 : W - 24;
      const by = lastY - 24;
      const q = bang / RR_BANG;
      ctx.fillStyle = `rgba(255,255,255,${0.7 * Math.max(0, 1 - q * 4)})`;
      ctx.fillRect(0, 0, W, H);
      const rad = (30 + 60 * ease(q)) * sz;
      ctx.fillStyle = `rgba(255,${Math.round(220 - 120 * q)},40,${1 - q * 0.8})`;
      ctx.beginPath();
      for (let j = 0; j < 24; j++) {
        const a = (j / 24) * Math.PI * 2;
        const rr2 = j % 2 ? rad * 0.55 : rad;
        ctx.lineTo(bx + Math.cos(a) * rr2, by + Math.sin(a) * rr2);
      }
      ctx.closePath();
      ctx.fill();
      for (let j = 0; j < 6; j++) { // smoke
        ctx.fillStyle = `rgba(70,60,60,${0.5 * (1 - q)})`;
        circ(bx + Math.cos(j * 1.1) * 40 * q * sz, by - 20 * q * sz - j * 8 * q + Math.sin(j) * 8, (12 + 16 * q) * sz);
      }
      ctx.font = `bold ${Math.round(fs * 1.5)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 4;
      ctx.strokeStyle = `rgba(90,10,10,${1 - q})`;
      ctx.fillStyle = `rgba(255,240,90,${1 - q * 0.6})`;
      const tx = Math.min(W - 50, Math.max(50, bx));
      ctx.strokeText('BANG!', tx, by - rad * 0.9);
      ctx.fillText('BANG!', tx, by - rad * 0.9);
      ctx.textAlign = 'start';
    }
    fadeToFinal(r);
  };
  // Genie: the cork pops, blue smoke pours out of the bottle and becomes a genie, who sweeps the words into place with a wave.
  const gu = Math.min(1.3, Math.max(0.6, H / 300));
  const gBottle = { x: 62 * gu, neck: H - 92 * gu };
  const gHome = { x: gBottle.x + 8 * gu, y: gBottle.neck - 112 * gu };
  const genieAt = (x: number, y: number, s: number, r: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s * gu, s * gu);
    const arm = Math.sin(r / 260) * 5;
    ctx.fillStyle = '#4aa3ff'; // torso
    ctx.beginPath();
    ctx.ellipse(0, 0, 22, 28, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f2c44a'; // gold sash
    ctx.beginPath();
    ctx.moveTo(-20, -8);
    ctx.lineTo(20, 8);
    ctx.lineTo(20, 14);
    ctx.lineTo(-20, -2);
    ctx.fill();
    ctx.strokeStyle = '#4aa3ff'; // arms
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-18, -8);
    ctx.quadraticCurveTo(-34, 4, -14, 12); // left hand on the hip
    ctx.moveTo(18, -10);
    ctx.quadraticCurveTo(40, -16 + arm, 56, -10 + arm * 1.4); // right arm, sweeping
    ctx.stroke();
    ctx.fillStyle = '#4aa3ff';
    circ(57, -10 + arm * 1.4, 6);
    ctx.strokeStyle = '#f2c44a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(44, -13 + arm * 1.2, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#4aa3ff'; // head
    circ(0, -38, 14);
    ctx.fillStyle = '#8a3fd0'; // turban
    ctx.beginPath();
    ctx.ellipse(0, -48, 15, 8, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(-15, -49, 30, 5);
    ctx.fillStyle = '#f2c44a';
    circ(0, -52, 3);
    ctx.fillStyle = '#fff';
    circ(-5, -39, 3.4);
    circ(5, -39, 3.4);
    ctx.fillStyle = '#111';
    circ(-4, -39, 1.5);
    circ(6, -39, 1.5);
    ctx.fillStyle = '#16233a'; // goatee and a grin
    ctx.beginPath();
    ctx.moveTo(-4, -28);
    ctx.lineTo(4, -28);
    ctx.lineTo(0, -21);
    ctx.fill();
    ctx.strokeStyle = '#16233a';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(0, -33, 5, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    ctx.restore();
  };
  const drawGenie = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#1b1038');
    g.addColorStop(1, '#0d0b22');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    for (let k = 0; k < 24; k++) { // faint stars
      ctx.fillStyle = `rgba(255,240,200,${0.25 + 0.2 * Math.sin(r / 300 + k)})`;
      circ(((k * 97) % 100) * 0.01 * W, ((k * 53) % 70) * 0.01 * H, 1.2);
    }
    const q = clamp1((r + T_INTRO) / (GEN_IN + T_INTRO - 100));
    const e = ease(q);
    const gx = gBottle.x + (gHome.x - gBottle.x) * e + Math.sin(r / 500) * 4;
    const gy = gBottle.neck + (gHome.y - gBottle.neck) * e + Math.sin(r / 380) * 5;
    const s = 0.35 + 0.65 * e;
    const tailTop = gy + 26 * s * gu;
    for (let j = 10; j >= 0; j--) { // smoke tail down into the bottle
      const p = j / 10;
      const x = gBottle.x + (gx - gBottle.x) * p + Math.sin(r / 150 + j * 0.9) * 9 * gu * p;
      const y = gBottle.neck + (tailTop - gBottle.neck) * p;
      ctx.fillStyle = `rgba(${90 + 60 * p},${160 + 50 * p},255,${0.85 - 0.25 * (1 - p)})`;
      circ(x, y, (5 + 16 * p * s) * gu);
    }
    ctx.fillStyle = 'rgba(160,220,235,.5)'; // the bottle
    ctx.strokeStyle = 'rgba(210,245,255,.8)';
    ctx.lineWidth = 2;
    const bx = gBottle.x;
    const by = H - 6 * gu;
    ctx.beginPath();
    ctx.moveTo(bx - 9 * gu, gBottle.neck);
    ctx.lineTo(bx - 9 * gu, by - 52 * gu);
    ctx.quadraticCurveTo(bx - 30 * gu, by - 46 * gu, bx - 30 * gu, by - 24 * gu);
    ctx.quadraticCurveTo(bx - 30 * gu, by, bx, by);
    ctx.quadraticCurveTo(bx + 30 * gu, by, bx + 30 * gu, by - 24 * gu);
    ctx.quadraticCurveTo(bx + 30 * gu, by - 46 * gu, bx + 9 * gu, by - 52 * gu);
    ctx.lineTo(bx + 9 * gu, gBottle.neck);
    ctx.stroke();
    ctx.fill();
    const cp = (r + T_INTRO - 100) / 450; // the cork pops out
    if (cp < 1) {
      const cy = cp < 0 ? gBottle.neck - 4 : gBottle.neck - 4 - 150 * cp + 120 * cp * cp * 0.3;
      ctx.save();
      ctx.translate(bx + (cp > 0 ? 30 * cp : 0), cy);
      ctx.rotate(cp * 6);
      ctx.fillStyle = '#c89050';
      ctx.fillRect(-7 * gu, -6 * gu, 14 * gu, 12 * gu);
      ctx.restore();
      if (cp > 0 && cp < 0.5) {
        ctx.strokeStyle = `rgba(255,240,180,${1 - cp * 2})`;
        ctx.lineWidth = 2;
        for (let j = 0; j < 8; j++) {
          const a = (j / 8) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(bx + Math.cos(a) * 12 * gu, gBottle.neck + Math.sin(a) * 12 * gu);
          ctx.lineTo(bx + Math.cos(a) * (22 + 30 * cp) * gu, gBottle.neck + Math.sin(a) * (22 + 30 * cp) * gu);
          ctx.stroke();
        }
      }
    }
    genieAt(gx, gy, s, r);
    const hand = { x: gx + 57 * s * gu, y: gy - 10 * s * gu };
    ctx.font = `${fs}px ${FONT}`;
    for (const c of visible) {
      const rr = r - GEN_IN - c.lock;
      if (rr < 0) continue;
      if (rr < GEN_FLY) {
        const p = rr / GEN_FLY;
        const cx = (hand.x + c.x) / 2;
        const cy = Math.min(hand.y, c.y) - 40 * gu;
        const a = (1 - p) * (1 - p);
        const b = 2 * p * (1 - p);
        const x = a * hand.x + b * cx + p * p * c.x;
        const y = a * hand.y + b * cy + p * p * c.y;
        ctx.fillStyle = `rgba(255,225,120,${0.7 * (1 - p)})`;
        for (let k = 1; k <= 3; k++) circ(x - k * 6 * (1 - p), y + k * 3, 2.6 - k * 0.5);
        textLit(c, '#fff0b0', 'rgba(255,215,90,.95)', 12, x, y, 0.5 + 0.5 * p);
        continue;
      }
      const p = clamp1((rr - GEN_FLY) / 500);
      textLit(c, '#fff6d8', 'rgba(255,215,100,.8)', 10 - 5 * p, c.x, c.y);
    }
    fadeToFinal(r);
  };

  // Minion fart gun: a minion fires green puffs at the words; each puff bursts into a cloud and the word appears in it.
  const FART_T = 380; // a puff's flight to its word
  const FART_CLOUD = 450; // how long the burst takes to clear
  const drawFartGun = (r: number) => {
    const gy = H - 12;
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#173b2d');
    bg.addColorStop(1, '#1b2b1f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    ctx.fillRect(0, gy + 2, W, H - gy);
    const mx = Math.min(W * 0.18, 110);
    let cur = -1;
    for (const x of wt) if (x.t0 <= r) cur = x.i;
    const aimW = cur < 0 ? wt[0] : wt[cur];
    const tx = aimW ? aimW.w.cx : W / 2;
    const ty = aimW ? aimW.w.cells[0].y - fs * 0.3 : H / 2;
    const dir = tx >= mx ? 1 : -1;
    const kick = cur < 0 ? 0 : Math.max(0, 1 - (r - wt[cur].t0) / 160);
    minion(mx - dir * kick * 4, gy, dir, 0, cur % 3 === 0 ? 1 : 2, 0.15, kick * 4);
    const hx = mx + dir * 14;
    const hy = gy - 26;
    const ang = Math.atan2(ty - hy, tx - hx);
    ctx.save();
    ctx.translate(hx - dir * kick * 4, hy);
    ctx.rotate(dir > 0 ? ang : ang - Math.PI);
    ctx.scale(dir, 1);
    ctx.fillStyle = '#3d6f4a'; // the gun: a chunky gas gun with a tank
    ctx.fillRect(-4, -5, 30, 9);
    ctx.fillStyle = '#9bd36b';
    circ(4, 8, 8);
    ctx.fillStyle = '#c8cfd4';
    ctx.fillRect(24, -6, 8, 11);
    ctx.restore();
    const muzzle = { x: hx + Math.cos(dir > 0 ? ang : ang - Math.PI) * 32 * dir, y: hy + Math.sin(dir > 0 ? ang : ang - Math.PI) * 32 * dir };
    ctx.font = `${fs}px ${FONT}`;
    for (const { w, i, t0 } of wt) {
      const rr = r - t0;
      if (rr < 0) continue;
      const wy = w.cells[0].y - fs * 0.3;
      if (rr < FART_T) {
        const p = rr / FART_T;
        const x = muzzle.x + (w.cx - muzzle.x) * p;
        const y = muzzle.y + (wy - muzzle.y) * p - Math.sin(p * Math.PI) * 14;
        ctx.fillStyle = 'rgba(150,210,80,.75)';
        circ(x, y, 5 + 6 * p);
        ctx.fillStyle = 'rgba(150,210,80,.35)';
        circ(x - (w.cx - muzzle.x) * 0.06, y, 4 + 4 * p);
        if (rr < 220) {
          ctx.font = `bold ${Math.round(fs * 0.9)}px ${FONT}`;
          ctx.fillStyle = `rgba(210,255,150,${1 - rr / 220})`;
          ctx.fillText('pfft!', muzzle.x + dir * 8, muzzle.y - 14 - rr / 20);
          ctx.font = `${fs}px ${FONT}`;
        }
        continue;
      }
      const e = rr - FART_T;
      const span = (w.x1 - w.x0) / 2 + 14;
      if (e < FART_CLOUD) {
        const q = e / FART_CLOUD;
        for (let k = 0; k < 7; k++) {
          const a = (k / 7) * Math.PI * 2 + i;
          ctx.fillStyle = `rgba(150,210,80,${0.55 * (1 - q)})`;
          circ(w.cx + Math.cos(a) * span * 0.6 * q, wy + Math.sin(a) * 14 * q - q * 6, (10 + 14 * q) * (0.7 + (k % 3) * 0.2));
        }
      }
      for (const c of w.cells) textLit(c, '#efffc4', 'rgba(150,230,90,.85)', 9 - 4 * clamp1(e / 500), c.x, c.y, clamp1(e / 200));
    }
    fadeToFinal(r);
  };

  // Red arrows: arrows whistle in from the sides and thunk in beside each word; the word jolts into view on impact.
  const AR_T = 420; // an arrow's flight
  const AR_STAY = 900; // how long it stays quivering before it fades
  const arAng = wt.map((x) => (x.i % 2 ? Math.PI - 0.2 - rnd() * 0.25 : 0.2 + rnd() * 0.25));
  const arrow = (px: number, py: number, a: number, alpha: number, wobble: number) => {
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(a + wobble);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#b8b8c0'; // shaft
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-52, 0);
    ctx.lineTo(-6, 0);
    ctx.stroke();
    ctx.fillStyle = '#e63232'; // head
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-13, -6);
    ctx.lineTo(-10, 0);
    ctx.lineTo(-13, 6);
    ctx.fill();
    ctx.fillStyle = '#c42020'; // fletching
    ctx.beginPath();
    ctx.moveTo(-52, 0);
    ctx.lineTo(-62, -7);
    ctx.lineTo(-44, 0);
    ctx.lineTo(-62, 7);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  };
  const drawArrows = (r: number) => {
    const g = ctx.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, W * 0.7);
    g.addColorStop(0, '#2a1216');
    g.addColorStop(1, `rgb(${BG})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(230,50,50,.07)'; // a faint target behind everything
    ctx.lineWidth = 6;
    for (let k = 1; k <= 3; k++) {
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, k * Math.min(W, H) * 0.16, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.font = `${fs}px ${FONT}`;
    for (const { w, i, t0 } of wt) {
      const rr = r - t0;
      if (rr < 0) continue;
      const a = arAng[i];
      const fromRight = i % 2 === 1;
      const p = { x: fromRight ? w.x1 + cw * 0.9 : w.x0 - cw * 0.9, y: w.cells[0].y - fs * 0.3 };
      if (rr < AR_T) {
        const q = rr / AR_T;
        const L = W * 0.75;
        const sx = p.x - Math.cos(a) * L;
        const sy = p.y - Math.sin(a) * L;
        const e = q * q;
        arrow(sx + (p.x - sx) * e, sy + (p.y - sy) * e, a, 1, 0);
        continue;
      }
      const e = rr - AR_T;
      const hit = clamp1(e / 150);
      const jolt = (1 - clamp1(e / 260)) * 3;
      for (const c of w.cells) textLit(c, '#ffe6e6', 'rgba(255,90,90,.85)', 9 - 4 * hit, c.x + (Math.random() - 0.5) * jolt, c.y + (Math.random() - 0.5) * jolt, hit);
      if (e < 300) { // impact ring
        ctx.strokeStyle = `rgba(255,110,110,${0.8 * (1 - e / 300)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6 + 26 * (e / 300), 0, Math.PI * 2);
        ctx.stroke();
      }
      if (e < AR_STAY + 300) arrow(p.x, p.y, a, e < AR_STAY ? 1 : 1 - (e - AR_STAY) / 300, Math.sin(e / 28) * 0.09 * (1 - clamp1(e / 400)));
    }
    fadeToFinal(r);
  };

  // Word tiles: letters are wooden tiles that fly in from a rack and land on a board, each with its score.
  const TILE_T = 450; // a tile's flight from the rack
  const TILE_SETTLE = 250; // its bounce on landing
  const tw = cw * 0.96;
  const th = fs * 1.15;
  const tilePts = (ch: string) => {
    const u = ch.toUpperCase();
    return 'AEIOULNSTR'.includes(u) ? 1 : 'DG'.includes(u) ? 2 : 'BCMP'.includes(u) ? 3 : 'FHVWY'.includes(u) ? 4 : u === 'K' ? 5 : 'JX'.includes(u) ? 8 : 'QZ'.includes(u) ? 10 : 0;
  };
  const tileAt = (cx: number, cy: number, ch: string, rot: number, lift: number, alpha = 1) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.shadowColor = 'rgba(0,0,0,.5)';
    ctx.shadowBlur = 3 + lift * 10;
    ctx.shadowOffsetY = 2 + lift * 8;
    ctx.fillStyle = '#f0d9a4';
    ctx.fillRect(-tw / 2, -th / 2, tw, th);
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = '#c4a063';
    ctx.lineWidth = 1;
    ctx.strokeRect(-tw / 2 + 0.5, -th / 2 + 0.5, tw - 1, th - 1);
    ctx.fillStyle = '#3a2a12';
    ctx.font = `bold ${Math.round(fs * 0.85)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch.toUpperCase(), 0, -fs * 0.04);
    const pts = tilePts(ch);
    if (pts) {
      ctx.font = `${Math.max(6, Math.round(fs * 0.3))}px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillText(String(pts), tw / 2 - 1, th / 2 - fs * 0.2);
    }
    ctx.restore();
  };
  const rackSlots = 7;
  const rackX = (k: number) => W / 2 + (k - (rackSlots - 1) / 2) * (tw + 6);
  const rackY = H - th / 2 - 10;
  const tileStart = visible.map(() => ({ k: Math.floor(rnd() * rackSlots), rot: (rnd() - 0.5) * 1.2 }));
  const drawTiles = (r: number) => {
    ctx.fillStyle = '#1d4b36';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,.07)'; // the board's grid, with a few premium squares
    ctx.lineWidth = 1;
    const gx = tw + 1;
    const gyy = th + 1;
    for (let x = (W / 2) % gx; x < W; x += gx) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let y = (H / 2) % gyy; y < H; y += gyy) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    const prem = ['rgba(200,60,60,.22)', 'rgba(240,150,170,.2)', 'rgba(90,150,220,.2)'];
    for (let n = 0; n < 24; n++) {
      const px = Math.floor(((n * 37) % 97) / 97 * (W / gx)) * gx + ((W / 2) % gx);
      const py = Math.floor(((n * 61) % 89) / 89 * (H / gyy)) * gyy + ((H / 2) % gyy);
      ctx.fillStyle = prem[n % 3];
      ctx.fillRect(px - gx, py - gyy, gx, gyy);
    }
    ctx.fillStyle = '#7a5230'; // the rack, still holding a few tiles
    ctx.fillRect(rackX(0) - tw, rackY - th / 2 - 6, rackX(rackSlots - 1) - rackX(0) + tw * 2, th + 12);
    ctx.fillStyle = '#5c3a1e';
    ctx.fillRect(rackX(0) - tw, rackY + th / 2 + 2, rackX(rackSlots - 1) - rackX(0) + tw * 2, 4);
    'SECRET!'.split('').forEach((ch, k) => tileAt(rackX(k), rackY, ch, 0, 0));
    const landed: Cell[] = [];
    const flying: { c: Cell; i: number; q: number }[] = [];
    visible.forEach((c, i) => {
      const rr = r - c.lock;
      if (rr < 0) return;
      if (rr < TILE_T) flying.push({ c, i, q: rr / TILE_T });
      else landed.push(c);
    });
    for (const c of landed) {
      const e = r - c.lock - TILE_T;
      const bounce = e < TILE_SETTLE ? Math.sin((e / TILE_SETTLE) * Math.PI) * -4 * (1 - e / TILE_SETTLE) : 0;
      tileAt(c.x + cw / 2, c.y - fs * 0.4 + bounce, c.ch, 0, e < TILE_SETTLE ? 0.5 * (1 - e / TILE_SETTLE) : 0);
    }
    for (const f of flying) {
      const s = tileStart[f.i];
      const sx = rackX(s.k);
      const ex = f.c.x + cw / 2;
      const ey = f.c.y - fs * 0.4;
      const q = ease(f.q);
      const x = sx + (ex - sx) * q;
      const y = rackY + (ey - rackY) * q - Math.sin(f.q * Math.PI) * 40;
      tileAt(x, y, f.c.ch, s.rot * (1 - q), Math.sin(f.q * Math.PI));
    }
    fadeToFinal(r);
  };

  // Witches: each word is cast into place by a witch swooping in on her broomstick; she flicks her wand and flies on.
  const WITCH_IN = 700; // the swoop in, to the spot over her word
  const WITCH_OUT = 400; // and the dash off again after the spell
  const witchStart = wt.map(() => 12 + rnd() * H * 0.3);
  const witchBy = (x: number, y: number, dir: number, tilt: number, sz: number, r: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir * sz, sz);
    ctx.rotate(tilt);
    ctx.strokeStyle = '#6b4423'; // the broom
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-32, 6);
    ctx.lineTo(32, 0);
    ctx.stroke();
    ctx.strokeStyle = '#b8863c';
    ctx.lineWidth = 1.6;
    for (let j = -3; j <= 3; j++) {
      ctx.beginPath();
      ctx.moveTo(-32, 6);
      ctx.lineTo(-52, 6 + j * 3 + Math.sin(r / 60 + j) * 1.5);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(20,12,30,.9)'; // flowing cloak
    ctx.beginPath();
    ctx.moveTo(-6, -24);
    ctx.lineTo(-30, -12 + Math.sin(r / 70) * 3);
    ctx.lineTo(-6, -4);
    ctx.fill();
    ctx.fillStyle = '#17101f'; // body and dangling legs
    ctx.beginPath();
    ctx.ellipse(0, -14, 9, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#17101f';
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    ctx.moveTo(2, -4);
    ctx.lineTo(7, 9);
    ctx.moveTo(-2, -4);
    ctx.lineTo(1, 10);
    ctx.stroke();
    ctx.strokeStyle = '#e8892a'; // hair streaming behind
    ctx.lineWidth = 2;
    for (let j = 0; j < 3; j++) {
      ctx.beginPath();
      ctx.moveTo(2, -30 + j * 2);
      ctx.lineTo(-10, -26 + j * 4 + Math.sin(r / 80 + j) * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#7fc46a'; // face
    circ(7, -30, 6);
    ctx.fillStyle = '#111';
    circ(9.5, -31, 1);
    ctx.fillStyle = '#17101f'; // hat
    ctx.beginPath();
    ctx.ellipse(7, -34, 12, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -34);
    ctx.quadraticCurveTo(6, -46, 2, -58);
    ctx.lineTo(14, -34);
    ctx.fill();
    ctx.strokeStyle = '#17101f'; // arm and wand
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(8, -18);
    ctx.lineTo(24, -26);
    ctx.stroke();
    ctx.strokeStyle = '#e8d8ff';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(24, -26);
    ctx.lineTo(32, -31);
    ctx.stroke();
    ctx.restore();
  };
  const drawWitches = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#1b0e33');
    g.addColorStop(1, '#2d1346');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,170,60,.92)'; // a big harvest moon
    circ(W * 0.82, H * 0.22, Math.min(W, H) * 0.12);
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    for (let k = 0; k < 28; k++) circ(((k * 83) % 100) * 0.01 * W, ((k * 47) % 80) * 0.01 * H, 0.9);
    ctx.fillStyle = '#0d0716'; // bats
    for (let k = 0; k < 4; k++) {
      const bx = (((k * 0.27 + r * 0.00006 * (k + 1)) % 1.2) - 0.1) * W;
      const by = H * (0.12 + 0.18 * k) + Math.sin(r / 200 + k) * 8;
      const fl = Math.sin(r / 70 + k * 2) * 5;
      ctx.beginPath();
      ctx.moveTo(bx - 9, by - fl);
      ctx.quadraticCurveTo(bx - 3, by - 4, bx, by);
      ctx.quadraticCurveTo(bx + 3, by - 4, bx + 9, by - fl);
      ctx.quadraticCurveTo(bx + 3, by + 2, bx, by + 3);
      ctx.quadraticCurveTo(bx - 3, by + 2, bx - 9, by - fl);
      ctx.fill();
    }
    const sz = Math.min(1.3, Math.max(0.8, fs / 16));
    ctx.font = `${fs}px ${FONT}`;
    for (const { w, i, t0 } of wt) {
      const rr = r - t0;
      if (rr < 0) continue;
      const dir = i % 2 ? -1 : 1;
      const px = w.cx;
      const py = Math.max(30, w.cells[0].y - fs * 1.7);
      const sx = dir > 0 ? -60 : W + 60;
      const ex = dir > 0 ? W + 60 : -60;
      if (rr < WITCH_IN + WITCH_OUT) {
        let x: number;
        let y: number;
        if (rr < WITCH_IN) {
          const q = rr / WITCH_IN;
          const e = 1 - Math.pow(1 - q, 2);
          x = sx + (px - sx) * e;
          y = witchStart[i] + (py - witchStart[i]) * e + Math.sin(q * 5) * 10 * (1 - q);
        } else {
          const q = (rr - WITCH_IN) / WITCH_OUT;
          x = px + (ex - px) * q * q;
          y = py - 60 * q * q;
        }
        for (let k = 1; k <= 6; k++) { // glittering trail
          ctx.fillStyle = `hsla(${(i * 40 + k * 30) % 360},90%,70%,${0.5 - k * 0.07})`;
          circ(x - dir * (34 + k * 8) * sz, y + 6 + Math.sin(r / 90 + k) * 3, 2.4);
        }
        witchBy(x, y, dir, dir * Math.sin(r / 150 + i) * 0.06 + (rr >= WITCH_IN ? -0.25 : 0), sz, r);
      }
      if (rr >= WITCH_IN) {
        const e = rr - WITCH_IN;
        if (e < 400) { // the spell's burst
          for (let k = 0; k < 10; k++) {
            const a = (k / 10) * Math.PI * 2 + i;
            ctx.fillStyle = `hsla(${(k * 36 + i * 30) % 360},95%,72%,${1 - e / 400})`;
            circ(px + Math.cos(a) * (10 + e * 0.12) * (w.x1 - w.x0) / 90 * 2, py + fs * 1.2 + Math.sin(a) * (6 + e * 0.05), 2.6 * (1 - e / 400) + 0.6);
          }
        }
        for (const c of w.cells) textLit(c, '#ead4ff', 'rgba(190,120,255,.9)', 10 - 4 * clamp1(e / 500), c.x, c.y, clamp1(e / 250));
      }
    }
    fadeToFinal(r);
  };

  // Red Arrows: a formation of red display jets sweeps along each line trailing red, white and blue smoke that
  // writes the words, then the team breaks in a bomb burst.
  const RA_FORM = [[0, 0, 0], [-16, -13, 1], [-16, 13, 2], [-32, -26, 1], [-32, 26, 2]]; // offset back, offset sideways, smoke colour
  const RA_COL = ['230,50,50', '244,244,255', '58,98,216'];
  const raEnd = (lineYs.length - 1) * RA_GAP + RA_LT + 150; // the last pass is done; the burst starts
  const raX = (k: number, f: number) => {
    const ln = pnkSpan[k];
    const run = ln.x1 - ln.x0;
    return k % 2 ? ln.x1 + 60 - f * (run + 120) : ln.x0 - 60 + f * (run + 120);
  };
  const raJet = (x: number, y: number, ang: number, sz: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.scale(sz, sz);
    ctx.fillStyle = '#d92b2b';
    ctx.beginPath();
    ctx.moveTo(-6, 0);
    ctx.lineTo(-12, -13);
    ctx.lineTo(-15, -13);
    ctx.lineTo(-11, 0);
    ctx.lineTo(-15, 13);
    ctx.lineTo(-12, 13);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath(); // tail planes
    ctx.moveTo(-18, 0);
    ctx.lineTo(-24, -6);
    ctx.lineTo(-24, 6);
    ctx.fill();
    ctx.beginPath(); // fuselage
    ctx.ellipse(0, 0, 15, 3.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f4f4ff';
    ctx.fillRect(-4, -1, 8, 2);
    ctx.fillStyle = '#3a62d8';
    ctx.fillRect(-14, -13, 2.4, 3);
    ctx.fillRect(-14, 10, 2.4, 3);
    ctx.fillStyle = '#9fd0ff';
    ctx.beginPath();
    ctx.ellipse(6, 0, 3.6, 1.7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
  const drawRedArrows = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#5aa2e8');
    g.addColorStop(1, '#bfe0f6');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.55)'; // a few clouds
    for (const [cx2, cy2, cr] of [[0.15, 0.2, 26], [0.6, 0.12, 32], [0.85, 0.7, 24], [0.3, 0.8, 30]]) {
      circ(W * cx2, H * cy2, cr);
      circ(W * cx2 + cr * 0.9, H * cy2 + 4, cr * 0.75);
      circ(W * cx2 - cr * 0.9, H * cy2 + 6, cr * 0.7);
    }
    const sz = Math.min(1.2, Math.max(0.7, fs / 18));
    pnkSpan.forEach((ln, k) => {
      const rb = r - k * RA_GAP;
      if (rb < -30 || rb > RA_LT + 30) return;
      const dir = k % 2 ? -1 : 1;
      const fr = rb / RA_LT;
      const ly = ln.y - fs * 0.3;
      for (const [ox, oy, ci] of RA_FORM) {
        for (let t = 14; t >= 1; t--) { // smoke trail
          ctx.fillStyle = `rgba(${RA_COL[ci]},${0.55 - t * 0.035})`;
          circ(raX(k, fr - t * 0.025) + ox * dir * sz, ly + oy * sz, (2 + t * 0.45) * sz);
        }
      }
      for (const [ox, oy] of RA_FORM) raJet(raX(k, fr) + ox * dir * sz, ly + oy * sz, dir > 0 ? 0 : Math.PI, sz);
    });
    ctx.font = `${fs}px ${FONT}`;
    for (const c of visible) {
      const k = lineYs.indexOf(c.y);
      const rb = r - k * RA_GAP;
      if (rb < 0) continue;
      const dir = k % 2 ? -1 : 1;
      const dist = dir * (raX(k, rb / RA_LT) - c.x);
      if (dist < 0) continue;
      const p = clamp1(dist / (fs * 3));
      textLit(c, `rgb(255,${Math.round(150 + 105 * p)},${Math.round(150 + 105 * p)})`, 'rgba(210,40,40,.85)', 9 - 4 * p, c.x, c.y, clamp1(dist / (fs * 1.2)));
    }
    const bb = r - raEnd; // the bomb burst
    if (bb > -60 && bb < 1500) {
      const q = Math.max(0, bb) / 1500;
      const sx = W / 2;
      const sy = H * 0.92;
      for (let j = 0; j < 7; j++) {
        const a = -Math.PI / 2 + (j - 3) * 0.4;
        const at = (qq: number) => ({ x: sx + Math.cos(a) * H * 1.15 * ease(qq), y: sy + Math.sin(a) * H * 1.15 * ease(qq) });
        for (let t = 16; t >= 1; t--) {
          const tp = at(q - t * 0.03);
          ctx.fillStyle = `rgba(${RA_COL[j % 3]},${0.55 - t * 0.03})`;
          circ(tp.x, tp.y, (2 + t * 0.4) * sz);
        }
        const p = at(q);
        raJet(p.x, p.y, a, sz);
      }
      if (bb < 200 && bb > 0) {
        ctx.fillStyle = `rgba(255,255,255,${0.8 * (1 - bb / 200)})`;
        circ(sx, sy, 14 + bb * 0.2);
      }
    }
    fadeToFinal(r);
  };

  // Skeleton pirate ship: a ghostly galleon rocks on a dark sea and its skeleton gunner shoots each word into place.
  const PIR_T = 400; // a cannonball's flight
  const PIR_CLOUD = 450; // the burst of ghost-smoke
  const drawPirate = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0b1a26');
    g.addColorStop(1, '#0f2a32');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(230,240,220,.85)'; // moon
    circ(W * 0.86, H * 0.16, Math.min(W, H) * 0.07);
    const su = Math.min(1.25, Math.max(0.6, H / 300));
    const shipX = Math.min(W * 0.2, 130) + clamp1(r / T_RES) * 30;
    const wave = (a: number, ph: number) => Math.sin(r / 700 + ph) * a;
    const sy = H - 36 * su + wave(3, 0);
    const tilt = wave(0.03, 1);
    ctx.fillStyle = 'rgba(80,255,170,.08)'; // eerie glow around the ship
    circ(shipX, sy - 60 * su, 90 * su);
    ctx.save();
    ctx.translate(shipX, sy);
    ctx.rotate(tilt);
    ctx.scale(su, su);
    ctx.fillStyle = '#2a1c14'; // hull
    ctx.beginPath();
    ctx.moveTo(-70, -22);
    ctx.lineTo(74, -26);
    ctx.quadraticCurveTo(66, 0, 40, 6);
    ctx.lineTo(-52, 6);
    ctx.quadraticCurveTo(-72, -4, -70, -22);
    ctx.fill();
    ctx.strokeStyle = '#d8d2b8'; // exposed ribs
    ctx.lineWidth = 2;
    for (let j = -3; j <= 3; j++) {
      ctx.beginPath();
      ctx.moveTo(j * 18 + 4, -22);
      ctx.quadraticCurveTo(j * 18 + 12, -10, j * 18 + 2, 5);
      ctx.stroke();
    }
    ctx.strokeStyle = '#3a2a1e'; // mast and crow's nest
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(4, -22);
    ctx.lineTo(4, -128);
    ctx.stroke();
    ctx.fillStyle = '#3a2a1e';
    ctx.fillRect(-4, -134, 16, 7);
    ctx.fillStyle = '#7d8a8c'; // tattered sail with a skull
    ctx.beginPath();
    ctx.moveTo(-34, -118);
    ctx.lineTo(44, -118);
    ctx.lineTo(40, -62);
    for (let j = 0; j < 6; j++) ctx.lineTo(40 - (j + 1) * 12.5, -62 + (j % 2 ? 0 : 9) + Math.sin(r / 200 + j) * 1.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#f0ecda';
    circ(5, -94, 8);
    ctx.fillRect(1, -88, 8, 5);
    ctx.fillStyle = '#7d8a8c';
    circ(2, -95, 2);
    circ(8, -95, 2);
    ctx.strokeStyle = '#f0ecda';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(-8, -80);
    ctx.lineTo(18, -68);
    ctx.moveTo(18, -80);
    ctx.lineTo(-8, -68);
    ctx.stroke();
    ctx.fillStyle = '#f0ecda'; // the skeleton gunner at the stern
    circ(-48, -42, 6);
    ctx.fillStyle = '#16120e';
    ctx.beginPath();
    ctx.moveTo(-56, -45);
    ctx.lineTo(-48, -56);
    ctx.lineTo(-40, -45);
    ctx.fill();
    ctx.strokeStyle = '#f0ecda';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(-48, -36);
    ctx.lineTo(-48, -24);
    for (let j = 0; j < 3; j++) {
      ctx.moveTo(-55, -34 + j * 4);
      ctx.lineTo(-41, -34 + j * 4);
    }
    ctx.moveTo(-48, -32);
    ctx.lineTo(-30, -34);
    ctx.stroke();
    ctx.restore();
    const pivot = { x: shipX + 44 * su, y: sy - 30 * su };
    let cur = -1;
    for (const x of wt) if (x.t0 <= r) cur = x.i;
    const aimW = cur < 0 ? wt[0] : wt[cur];
    const tx = aimW ? aimW.w.cx : W / 2;
    const ty = aimW ? aimW.w.cells[0].y - fs * 0.3 : H / 2;
    const ang = Math.atan2(ty - pivot.y, tx - pivot.x);
    const recoil = cur < 0 ? 0 : Math.max(0, 1 - (r - wt[cur].t0) / 180);
    ctx.save();
    ctx.translate(pivot.x - Math.cos(ang) * recoil * 6, pivot.y - Math.sin(ang) * recoil * 6);
    ctx.rotate(ang);
    ctx.fillStyle = '#23272b';
    ctx.fillRect(-6, -5, 30 * su, 10);
    ctx.fillStyle = '#3b4248';
    ctx.fillRect(22 * su, -6.5, 6, 13);
    ctx.restore();
    const muzzle = { x: pivot.x + Math.cos(ang) * 30 * su, y: pivot.y + Math.sin(ang) * 30 * su };
    ctx.fillStyle = 'rgba(8,30,40,.9)'; // dark sea in front of the hull
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 12) ctx.lineTo(x, sy + 8 * su + Math.sin(x / 26 + r / 400) * 3.5);
    ctx.lineTo(W, H);
    ctx.fill();
    ctx.font = `${fs}px ${FONT}`;
    for (const { w, i, t0 } of wt) {
      const rr = r - t0;
      if (rr < 0) continue;
      const wy = w.cells[0].y - fs * 0.3;
      if (rr < PIR_T) {
        const p = rr / PIR_T;
        ctx.fillStyle = '#1b1e22';
        circ(muzzle.x + (w.cx - muzzle.x) * p, muzzle.y + (wy - muzzle.y) * p - Math.sin(p * Math.PI) * 16, 5);
        if (rr < 200) {
          ctx.fillStyle = `rgba(200,210,200,${0.6 * (1 - rr / 200)})`;
          circ(muzzle.x + Math.cos(ang) * 6, muzzle.y + Math.sin(ang) * 6 - rr * 0.04, 8 + rr * 0.06);
        }
        continue;
      }
      const e = rr - PIR_T;
      if (e < PIR_CLOUD) {
        const q = e / PIR_CLOUD;
        ctx.fillStyle = `rgba(120,255,180,${0.5 * (1 - q)})`;
        circ(w.cx, wy, 12 + 40 * q);
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + i;
          ctx.fillStyle = `rgba(190,200,195,${0.5 * (1 - q)})`;
          circ(w.cx + Math.cos(a) * (w.x1 - w.x0) * 0.3 * q, wy + Math.sin(a) * 12 * q - q * 8, 10 + 12 * q);
        }
      }
      for (const c of w.cells) textLit(c, '#f4f1e0', 'rgba(120,255,170,.85)', 9 - 4 * clamp1(e / 500), c.x, c.y, clamp1(e / 220));
    }
    fadeToFinal(r);
  };

  // Creepy fog: a thick mist drifts and eddies, and the words slowly come out of it, a few letters at a time.
  const FOG_FADE = 1600; // how long a letter takes to emerge from the mist
  const gwFog = Array.from({ length: 16 }, () => ({ x: rnd() * W, y: rnd() * H, rad: Math.max(W, H) * (0.18 + rnd() * 0.2), sp: 0.01 + rnd() * 0.02, ph: rnd() * 6 }));
  const drawFogWriter = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0e161b');
    g.addColorStop(1, '#17262a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.font = `${fs}px ${FONT}`;
    for (const c of visible) {
      const rr = r - c.lock;
      if (rr < 0) continue;
      const q = clamp1(rr / FOG_FADE);
      const a = ease(q) * (0.88 + 0.12 * Math.sin(r / 140 + c.x));
      textLit(c, '#dcfff2', 'rgba(130,255,200,.85)', 14 - 9 * q, c.x + Math.sin(r / 300 + c.x) * (1 - q) * 2, c.y + (1 - q) * 5, a);
    }
    for (const f of gwFog) { // the drifting mist, over the words
      const x = f.x + Math.sin(r * f.sp * 0.1 + f.ph) * W * 0.12;
      const y = f.y + Math.cos(r * f.sp * 0.08 + f.ph) * H * 0.08;
      const fg = ctx.createRadialGradient(x, y, 0, x, y, f.rad);
      fg.addColorStop(0, 'rgba(185,205,205,.2)');
      fg.addColorStop(1, 'rgba(185,205,205,0)');
      ctx.fillStyle = fg;
      ctx.fillRect(0, 0, W, H);
    }
    for (const c of visible) { // a wisp of fog clinging to each letter until it has surfaced
      const rr = r - c.lock;
      if (rr < 0 || rr > FOG_FADE) continue;
      const q = rr / FOG_FADE;
      const wg = ctx.createRadialGradient(c.x + cw / 2, c.y - fs * 0.3, 0, c.x + cw / 2, c.y - fs * 0.3, fs * 1.4);
      wg.addColorStop(0, `rgba(190,210,210,${0.3 * (1 - q)})`);
      wg.addColorStop(1, 'rgba(190,210,210,0)');
      ctx.fillStyle = wg;
      ctx.fillRect(c.x - fs * 1.2, c.y - fs * 1.7, fs * 2.8, fs * 2.8);
    }
    fadeToFinal(r);
  };

  // Underwater: shared backdrop of light rays, drifting bubbles and a sandy floor.
  const seaBubbles = Array.from({ length: 28 }, () => ({ x: rnd() * W, y: rnd() * H, s: 1 + rnd() * 3, v: 0.02 + rnd() * 0.05, ph: rnd() * 6 }));
  const drawSea = (r: number, top: string, bottom: string) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(190,240,255,.05)'; // sun rays
    for (let k = 0; k < 5; k++) {
      const x = W * (0.1 + 0.2 * k) + Math.sin(r / 1500 + k) * 20;
      ctx.beginPath();
      ctx.moveTo(x - 14, 0);
      ctx.lineTo(x + 14, 0);
      ctx.lineTo(x + 70, H);
      ctx.lineTo(x - 40, H);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(200,240,255,.35)';
    for (const b of seaBubbles) circ(b.x + Math.sin(r / 500 + b.ph) * 6, (((b.y - r * b.v) % H) + H) % H, b.s);
    ctx.fillStyle = 'rgba(60,70,50,.55)';
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 20) ctx.lineTo(x, H - 8 - Math.sin(x / 40) * 4);
    ctx.lineTo(W, H);
    ctx.fill();
  };
  const bubbleLetter = (c: Cell, x: number, y: number, a: number) => {
    ctx.strokeStyle = `rgba(210,245,255,${0.75 * a})`;
    ctx.fillStyle = `rgba(150,220,255,${0.18 * a})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(x, y, fs * 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    textLit(c, '#eefcff', 'rgba(120,220,255,.9)', 8, x - cw / 2, y + fs * 0.3, a);
  };

  // Whale: a blue whale lies at the surface and blows each letter up out of its blowhole in a jet of water; the
  // letters arc through the air and splash down into place.
  const WHALE_T = 750; // a letter's flight from the blowhole to its place
  const wu = Math.min(1.2, Math.max(0.6, H / 300));
  const drawWhale = (r: number) => {
    const wl = H - 64 * wu; // the waterline
    const sky = ctx.createLinearGradient(0, 0, 0, wl);
    sky.addColorStop(0, '#243a5e');
    sky.addColorStop(1, '#d98a6a');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, wl + 2);
    ctx.fillStyle = 'rgba(255,230,190,.9)';
    circ(W * 0.84, wl - 20 * wu, 18 * wu);
    const bob = Math.sin(r / 700) * 3;
    const wx = Math.min(W * 0.2, 150) + Math.sin(r / 1800) * 6;
    const wy = wl + 8 * wu + bob;
    const blow = { x: wx + 62 * wu, y: wy - 47 * wu };
    ctx.save();
    ctx.translate(wx, wy);
    ctx.scale(wu, wu);
    const fl = Math.sin(r / 380) * 6;
    const body = () => {
      ctx.beginPath();
      ctx.moveTo(-90, -6);
      ctx.bezierCurveTo(-60, -50, 40, -56, 100, -34);
      ctx.bezierCurveTo(124, -24, 124, -4, 104, 8);
      ctx.bezierCurveTo(60, 34, -50, 30, -90, -6);
      ctx.closePath();
    };
    ctx.fillStyle = '#3a5f80'; // tail stock and fluke
    ctx.beginPath();
    ctx.moveTo(-84, -10);
    ctx.quadraticCurveTo(-120, -14 + fl * 0.4, -140, -22 + fl);
    ctx.lineTo(-158, -40 + fl);
    ctx.quadraticCurveTo(-146, -18 + fl, -148, -6 + fl);
    ctx.quadraticCurveTo(-158, 14 + fl, -140, 10 + fl);
    ctx.quadraticCurveTo(-116, 0 + fl * 0.4, -80, 4);
    ctx.fill();
    body();
    ctx.fill();
    ctx.save();
    body();
    ctx.clip();
    ctx.fillStyle = '#a8c4d6'; // pale belly
    ctx.beginPath();
    ctx.ellipse(10, 20, 100, 16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#fff';
    circ(86, -8, 3.6);
    ctx.fillStyle = '#10202c';
    circ(87, -8, 1.8);
    ctx.strokeStyle = 'rgba(16,32,44,.6)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(118, -2);
    ctx.quadraticCurveTo(90, 8, 56, 2);
    ctx.stroke();
    ctx.fillStyle = '#10202c'; // blowhole
    ctx.beginPath();
    ctx.ellipse(62, -47, 4.5, 1.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    const sea = ctx.createLinearGradient(0, wl, 0, H); // the sea over the lower part of the whale
    sea.addColorStop(0, 'rgba(26,100,140,.86)');
    sea.addColorStop(1, 'rgba(8,40,66,.97)');
    ctx.fillStyle = sea;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 10) ctx.lineTo(x, wl + Math.sin(x / 24 + r / 300) * 2.5 + Math.sin(x / 61 - r / 450) * 2);
    ctx.lineTo(W, H);
    ctx.fill();
    ctx.strokeStyle = 'rgba(200,235,245,.4)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 10) {
      const y = wl + Math.sin(x / 24 + r / 300) * 2.5 + Math.sin(x / 61 - r / 450) * 2;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    const first = Math.min(...visible.map((c) => c.lock));
    const last = Math.max(...visible.map((c) => c.lock));
    if (r > first - 120 && r < last + WHALE_T * 0.35) { // the jet of water
      const top = Math.min(H * 0.4, blow.y - 12);
      for (let j = 0; j < 26; j++) {
        const p = j / 25;
        const x = blow.x + Math.sin(j * 2.3 + r / 60) * 7 * p + p * p * 14;
        const y = blow.y - top * p;
        ctx.fillStyle = `rgba(225,243,255,${0.75 - 0.5 * p})`;
        circ(x, y, 1.8 + 3.2 * (1 - p * 0.6));
      }
      for (let j = 0; j < 10; j++) { // spray falling back
        const ph = ((r / 500 + j * 0.37) % 1);
        ctx.fillStyle = `rgba(225,243,255,${0.55 * (1 - ph)})`;
        circ(blow.x + (j % 2 ? 1 : -1) * (6 + ph * 26) * (0.4 + (j % 5) * 0.15), blow.y - top * 0.85 + ph * ph * top * 0.9, 1.8);
      }
    }
    ctx.font = `${fs}px ${FONT}`;
    for (const c of visible) {
      const rr = r - c.lock;
      if (rr < 0) continue;
      const ex = c.x + cw / 2;
      const ey = c.y - fs * 0.3;
      if (rr < WHALE_T) {
        const q = rr / WHALE_T;
        const cx = (blow.x + ex) / 2;
        const cy = Math.min(blow.y, ey) - H * 0.42;
        const pos = (p: number) => ({ x: (1 - p) * (1 - p) * blow.x + 2 * p * (1 - p) * cx + p * p * ex, y: (1 - p) * (1 - p) * blow.y + 2 * p * (1 - p) * cy + p * p * ey });
        for (let k = 3; k >= 1; k--) { // droplets shaken off behind it
          const tp = pos(Math.max(0, q - k * 0.05));
          ctx.fillStyle = `rgba(225,243,255,${0.5 - k * 0.12})`;
          circ(tp.x + Math.sin(k * 3) * 3, tp.y, 2.4);
        }
        const p = pos(q);
        ctx.fillStyle = 'rgba(190,230,255,.3)';
        circ(p.x, p.y, fs * 0.7);
        textLit(c, '#f2fbff', 'rgba(150,215,255,.95)', 9, p.x - cw / 2, p.y + fs * 0.3, 1);
        continue;
      }
      const e = rr - WHALE_T;
      if (e < 320) { // splash
        ctx.strokeStyle = `rgba(225,245,255,${0.8 * (1 - e / 320)})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(ex, ey, 5 + fs * 0.9 * (e / 320), 0, Math.PI * 2);
        ctx.stroke();
        for (let k = 0; k < 5; k++) {
          ctx.fillStyle = `rgba(225,245,255,${0.7 * (1 - e / 320)})`;
          circ(ex + (k - 2) * 5 * (e / 320 + 0.3), ey - Math.sin((e / 320) * Math.PI) * (8 + k * 2), 1.7);
        }
      }
      textLit(c, '#eefcff', 'rgba(120,220,255,.85)', 8 - 3 * clamp1(e / 400), c.x, c.y, clamp1(e / 120));
    }
    fadeToFinal(r);
  };

  // Submarine: a sub cruises below the words and fires torpedoes at them; each bursts into bubbles and a sonar
  // ring that leaves the word behind.
  const TORP_T = 450; // a torpedo's run
  const TORP_BURST = 450; // the burst
  const su2 = Math.min(1.2, Math.max(0.6, H / 300));
  const drawSubmarine = (r: number) => {
    drawSea(r, '#0f4f66', '#06202c');
    const sx = Math.min(W * 0.2, 120);
    const sy = H - 56 * su2 + Math.sin(r / 650) * 4;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(Math.sin(r / 900) * 0.02);
    ctx.scale(su2, su2);
    ctx.fillStyle = '#4a5f6c'; // tail fin and conning tower
    ctx.beginPath();
    ctx.moveTo(-66, -8);
    ctx.lineTo(-84, -30);
    ctx.lineTo(-52, -14);
    ctx.fill();
    ctx.fillRect(-12, -42, 32, 22);
    ctx.fillStyle = '#6f8796';
    ctx.fillRect(4, -62, 3.5, 20); // periscope
    ctx.fillRect(4, -62, 14, 3.5);
    const hull = ctx.createLinearGradient(0, -24, 0, 24);
    hull.addColorStop(0, '#9fb7c4');
    hull.addColorStop(1, '#566c79');
    ctx.fillStyle = hull;
    ctx.beginPath();
    ctx.ellipse(0, 0, 76, 24, 0, 0, Math.PI * 2);
    ctx.fill();
    for (let k = 0; k < 3; k++) { // lit portholes
      ctx.fillStyle = '#ffd86a';
      circ(-30 + k * 22, -2, 5.5);
      ctx.strokeStyle = '#3a4a54';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(-30 + k * 22, -2, 5.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.save(); // spinning propeller
    ctx.translate(-80, 0);
    ctx.scale(1, Math.abs(Math.sin(r / 40)) * 0.9 + 0.1);
    ctx.fillStyle = '#3a4a54';
    ctx.fillRect(-2, -14, 4, 28);
    ctx.restore();
    ctx.restore();
    const bow = { x: sx + 76 * su2, y: sy };
    ctx.font = `${fs}px ${FONT}`;
    for (const { w, i, t0 } of wt) {
      const rr = r - t0;
      if (rr < 0) continue;
      const tx = w.cx;
      const ty = w.cells[0].y - fs * 0.3;
      if (rr < TORP_T) {
        const q = rr / TORP_T;
        const e = q * q;
        const x = bow.x + (tx - bow.x) * e;
        const y = bow.y + (ty - bow.y) * e;
        const a = Math.atan2(ty - bow.y, tx - bow.x);
        for (let k = 1; k <= 7; k++) { // bubble trail
          const tq = Math.max(0, q - k * 0.05);
          ctx.fillStyle = `rgba(210,245,255,${0.5 - k * 0.06})`;
          circ(bow.x + (tx - bow.x) * tq * tq, bow.y + (ty - bow.y) * tq * tq + Math.sin(k + r / 60) * 2, 2.8 - k * 0.2);
        }
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        ctx.fillStyle = '#c9d4da';
        ctx.fillRect(-9, -2.6, 18, 5.2);
        ctx.fillStyle = '#d24a3a';
        ctx.beginPath();
        ctx.moveTo(9, -2.6);
        ctx.lineTo(14, 0);
        ctx.lineTo(9, 2.6);
        ctx.fill();
        ctx.restore();
        continue;
      }
      const e = rr - TORP_T;
      if (e < TORP_BURST) {
        const q = e / TORP_BURST;
        ctx.strokeStyle = `rgba(120,255,200,${0.8 * (1 - q)})`; // sonar ring
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(tx, ty, 10 + 50 * q, 0, Math.PI * 2);
        ctx.stroke();
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2 + i;
          ctx.fillStyle = `rgba(215,245,255,${0.55 * (1 - q)})`;
          circ(tx + Math.cos(a) * (w.x1 - w.x0 + 20) * 0.3 * q, ty + Math.sin(a) * 18 * q - q * 10, 4 + 5 * (1 - q));
        }
      }
      for (const c of w.cells) textLit(c, '#e4fff4', 'rgba(110,240,190,.85)', 9 - 4 * clamp1(e / 500), c.x, c.y, clamp1(e / 200));
    }
    fadeToFinal(r);
  };

  // B-52: a big eight-engined bomber cruises back and forth high up, trailing contrails, and drops a bomb on each
  // word; it bursts and leaves the word glowing hot.
  const B52_FALL = 650; // a bomb's drop
  const bomberX = (r: number) => W / 2 + Math.sin(r / 1300) * W * 0.42;
  const bomberY = Math.max(26, H * 0.12);
  const bomber = (x: number, y: number, dir: number, sz: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir * sz, sz);
    ctx.fillStyle = 'rgba(255,255,255,.35)'; // contrails
    for (const oy of [11, 14, 17, 20]) ctx.fillRect(-190, oy - 1, 148, 2);
    ctx.fillStyle = '#7f8a94'; // far wing and engines
    ctx.beginPath();
    ctx.moveTo(10, 1);
    ctx.lineTo(-20, 0);
    ctx.lineTo(-36, -9);
    ctx.lineTo(-14, -7);
    ctx.fill();
    ctx.fillStyle = '#9aa5ae'; // tail fin
    ctx.beginPath();
    ctx.moveTo(-44, -3);
    ctx.lineTo(-60, -28);
    ctx.lineTo(-50, -28);
    ctx.lineTo(-30, -3);
    ctx.fill();
    ctx.fillStyle = '#c0c9d0'; // fuselage
    ctx.beginPath();
    ctx.moveTo(62, 2);
    ctx.quadraticCurveTo(48, -6, 20, -6);
    ctx.lineTo(-52, -4);
    ctx.lineTo(-52, 4);
    ctx.lineTo(24, 5);
    ctx.quadraticCurveTo(50, 6, 62, 2);
    ctx.fill();
    ctx.fillStyle = '#4e6a86'; // cockpit
    ctx.beginPath();
    ctx.ellipse(42, -2, 7, 2.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#a9b4bd'; // near wing, swept down and back
    ctx.beginPath();
    ctx.moveTo(14, 3);
    ctx.lineTo(-22, 3);
    ctx.lineTo(-44, 18);
    ctx.lineTo(-14, 16);
    ctx.fill();
    ctx.fillStyle = '#5d6872'; // engine pods in pairs
    for (const ex of [4, -6, -20, -30]) {
      ctx.beginPath();
      ctx.ellipse(ex, 13 + (ex < -10 ? 3 : 0), 7, 2.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };
  const drawBomber = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#2a3f6a');
    g.addColorStop(0.7, '#c07a5a');
    g.addColorStop(1, '#3a2a30');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    for (const [cx2, cy2, cr] of [[0.2, 0.35, 28], [0.7, 0.45, 34], [0.5, 0.25, 22]]) {
      circ(W * cx2, H * cy2, cr);
      circ(W * cx2 + cr, H * cy2 + 5, cr * 0.7);
    }
    const sz = Math.min(1.2, Math.max(0.55, H / 330));
    const dir = Math.cos(r / 1300) >= 0 ? 1 : -1;
    bomber(bomberX(r), bomberY, dir, sz);
    ctx.font = `${fs}px ${FONT}`;
    for (const { w, i, t0 } of wt) {
      const rr = r - t0;
      if (rr < 0) continue;
      const tx = w.cx;
      const ty = w.cells[0].y - fs * 0.3;
      if (rr < B52_FALL) {
        const q = rr / B52_FALL;
        const sx = bomberX(t0);
        const d0 = Math.cos(t0 / 1300) >= 0 ? 1 : -1;
        const cx = sx + d0 * 90;
        const cy = bomberY + (ty - bomberY) * 0.25;
        const a = (1 - q) * (1 - q);
        const b = 2 * q * (1 - q);
        const x = a * sx + b * cx + q * q * tx;
        const y = a * (bomberY + 8) + b * cy + q * q * ty;
        const x2 = (1 - (q + 0.02)) ** 2 * sx + 2 * (q + 0.02) * (1 - (q + 0.02)) * cx + (q + 0.02) ** 2 * tx;
        const y2 = (1 - (q + 0.02)) ** 2 * (bomberY + 8) + 2 * (q + 0.02) * (1 - (q + 0.02)) * cy + (q + 0.02) ** 2 * ty;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.atan2(y2 - y, x2 - x));
        ctx.fillStyle = '#3d4a38';
        ctx.beginPath();
        ctx.ellipse(0, 0, 8, 3.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#2a3326';
        ctx.fillRect(-11, -3.4, 4, 6.8);
        ctx.restore();
        continue;
      }
      const e = rr - B52_FALL;
      if (e < 400) {
        const q = e / 400;
        ctx.fillStyle = `rgba(255,255,255,${0.9 * Math.max(0, 1 - q * 3)})`;
        circ(tx, ty, 10 + 40 * q);
        ctx.fillStyle = `rgba(255,${Math.round(190 - 110 * q)},40,${0.85 * (1 - q)})`;
        circ(tx, ty, 8 + ((w.x1 - w.x0) / 2 + 12) * ease(q));
        for (let k = 0; k < 6; k++) {
          ctx.fillStyle = `rgba(70,62,60,${0.5 * (1 - q)})`;
          circ(tx + Math.cos(k * 1.2 + i) * 28 * q, ty - 14 * q - k * 4 * q + Math.sin(k * 1.2 + i) * 8, 9 + 11 * q);
        }
      }
      const hot = clamp1(e / 600);
      for (const c of w.cells) textLit(c, `rgb(255,${Math.round(225 + 30 * hot)},${Math.round(160 + 90 * hot)})`, 'rgba(255,150,50,.9)', 12 - 6 * hot, c.x, c.y, clamp1(e / 120));
    }
    fadeToFinal(r);
  };

  // Kraken: the beast rises out of a stormy sea and its tentacles lash up, plant each word in place with a slam
  // and slide back under the waves.
  const TENT_T = 700; // a tentacle's reach to its word
  const TENT_BACK = 700; // and its slide back down
  const ku = Math.min(1.25, Math.max(0.6, H / 300));
  const drawKraken = (r: number) => {
    const flash = r % 1700 < 90 ? 0.18 : 0; // lightning
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0a1420');
    g.addColorStop(1, '#10303a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    if (flash) {
      ctx.fillStyle = `rgba(210,225,255,${flash})`;
      ctx.fillRect(0, 0, W, H);
    }
    const water = H - 14 * ku;
    const rise = ease((r + T_INTRO) / (T_INTRO + 500));
    const hx = W / 2;
    const hy = water + 70 * ku * (1 - rise); // the head surfaces
    const roar = r < 500 ? Math.sin(r / 25) * 2 * (1 - Math.max(0, r) / 500) : 0;
    ctx.save();
    ctx.translate(hx + roar, hy);
    ctx.scale(ku, ku);
    ctx.fillStyle = '#3d2a58'; // the dome of the head
    ctx.beginPath();
    ctx.ellipse(0, 0, 64, 48, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#52397a';
    for (const [sx2, sy2, sr] of [[-30, -20, 6], [24, -30, 5], [38, -12, 4], [-10, -38, 5]]) circ(sx2, sy2, sr);
    for (const ex of [-22, 22]) { // glowing eyes
      ctx.fillStyle = '#ffd24a';
      ctx.shadowColor = 'rgba(255,210,70,.9)';
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.ellipse(ex, -14, 9, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#16081c';
      ctx.fillRect(ex - 1.3, -19.5, 2.6, 11);
    }
    ctx.restore();
    ctx.font = `${fs}px ${FONT}`;
    for (const { w, i, t0 } of wt) {
      const rr = r - t0;
      if (rr < 0) continue;
      const bx = hx + ((i % 7) - 3) * W * 0.1;
      const by = water + 6;
      const tx = w.cx;
      const ty = w.cells[0].y - fs * 0.3;
      const side = i % 2 ? 1 : -1;
      const cx = (bx + tx) / 2 + side * Math.min(110, W * 0.14);
      const cy = Math.min(by, ty) + (by - ty) * 0.15;
      const reach = rr < TENT_T ? ease(rr / TENT_T) : rr < TENT_T + 200 ? 1 : 1 - ease((rr - TENT_T - 200) / (TENT_BACK - 200));
      const base = rr < TENT_T + 200 ? 0 : ease((rr - TENT_T - 200) / (TENT_BACK - 200));
      if (rr < TENT_T + TENT_BACK) {
        const pt = (p: number) => {
          const a = (1 - p) * (1 - p);
          const b2 = 2 * p * (1 - p);
          return { x: a * bx + b2 * cx + p * p * tx + Math.sin(p * 9 + r / 110 + i) * 5 * p * (1 - p) * 4, y: a * by + b2 * cy + p * p * ty };
        };
        const lo = base; // the tentacle slides down its own length
        const hi = rr < TENT_T ? reach : 1;
        let prev = pt(lo);
        for (let j = 1; j <= 26; j++) {
          const p = lo + ((hi - lo) * j) / 26;
          const cur = pt(p);
          ctx.strokeStyle = '#4a2d68';
          ctx.lineWidth = Math.max(2, (16 - 13 * p) * ku);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(cur.x, cur.y);
          ctx.stroke();
          if (j % 3 === 0) {
            ctx.fillStyle = 'rgba(230,170,240,.75)'; // suckers
            circ(cur.x + 2, cur.y + 2, Math.max(1, (4 - 3 * p) * ku));
          }
          prev = cur;
        }
      }
      if (rr >= TENT_T) {
        const e = rr - TENT_T;
        if (e < 320) { // the slam
          ctx.strokeStyle = `rgba(190,255,240,${0.8 * (1 - e / 320)})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(tx, ty, 8 + 40 * (e / 320), 0, Math.PI * 2);
          ctx.stroke();
          for (let k = 0; k < 8; k++) {
            const a = (k / 8) * Math.PI * 2;
            ctx.fillStyle = `rgba(200,240,255,${1 - e / 320})`;
            circ(tx + Math.cos(a) * (14 + e * 0.1), ty + Math.sin(a) * (10 + e * 0.06) - Math.sin((e / 320) * Math.PI) * 10, 2.2);
          }
        }
        for (const c of w.cells) textLit(c, '#dcffe9', 'rgba(110,255,200,.85)', 9 - 4 * clamp1(e / 500), c.x, c.y + (e < 120 ? (1 - e / 120) * -6 : 0), clamp1(e / 100));
      }
    }
    ctx.fillStyle = 'rgba(8,30,38,.92)'; // the waves in front
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 10) ctx.lineTo(x, water + 4 + Math.sin(x / 22 + r / 260) * 4 + Math.sin(x / 57 - r / 400) * 3);
    ctx.lineTo(W, H);
    ctx.fill();
    ctx.strokeStyle = 'rgba(190,230,240,.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 10) {
      const y = water + 4 + Math.sin(x / 22 + r / 260) * 4 + Math.sin(x / 57 - r / 400) * 3;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    fadeToFinal(r);
  };

  // Thor's hammer: a mighty hammer spins out of the storm to strike each word, lightning cracks down on it, and
  // the hammer flies back to its owner's hand.
  const THOR_OUT = 380; // the hammer's throw
  const THOR_END = 880; // when it is back in hand
  const thorHome = { x: W * 0.07, y: H * 0.16 };
  const thorBolt = wt.map(() => Array.from({ length: 9 }, () => (rnd() - 0.5) * 34));
  const thorRain = Array.from({ length: 70 }, () => ({ x: rnd() * W, y: rnd() * H, v: 0.5 + rnd() * 0.6 }));
  const hammer = (x: number, y: number, rot: number, sz: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(sz, sz);
    ctx.fillStyle = '#6b4a2e'; // handle
    ctx.fillRect(-2.6, 8, 5.2, 28);
    ctx.strokeStyle = '#c9b27a';
    ctx.lineWidth = 1.5;
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.moveTo(-2.6, 14 + k * 5);
      ctx.lineTo(2.6, 16 + k * 5);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 38, 3.2, 0, Math.PI * 2);
    ctx.stroke();
    const head = ctx.createLinearGradient(0, -10, 0, 10);
    head.addColorStop(0, '#c5ced8');
    head.addColorStop(1, '#6f7a86');
    ctx.fillStyle = head; // the head
    ctx.fillRect(-14, -9, 28, 18);
    ctx.fillStyle = '#58626d';
    ctx.fillRect(-17, -10, 4, 20);
    ctx.fillRect(13, -10, 4, 20);
    ctx.strokeStyle = 'rgba(40,50,60,.7)'; // engraved knotwork
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-9, -3);
    ctx.lineTo(-3, 3);
    ctx.lineTo(3, -3);
    ctx.lineTo(9, 3);
    ctx.stroke();
    ctx.restore();
  };
  const drawThor = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0c1224');
    g.addColorStop(1, '#1d2740');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(70,80,110,.45)'; // storm clouds
    for (let k = 0; k < 7; k++) circ(W * (k / 6) + Math.sin(r / 900 + k) * 10, 8 + (k % 2) * 8, 38 + (k % 3) * 8);
    ctx.strokeStyle = 'rgba(170,190,230,.28)'; // rain
    ctx.lineWidth = 1;
    for (const d of thorRain) {
      const y = (((d.y + r * d.v * 0.9) % H) + H) % H;
      ctx.beginPath();
      ctx.moveTo(d.x, y);
      ctx.lineTo(d.x - 3, y + 10);
      ctx.stroke();
    }
    const sz = Math.min(1.5, Math.max(0.9, fs / 14));
    let shake = 0;
    let flash = 0;
    for (const { t0 } of wt) {
      const e = r - t0 - THOR_OUT;
      if (e >= 0 && e < 150) {
        flash = Math.max(flash, 0.28 * (1 - e / 150));
        shake = Math.max(shake, 3 * (1 - e / 150));
      }
    }
    ctx.save();
    ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    ctx.font = `${fs}px ${FONT}`;
    for (const { w, i, t0 } of wt) {
      const rr = r - t0;
      if (rr < 0) continue;
      const tx = w.cx;
      const ty = w.cells[0].y - fs * 0.3;
      if (rr < THOR_END) {
        let hx: number;
        let hy: number;
        let rot: number;
        if (rr < THOR_OUT) {
          const q = rr / THOR_OUT;
          const e = q * q;
          hx = thorHome.x + (tx - thorHome.x) * e;
          hy = thorHome.y + (ty - thorHome.y) * e;
          rot = rr * 0.03;
        } else if (rr < THOR_OUT + 120) {
          hx = tx;
          hy = ty;
          rot = THOR_OUT * 0.03;
        } else {
          const q = ease((rr - THOR_OUT - 120) / (THOR_END - THOR_OUT - 120));
          hx = tx + (thorHome.x - tx) * q;
          hy = ty + (thorHome.y - ty) * q;
          rot = THOR_OUT * 0.03 - q * 6;
        }
        hammer(hx, hy, rot, sz);
      }
      if (rr < THOR_OUT) continue;
      const e = rr - THOR_OUT;
      if (e < 240) { // the lightning
        const a = 1 - e / 240;
        ctx.lineJoin = 'round';
        for (const [lw, col] of [[7, `rgba(110,160,255,${0.45 * a})`], [2.4, `rgba(255,255,255,${a})`]] as [number, string][]) {
          ctx.strokeStyle = col;
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.moveTo(tx + thorBolt[i][0], 0);
          for (let k = 1; k <= 8; k++) ctx.lineTo(tx + thorBolt[i][k] * (1 - k / 9), (ty * k) / 8);
          ctx.stroke();
        }
      }
      if (e < 350) {
        ctx.strokeStyle = `rgba(150,200,255,${0.8 * (1 - e / 350)})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(tx, ty, 8 + 70 * (e / 350), 0, Math.PI * 2);
        ctx.stroke();
      }
      for (const c of w.cells) textLit(c, '#e8f4ff', 'rgba(110,170,255,.95)', 12 - 6 * clamp1(e / 600), c.x, c.y, clamp1(e / 80));
    }
    ctx.restore();
    if (flash) {
      ctx.fillStyle = `rgba(210,225,255,${flash})`;
      ctx.fillRect(0, 0, W, H);
    }
    fadeToFinal(r);
  };

  // Spiders: a spider lowers each word down on a silk thread, sets it in place and scuttles back up its web.
  const SPI_DOWN = 900; // the descent with the word
  const SPI_UP = 800; // the climb back up
  const spiderAt = (x: number, y: number, ss: number, r: number, hurry: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(ss, ss);
    const wig = Math.sin(r / (hurry ? 40 : 110));
    ctx.strokeStyle = '#6a5a82';
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    for (const side of [-1, 1]) {
      for (let k = 0; k < 4; k++) {
        const sw = Math.sin(r / (hurry ? 45 : 130) + k * 1.3 + (side > 0 ? 1.5 : 0)) * 2.5;
        const bx = side * 4;
        const by = 1 + k * 2;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(side * (13 + k * 1.5), by - 7 + sw);
        ctx.lineTo(side * (20 + k * 2), by + 7 + k * 2 + wig * 0.8);
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#0c0912';
    ctx.strokeStyle = '#5a4a70';
    ctx.beginPath();
    ctx.ellipse(0, 8, 7.5, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -3, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ff3a3a'; // glowing red eyes
    ctx.shadowColor = 'rgba(255,60,60,.9)';
    ctx.shadowBlur = 6;
    circ(-2, -4.2, 1.2);
    circ(2, -4.2, 1.2);
    circ(-1, -2, 0.8);
    circ(1, -2, 0.8);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#d02828'; // a red hourglass mark
    ctx.beginPath();
    ctx.moveTo(-2.4, 5);
    ctx.lineTo(2.4, 5);
    ctx.lineTo(0, 8.5);
    ctx.lineTo(2.4, 12);
    ctx.lineTo(-2.4, 12);
    ctx.lineTo(0, 8.5);
    ctx.fill();
    ctx.restore();
  };
  const cobweb = (cx: number, cy: number, rad: number, a0: number) => {
    ctx.strokeStyle = 'rgba(200,195,225,.16)';
    ctx.lineWidth = 1;
    for (let k = 0; k < 7; k++) {
      const a = a0 + (k / 6) * (Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
      ctx.stroke();
    }
    for (let ring = 1; ring <= 5; ring++) {
      ctx.beginPath();
      for (let k = 0; k <= 6; k++) {
        const a = a0 + (k / 6) * (Math.PI / 2);
        const rr2 = (rad * ring) / 5 * (1 - (k % 2 ? 0.06 : 0));
        const x = cx + Math.cos(a) * rr2;
        const y = cy + Math.sin(a) * rr2;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  };
  const drawSpiders = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#1d1630');
    g.addColorStop(1, '#2e2340');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(235,230,250,.14)'; // pale moonlight
    circ(W * 0.78, H * 0.2, Math.min(W, H) * 0.14);
    cobweb(0, 0, Math.min(150, W * 0.3), 0);
    cobweb(W, 0, Math.min(150, W * 0.3), Math.PI / 2);
    const ss = Math.min(1.4, Math.max(0.8, fs / 16));
    ctx.font = `${fs}px ${FONT}`;
    for (const { w, i, t0 } of wt) {
      const rr = r - t0;
      if (rr < 0) continue;
      const ty = w.cells[0].y - fs * 0.3;
      const yFinal = ty - fs * 1.9;
      const sway = Math.sin(r / 420 + i) * 3;
      const x = w.cx + sway;
      if (rr < SPI_DOWN) {
        const q = ease(rr / SPI_DOWN);
        const sy = -24 + (yFinal + 24) * q;
        ctx.strokeStyle = 'rgba(225,220,245,.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(w.cx, 0);
        ctx.lineTo(x, sy - 3);
        ctx.stroke();
        spiderAt(x, sy, ss, r, 0);
        for (const c of w.cells) textLit(c, '#ece8f8', 'rgba(170,140,230,.8)', 7, c.x + sway, c.y + (sy - yFinal));
      } else {
        const e = rr - SPI_DOWN;
        for (const c of w.cells) textLit(c, '#ece8f8', 'rgba(170,140,230,.8)', 6 - 2 * clamp1(e / 600), c.x, c.y);
        if (e < SPI_UP) {
          const q = e / SPI_UP;
          const sy = yFinal - (yFinal + 30) * q * q;
          ctx.strokeStyle = `rgba(225,220,245,${0.55 * (1 - q * 0.6)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(w.cx, 0);
          ctx.lineTo(x, sy - 3);
          ctx.stroke();
          spiderAt(x, sy, ss, r, 1);
        }
      }
    }
    fadeToFinal(r);
  };

  // Hat dance: two dancers in bright folk dress hop and stamp around a big sombrero on the floor, under paper
  // bunting, and toss each letter out of their own hats in a shower of confetti.
  const HAT_T = 700; // a letter's flight from a dancer's hat
  const hu = Math.min(1.25, Math.max(0.7, H / 300));
  const hatCx = W / 2;
  const hatFloor = H - 24 * hu;
  const hatOrbit = Math.min(W * 0.3, 190);
  const dancerPos = (k: number, t: number) => {
    const a = t / 420 + k * Math.PI;
    const hop = Math.abs(Math.sin(t / 110 + k * 2)) * 6 * hu;
    return { x: hatCx + Math.cos(a) * hatOrbit, y: hatFloor + Math.sin(a) * 9 * hu - hop, depth: Math.sin(a), hop };
  };
  const dancerHatTop = (k: number, t: number) => {
    const p = dancerPos(k, t);
    return { x: p.x, y: p.y - 58 * hu };
  };
  const folkDancer = (k: number, r: number) => {
    const p = dancerPos(k, r);
    const col = k ? '#2f9e5a' : '#d6334a';
    const ph = r / 110 + k * 2;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(hu, hu);
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.beginPath();
    ctx.ellipse(0, p.hop / hu + 1, 15, 3.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#3a2418'; // legs, one stamping
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-3, -14);
    ctx.lineTo(-4, -2 - Math.max(0, Math.sin(ph)) * 5);
    ctx.moveTo(3, -14);
    ctx.lineTo(4, -2 - Math.max(0, -Math.sin(ph)) * 5);
    ctx.stroke();
    ctx.fillStyle = col; // the full skirt with a ruffle
    ctx.beginPath();
    ctx.moveTo(-5, -25);
    ctx.lineTo(5, -25);
    ctx.lineTo(17 + Math.sin(ph * 2) * 1.5, -11);
    ctx.lineTo(-17 - Math.sin(ph * 2) * 1.5, -11);
    ctx.fill();
    ctx.fillStyle = '#f6efe2';
    ctx.fillRect(-16, -14, 32, 3);
    ctx.fillStyle = '#e8b52a';
    for (let j = -2; j <= 2; j++) circ(j * 6, -18, 1.6);
    ctx.fillStyle = '#f6efe2'; // blouse
    ctx.fillRect(-5, -37, 10, 13);
    ctx.fillStyle = col;
    ctx.fillRect(-5, -33, 10, 2.4);
    ctx.strokeStyle = '#d9a066'; // arms: one lifts the skirt, one waves
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-5, -35);
    ctx.lineTo(-14, -26 + Math.sin(ph) * 2);
    ctx.moveTo(5, -35);
    ctx.lineTo(14, -44 + Math.sin(ph + 1.5) * 4);
    ctx.stroke();
    ctx.fillStyle = '#d9a066'; // head and braid
    circ(0, -42, 5.6);
    ctx.strokeStyle = '#1e140e';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(-4, -42);
    ctx.quadraticCurveTo(-9, -34, -6 + Math.sin(ph) * 2, -27);
    ctx.stroke();
    ctx.fillStyle = '#e8b52a'; // the broad straw hat
    ctx.beginPath();
    ctx.ellipse(0, -47, 16, 3.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, -51, 7.5, 5.5, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = col;
    ctx.fillRect(-7.5, -52, 15, 2.6);
    ctx.restore();
  };
  const drawHatDance = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#2a1450');
    g.addColorStop(1, '#5a2a3a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#6a4228'; // the floor
    ctx.fillRect(0, hatFloor - 10 * hu, W, H);
    ctx.strokeStyle = 'rgba(255,220,160,.12)';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 30 * hu) {
      ctx.beginPath();
      ctx.moveTo(x, hatFloor - 10 * hu);
      ctx.lineTo(x - 20, H);
      ctx.stroke();
    }
    const flagCols = ['#e8334a', '#f2a30f', '#2fb86a', '#2f8fe8', '#c93fd0', '#f6e14a']; // paper bunting
    ctx.strokeStyle = 'rgba(255,255,255,.5)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, 10);
    ctx.quadraticCurveTo(W / 2, 34, W, 10);
    ctx.stroke();
    const nFlags = Math.max(6, Math.round(W / 46));
    for (let k = 0; k < nFlags; k++) {
      const q = (k + 0.5) / nFlags;
      const fx = W * q;
      const fy = 10 + 24 * 4 * q * (1 - q) * 0.5 + 0;
      const sway = Math.sin(r / 400 + k) * 2;
      ctx.fillStyle = flagCols[k % flagCols.length];
      ctx.beginPath();
      ctx.moveTo(fx - 13, fy);
      ctx.lineTo(fx + 13, fy);
      ctx.lineTo(fx + 13 + sway, fy + 24);
      ctx.lineTo(fx + sway, fy + 17);
      ctx.lineTo(fx - 13 + sway, fy + 24);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      circ(fx + sway * 0.5, fy + 8, 2.2);
    }
    ctx.fillStyle = '#d9a64a'; // the big sombrero on the floor
    ctx.beginPath();
    ctx.ellipse(hatCx, hatFloor, 56 * hu, 11 * hu, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#c4903a';
    ctx.beginPath();
    ctx.ellipse(hatCx, hatFloor - 6 * hu, 22 * hu, 13 * hu, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#c0283c';
    ctx.fillRect(hatCx - 22 * hu, hatFloor - 8 * hu, 44 * hu, 4 * hu);
    const order = [0, 1].sort((a, b) => dancerPos(a, r).depth - dancerPos(b, r).depth);
    for (const k of order) folkDancer(k, r);
    ctx.font = `${fs}px ${FONT}`;
    visible.forEach((c, i) => {
      const rr = r - c.lock;
      if (rr < 0) return;
      const hue = (i * 37) % 360;
      if (rr < HAT_T) {
        const q = rr / HAT_T;
        const s = dancerHatTop(i % 2, c.lock);
        const ex = c.x + cw / 2;
        const ey = c.y - fs * 0.3;
        const cx = (s.x + ex) / 2;
        const cy = Math.min(s.y, ey) - H * 0.25;
        const pos = (p: number) => ({ x: (1 - p) * (1 - p) * s.x + 2 * p * (1 - p) * cx + p * p * ex, y: (1 - p) * (1 - p) * s.y + 2 * p * (1 - p) * cy + p * p * ey });
        for (let k = 3; k >= 1; k--) {
          const tp = pos(Math.max(0, q - k * 0.05));
          ctx.fillStyle = `hsla(${hue},90%,65%,${0.6 - k * 0.14})`;
          circ(tp.x, tp.y, 2.6);
        }
        const p = pos(q);
        ctx.fillStyle = `hsla(${hue},95%,62%,.85)`;
        circ(p.x, p.y, fs * 0.62);
        textLit(c, '#ffffff', `hsla(${hue},95%,70%,.95)`, 6, p.x - cw / 2, p.y + fs * 0.3, 1);
        return;
      }
      const e = rr - HAT_T;
      if (e < 300) {
        for (let k = 0; k < 6; k++) { // confetti burst on landing
          const a = (k / 6) * Math.PI * 2 + i;
          ctx.fillStyle = `hsla(${(hue + k * 50) % 360},95%,65%,${1 - e / 300})`;
          ctx.fillRect(c.x + cw / 2 + Math.cos(a) * (6 + e * 0.07), c.y - fs * 0.3 + Math.sin(a) * (6 + e * 0.05) + e * 0.02, 3, 3);
        }
      }
      textLit(c, '#fff6d8', `hsla(${hue},95%,68%,.85)`, 8 - 4 * clamp1(e / 400), c.x, c.y, clamp1(e / 100));
    });
    fadeToFinal(r);
  };

  // Techno lasers: a dark club with a pulsing floor and equaliser, and neon laser beams sweeping the room; a word
  // lights up where a beam crosses it.
  const LZ_COL = ['0,255,156', '255,43,214', '43,216,255', '255,238,43', '255,90,60', '150,90,255'];
  const lzSrc = [0.16, 0.5, 0.84].map((f) => ({ x: W * f, y: -4 }));
  const lzBeams = Array.from({ length: 6 }, (_, b) => ({ s: lzSrc[b % 3], ph: b * 1.1, sp: 520 + b * 140, amp: 0.7 + (b % 2) * 0.25, col: LZ_COL[b] }));
  const lzAngle = (b: (typeof lzBeams)[number], r: number) => Math.PI / 2 + Math.sin(r / b.sp + b.ph) * b.amp;
  const lzLit = visible.map(() => ({ at: -1, col: '255,255,255' }));
  const drawLasers = (r: number) => {
    ctx.fillStyle = '#07040f';
    ctx.fillRect(0, 0, W, H);
    const beat = (r % 500) / 500; // 120 bpm
    const pulse = Math.pow(1 - beat, 3);
    ctx.fillStyle = `rgba(255,255,255,${0.05 * pulse})`;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = `rgba(150,90,255,${0.18 + 0.3 * pulse})`; // the floor grid
    ctx.lineWidth = 1;
    for (let k = 0; k < 8; k++) {
      const y = H * 0.74 + Math.pow(k / 7, 2) * H * 0.26;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    for (let k = -8; k <= 8; k++) {
      ctx.beginPath();
      ctx.moveTo(W / 2 + k * 14, H * 0.74);
      ctx.lineTo(W / 2 + k * 70, H);
      ctx.stroke();
    }
    const bars = Math.max(12, Math.round(W / 22)); // equaliser
    for (let k = 0; k < bars; k++) {
      const hgt = (0.25 + 0.75 * Math.abs(Math.sin(r / 150 + k * 0.7) * Math.cos(r / 230 + k))) * H * 0.14 * (0.7 + 0.3 * pulse);
      ctx.fillStyle = `hsla(${(k / bars) * 300 + (r / 20) % 60},100%,60%,.55)`;
      ctx.fillRect((W / bars) * k + 2, H - hgt, W / bars - 4, hgt);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const b of lzBeams) {
      const a = lzAngle(b, r);
      const L = H * 1.7;
      const x2 = b.s.x + Math.cos(a) * L;
      const y2 = b.s.y + Math.sin(a) * L;
      ctx.strokeStyle = `rgba(${b.col},.08)`;
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.moveTo(b.s.x, b.s.y);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(${b.col},.75)`;
      ctx.shadowColor = `rgba(${b.col},1)`;
      ctx.shadowBlur = 12;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(b.s.x, b.s.y);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.restore();
    ctx.font = `${fs}px ${FONT}`;
    visible.forEach((c, i) => {
      const lit = lzLit[i];
      if (lit.at < 0) {
        const cx = c.x + cw / 2;
        const cy = c.y - fs * 0.3;
        for (const b of lzBeams) {
          const dx = cx - b.s.x;
          const dy = cy - b.s.y;
          const da = Math.abs(Math.atan2(dy, dx) - lzAngle(b, r));
          if (da < 11 / Math.max(30, Math.hypot(dx, dy))) {
            lit.at = r;
            lit.col = b.col;
            break;
          }
        }
        if (lit.at < 0 && r >= c.lock + 900) lit.at = r; // a beam that has not found it yet cannot hold it back
      }
      if (lit.at < 0) return;
      const e = r - lit.at;
      textLit(c, e < 260 ? `rgb(${lit.col})` : '#e8fff4', `rgba(${lit.col},.95)`, 14 - 7 * clamp1(e / 600), c.x, c.y, clamp1(e / 60));
    });
    fadeToFinal(r);
  };

  // Earthquake: the ground shakes and the city's buildings topple one by one in clouds of dust; each word is
  // uncovered as the building behind it comes down.
  const QK_COL = 700; // a building's fall
  const QK_DUST = 1300; // how long its dust hangs
  const qkN = Math.max(6, Math.round(W / 62));
  const qkW = W / qkN;
  const qkGround = H - 24;
  const qkB = Array.from({ length: qkN }, (_, k) => ({
    x: k * qkW,
    h: H * (0.36 + rnd() * 0.4),
    dir: rnd() < 0.5 ? -1 : 1,
    shade: 36 + Math.floor(rnd() * 26),
    ct: -1,
    rub: Array.from({ length: 6 }, () => rnd()),
  }));
  for (const { w, t0 } of wt) {
    const b = qkB[Math.min(qkN - 1, Math.max(0, Math.floor(w.cx / qkW)))];
    b.ct = b.ct < 0 ? t0 : Math.min(b.ct, t0);
  }
  for (const b of qkB) if (b.ct < 0) b.ct = rnd() * Math.max(600, T_RES - 1800); // buildings with no word still fall
  const qkEnd = Math.max(...qkB.map((b) => b.ct));
  const qkCrack = Array.from({ length: 40 }, () => rnd());
  const drawQuake = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#2b2348');
    g.addColorStop(1, '#c47a5a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const rampUp = clamp1((r + T_INTRO) / 800);
    const ease2 = r > qkEnd + QK_COL ? Math.max(0, 1 - (r - qkEnd - QK_COL) / 500) : 1;
    const amp = (1.5 + 4.5 * rampUp) * ease2;
    ctx.save();
    ctx.translate((Math.random() - 0.5) * amp * 2, (Math.random() - 0.5) * amp);
    ctx.fillStyle = '#26202c';
    ctx.fillRect(-10, qkGround, W + 20, H - qkGround + 10);
    for (const b of qkB) {
      const bw2 = qkW * 0.9;
      const e = r - b.ct;
      const px = b.dir > 0 ? b.x + bw2 : b.x;
      ctx.save();
      if (e < 0) { // standing, shuddering harder as its turn nears
        const sh = e > -500 ? (1 + e / 500) * 0.012 : 0.003;
        ctx.translate(px, qkGround);
        ctx.rotate(Math.sin(r / 35 + b.x) * sh);
        ctx.translate(-px, -qkGround);
      } else if (e < QK_COL) {
        const q = e / QK_COL;
        ctx.translate(px, qkGround);
        ctx.rotate(b.dir * q * q * 1.25);
        ctx.translate(-px, -qkGround + q * q * b.h * 0.5);
        ctx.globalAlpha = 1 - q * q * 0.6;
      }
      if (e < QK_COL) {
        ctx.fillStyle = `rgb(${b.shade},${b.shade - 4},${b.shade + 14})`;
        ctx.fillRect(b.x, qkGround - b.h, bw2, b.h);
        for (let wy = qkGround - b.h + 8; wy < qkGround - 12; wy += 14) {
          for (let wx = b.x + 5; wx < b.x + bw2 - 6; wx += 11) {
            const on = Math.sin(wx * 12.9 + wy * 7.1) > -0.1;
            ctx.fillStyle = on ? 'rgba(255,215,120,.75)' : 'rgba(10,10,20,.5)';
            ctx.fillRect(wx, wy, 5, 7);
          }
        }
      }
      ctx.restore();
      if (e >= QK_COL * 0.8) { // the rubble heap
        const hh = b.h * 0.16;
        ctx.fillStyle = `rgb(${b.shade + 10},${b.shade + 4},${b.shade + 14})`;
        ctx.beginPath();
        ctx.moveTo(b.x - 6, qkGround);
        ctx.lineTo(b.x + 4, qkGround - hh * b.rub[0]);
        for (let j = 1; j <= 5; j++) ctx.lineTo(b.x + (bw2 * j) / 5, qkGround - hh * (0.3 + 0.7 * b.rub[j]));
        ctx.lineTo(b.x + bw2 + 6, qkGround);
        ctx.fill();
      }
    }
    ctx.strokeStyle = '#0c0a10'; // cracks opening across the ground
    ctx.lineWidth = 2;
    const reach = clamp1((r + T_INTRO) / Math.max(1, qkEnd + QK_COL));
    ctx.beginPath();
    ctx.moveTo(0, qkGround + 6);
    for (let j = 1; j <= 40; j++) {
      if (j / 40 > reach) break;
      ctx.lineTo((W * j) / 40, qkGround + 4 + qkCrack[j - 1] * 14);
    }
    ctx.stroke();
    for (const b of qkB) { // dust clouds
      const e = r - b.ct;
      if (e < 0 || e > QK_DUST) continue;
      for (let j = 0; j < 9; j++) {
        const sp = 0.5 + (j % 3) * 0.3;
        ctx.fillStyle = `rgba(190,170,150,${0.5 * (1 - e / QK_DUST)})`;
        circ(b.x + qkW / 2 + Math.cos(j * 0.9 + b.x) * (qkW * 0.5 + e * 0.05), qkGround - 8 - e * 0.045 * sp - j * 4, 10 + e * 0.025 + (j % 3) * 3);
      }
    }
    ctx.restore();
    ctx.font = `${fs}px ${FONT}`;
    for (const { w, t0 } of wt) {
      const rr = r - t0 - 250;
      if (rr < 0) continue;
      for (const c of w.cells) textLit(c, '#fff1d8', 'rgba(255,200,120,.85)', 9 - 4 * clamp1(rr / 500), c.x, c.y, clamp1(rr / 350));
    }
    fadeToFinal(r);
  };

  // Volcano: a mountain erupts; lava bombs carrying the letters are flung out of the crater, arc through the
  // ash and land in place, glowing, and cool.
  const VOLC_T = 900; // a lava bomb's flight
  const vuH = H;
  const vApex = { x: W / 2, y: vuH * 0.56 };
  const volcAsh = Array.from({ length: 14 }, () => ({ ph: rnd() * 6, sp: 0.4 + rnd() * 0.5, sd: (rnd() - 0.5) * 60 }));
  const drawVolcano = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#190b16');
    g.addColorStop(1, '#4a1a14');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const first = Math.min(...visible.map((c) => c.lock));
    const last = Math.max(...visible.map((c) => c.lock));
    const active = r > first - 300 && r < last + VOLC_T * 0.6;
    const rumble = r < last ? Math.sin(r / 30) * 1.5 : 0;
    const glowA = (active ? 0.4 : 0.15) + 0.1 * Math.sin(r / 120);
    const gl = ctx.createRadialGradient(vApex.x, vApex.y, 4, vApex.x, vApex.y, W * 0.5);
    gl.addColorStop(0, `rgba(255,120,30,${glowA})`);
    gl.addColorStop(1, 'rgba(255,120,30,0)');
    ctx.fillStyle = gl;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(rumble, 0);
    ctx.fillStyle = '#241216'; // the mountain
    ctx.beginPath();
    ctx.moveTo(W * 0.1, H);
    ctx.lineTo(vApex.x - W * 0.07, vApex.y);
    ctx.lineTo(vApex.x - W * 0.025, vApex.y + 8);
    ctx.lineTo(vApex.x + W * 0.025, vApex.y + 8);
    ctx.lineTo(vApex.x + W * 0.07, vApex.y);
    ctx.lineTo(W * 0.9, H);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,110,30,.9)'; // lava running down the sides
    ctx.lineWidth = 3;
    ctx.shadowColor = 'rgba(255,120,30,.9)';
    ctx.shadowBlur = 10;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(vApex.x + s * W * 0.02, vApex.y + 8);
      ctx.bezierCurveTo(vApex.x + s * W * 0.06, vApex.y + (H - vApex.y) * 0.35, vApex.x + s * W * 0.16 + Math.sin(r / 400) * 4, vApex.y + (H - vApex.y) * 0.6, vApex.x + s * W * 0.2, H);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ff8a2a'; // the glowing crater
    ctx.beginPath();
    ctx.ellipse(vApex.x, vApex.y + 5, W * 0.03, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    if (active) { // ash and embers boiling out of the crater
      for (let j = 0; j < volcAsh.length; j++) {
        const a = volcAsh[j];
        const p = ((r / 1500) * a.sp + a.ph) % 1;
        ctx.fillStyle = `rgba(60,50,52,${0.5 * (1 - p)})`;
        circ(vApex.x + a.sd * p * 2, vApex.y - p * H * 0.5, 10 + p * 30);
      }
      for (let j = 0; j < 16; j++) {
        const p = ((r / 700) * (0.6 + (j % 5) * 0.15) + j * 0.37) % 1;
        ctx.fillStyle = `rgba(255,${Math.round(180 - 90 * p)},40,${1 - p})`;
        circ(vApex.x + Math.sin(j * 4.1) * 40 * p, vApex.y - p * H * 0.38 + p * p * H * 0.2, 2);
      }
    }
    ctx.font = `${fs}px ${FONT}`;
    for (const c of visible) {
      const rr = r - c.lock;
      if (rr < 0) continue;
      const ex = c.x + cw / 2;
      const ey = c.y - fs * 0.3;
      if (rr < VOLC_T) {
        const q = rr / VOLC_T;
        const cx = (vApex.x + ex) / 2;
        const cy = Math.min(vApex.y, ey) - H * 0.55;
        const pos = (p: number) => ({ x: (1 - p) * (1 - p) * vApex.x + 2 * p * (1 - p) * cx + p * p * ex, y: (1 - p) * (1 - p) * vApex.y + 2 * p * (1 - p) * cy + p * p * ey });
        for (let k = 5; k >= 1; k--) { // the fiery trail
          const tp = pos(Math.max(0, q - k * 0.04));
          ctx.fillStyle = `rgba(255,${Math.round(190 - 25 * k)},40,${0.55 - k * 0.09})`;
          circ(tp.x, tp.y, 3.8 - k * 0.5);
        }
        const p = pos(q);
        ctx.fillStyle = 'rgba(255,120,30,.6)';
        circ(p.x, p.y, fs * 0.65);
        textLit(c, '#fff3c0', 'rgba(255,150,40,.95)', 12, p.x - cw / 2, p.y + fs * 0.3, 1);
        continue;
      }
      const e = rr - VOLC_T;
      if (e < 300) { // ember burst where the bomb lands
        for (let k = 0; k < 5; k++) {
          ctx.fillStyle = `rgba(255,${Math.round(200 - 80 * (e / 300))},50,${1 - e / 300})`;
          circ(ex + (k - 2) * 5 * (e / 300 + 0.3), ey - Math.sin((e / 300) * Math.PI) * (6 + k * 2), 1.8);
        }
      }
      const cool = clamp1(e / 900);
      textLit(c, `rgb(255,${Math.round(190 + 60 * cool)},${Math.round(90 + 150 * cool)})`, 'rgba(255,130,40,.9)', 12 - 6 * cool, c.x, c.y, clamp1(e / 100));
    }
    fadeToFinal(r);
  };

  // Emoji: every letter starts as a shuffling emoji, then pops like a balloon into its real letter in a burst of
  // tiny emoji, while big ones drift down the background.
  const EMO = ['😀', '😎', '🤩', '🥳', '😂', '🤯', '😱', '👻', '🤖', '👽', '🦄', '🐙', '🐸', '🐵', '🦊', '🐼', '🍕', '🍩', '🍉', '🌮', '⚡', '🔥', '🌈', '⭐', '💎', '🎈', '🎉', '🚀', '👑', '🎸', '🔮', '🍀'];
  const EMO_POP = 500; // the pop
  const EMO_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  const emoRain = Array.from({ length: 12 }, () => ({ x: rnd() * W, y: rnd() * H, e: Math.floor(rnd() * EMO.length), s: 0.03 + rnd() * 0.04, z: 18 + rnd() * 20, ph: rnd() * 6 }));
  const emojiAt = (e: string, x: number, y: number, size: number, alpha: number) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `${size}px ${EMO_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(e, x, y);
    ctx.restore();
  };
  const drawEmoji = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#2a1a4a');
    g.addColorStop(1, '#14284a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    for (const d of emoRain) {
      const y = (((d.y + r * d.s) % (H + 40)) + H + 40) % (H + 40) - 20;
      emojiAt(EMO[(d.e + Math.floor(r / 900)) % EMO.length], d.x + Math.sin(r / 500 + d.ph) * 10, y, d.z, 0.3);
    }
    const open = clamp1((r + T_INTRO) / T_INTRO);
    visible.forEach((c, i) => {
      const cx = c.x + cw / 2;
      const cy = c.y - fs * 0.3;
      const rr = r - c.lock;
      if (rr < 0) { // still a shuffling emoji
        const e = EMO[(i * 11 + ((i * i) % 7) + Math.floor(r / 220 + i) * 5) % EMO.length];
        emojiAt(e, cx, cy + Math.sin(r / 180 + i) * 2, fs * (0.95 + 0.1 * Math.sin(r / 160 + i)), open);
        return;
      }
      if (rr < EMO_POP) {
        const q = rr / EMO_POP;
        if (q < 0.25) emojiAt(EMO[(i * 11 + ((i * i) % 7) + Math.floor(c.lock / 220 + i) * 5) % EMO.length], cx, cy, fs * (1 + q * 3.2), 1 - q * 3); // swells, then pops
        for (let k = 0; k < 5; k++) { // tiny emoji fly out of the pop
          const a = (k / 5) * Math.PI * 2 + i;
          emojiAt(EMO[(i + k * 5) % EMO.length], cx + Math.cos(a) * q * fs * 2, cy + Math.sin(a) * q * fs * 1.6 + q * q * 8, fs * 0.5, 1 - q);
        }
      }
      textLit(c, '#fff6c8', 'rgba(255,210,90,.95)', 10 - 5 * clamp1(rr / 700), c.x, c.y, clamp1((rr - 80) / 160));
    });
    fadeToFinal(r);
  };

  // Sharks: a shark cruises past each word carrying it in on its back, and the word drops into place as the shark
  // swims on in a burst of bubbles.
  const SH_T = 1400; // a shark's swim across the whole sea
  const shu = Math.min(1.25, Math.max(0.65, H / 300));
  const sharkAt = (x: number, y: number, dir: number, r: number, i: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir * shu, shu);
    ctx.rotate(Math.sin(r / 140 + i) * 0.04);
    const wag = Math.sin(r / 110 + i) * 5;
    const g = ctx.createLinearGradient(0, -16, 0, 14);
    g.addColorStop(0, '#6b8aa2');
    g.addColorStop(1, '#2e4a5e');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(52, -1);
    ctx.bezierCurveTo(30, -17, -10, -18, -40, -3);
    ctx.lineTo(-52, -4 + wag * 0.3);
    ctx.lineTo(-68, -26 + wag);
    ctx.lineTo(-58, -2 + wag * 0.5);
    ctx.lineTo(-64, 18 + wag);
    ctx.lineTo(-40, 4);
    ctx.bezierCurveTo(-5, 16, 30, 13, 52, 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#d9e6ee'; // pale belly
    ctx.beginPath();
    ctx.moveTo(48, 1);
    ctx.bezierCurveTo(30, 10, -2, 12, -36, 3);
    ctx.bezierCurveTo(-4, 6, 28, 5, 48, 1);
    ctx.fill();
    ctx.fillStyle = '#3d5a70'; // dorsal and pectoral fins
    ctx.beginPath();
    ctx.moveTo(6, -14);
    ctx.lineTo(-8, -34);
    ctx.lineTo(-16, -14);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(14, 8);
    ctx.lineTo(-6, 26);
    ctx.lineTo(-10, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,40,55,.6)'; // gills
    ctx.lineWidth = 1.2;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.moveTo(22 - k * 4, -6);
      ctx.lineTo(21 - k * 4, 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#fff'; // eye
    circ(38, -5, 2.6);
    ctx.fillStyle = '#10202c';
    circ(38.6, -5, 1.4);
    ctx.fillStyle = '#fff'; // teeth
    for (let k = 0; k < 6; k++) {
      ctx.beginPath();
      ctx.moveTo(28 + k * 3.6, 2.6 - k * 0.15);
      ctx.lineTo(29.8 + k * 3.6, 6);
      ctx.lineTo(31.6 + k * 3.6, 2.4 - k * 0.15);
      ctx.fill();
    }
    ctx.restore();
  };
  const drawSharks = (r: number) => {
    drawSea(r, '#0f5a7a', '#06202c');
    ctx.font = `${fs}px ${FONT}`;
    for (const { w, i, t0 } of wt) {
      const rr = r - t0;
      if (rr < 0) continue;
      const dir = i % 2 ? -1 : 1;
      const ty = w.cells[0].y - fs * 0.3;
      const sx0 = dir > 0 ? -90 : W + 90;
      const ex0 = dir > 0 ? W + 90 : -90;
      const q = clamp1(rr / SH_T);
      const sx = sx0 + (ex0 - sx0) * q;
      const passed = dir > 0 ? sx >= w.cx : sx <= w.cx;
      const sy = Math.min(H - 30, ty + fs * 2.6 + shu * 22);
      if (q < 1) sharkAt(sx, sy, dir, r, i);
      const off = passed ? 0 : sx - w.cx;
      for (const c of w.cells) textLit(c, '#e8fbff', 'rgba(130,220,255,.9)', passed ? 6 : 10, c.x + off, c.y + (passed ? 0 : 4 * Math.sin(r / 120 + c.x)));
      if (passed) {
        const e = dir > 0 ? (sx - w.cx) / Math.max(1, (ex0 - sx0) / SH_T) : (w.cx - sx) / Math.max(1, Math.abs(ex0 - sx0) / SH_T);
        if (e < 320) {
          for (let k = 0; k < 7; k++) {
            ctx.fillStyle = `rgba(220,245,255,${0.7 * (1 - e / 320)})`;
            circ(w.cx + (k - 3) * (w.x1 - w.x0) * 0.12, ty + 8 - e * 0.05 * (0.5 + (k % 3) * 0.3) - k * 2, 2 + (k % 3));
          }
        }
      }
    }
    fadeToFinal(r);
  };

  // Broomstick ball match: riders in team colours race through a floodlit stadium sky after a darting, winged
  // golden ball; each catch drops a word into place, and the rider zooms off with a fist in the air.
  const BB_IN = 700; // the chase in
  const BB_OUT = 400; // the victory dash
  const bbStart = wt.map(() => 14 + rnd() * H * 0.34);
  const riderAt = (x: number, y: number, dir: number, tilt: number, sz: number, r: number, col: string) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir * sz, sz);
    ctx.rotate(tilt);
    ctx.strokeStyle = '#7a5230'; // broom
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-30, 5);
    ctx.lineTo(30, -1);
    ctx.stroke();
    ctx.strokeStyle = '#c4954a';
    ctx.lineWidth = 1.6;
    for (let j = -3; j <= 3; j++) {
      ctx.beginPath();
      ctx.moveTo(-30, 5);
      ctx.lineTo(-48, 5 + j * 3 + Math.sin(r / 55 + j) * 1.5);
      ctx.stroke();
    }
    ctx.strokeStyle = col; // streaming scarf
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    ctx.moveTo(4, -26);
    ctx.quadraticCurveTo(-12, -22 + Math.sin(r / 60) * 4, -26, -26 + Math.sin(r / 50) * 5);
    ctx.stroke();
    ctx.fillStyle = col; // robes, leaning into the wind
    ctx.beginPath();
    ctx.moveTo(-2, -24);
    ctx.lineTo(12, -22);
    ctx.lineTo(6, -2);
    ctx.lineTo(-8, -3);
    ctx.fill();
    ctx.strokeStyle = '#1a1620';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(2, -4);
    ctx.lineTo(8, 6);
    ctx.stroke();
    ctx.strokeStyle = col;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(8, -20);
    ctx.lineTo(24, -26);
    ctx.stroke();
    ctx.fillStyle = '#f0c9a0';
    circ(26, -26, 2.6);
    circ(6, -31, 6);
    ctx.fillStyle = '#2a1c14'; // hair
    ctx.beginPath();
    ctx.arc(5, -33, 6.2, Math.PI, Math.PI * 1.9);
    ctx.fill();
    ctx.fillStyle = '#111';
    circ(8.5, -31.5, 1);
    ctx.restore();
  };
  const goldBall = (x: number, y: number, r: number) => {
    const fl = Math.sin(r / 25) * 4;
    ctx.fillStyle = 'rgba(255,235,170,.9)';
    ctx.beginPath();
    ctx.ellipse(x - 6, y - 4 - fl, 7, 2.4, -0.5, 0, Math.PI * 2);
    ctx.ellipse(x + 6, y - 4 - fl, 7, 2.4, 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffd24a';
    ctx.shadowColor = 'rgba(255,215,80,.95)';
    ctx.shadowBlur = 10;
    circ(x, y, 4.2);
    ctx.shadowBlur = 0;
  };
  const drawBroomball = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#1d2a5a');
    g.addColorStop(0.75, '#8a5a78');
    g.addColorStop(1, '#2a1a30');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#d8b04a'; // the goal hoops on their poles
    ctx.lineWidth = 3;
    for (const gx of [W * 0.06, W * 0.94]) {
      ctx.beginPath();
      ctx.moveTo(gx, H);
      ctx.lineTo(gx, H * 0.4);
      ctx.stroke();
      for (const [hy, hr] of [[0.4, 13], [0.5, 15], [0.6, 13]]) {
        ctx.beginPath();
        ctx.ellipse(gx, H * hy - hr, hr * 0.5, hr, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.fillStyle = 'rgba(10,8,20,.7)'; // stands full of spectators
    ctx.fillRect(0, H - 22, W, 22);
    for (let k = 0; k < W / 9; k++) {
      ctx.fillStyle = `hsl(${(k * 47) % 360},60%,55%)`;
      circ(k * 9 + 4, H - 14 + Math.sin(r / 200 + k) * 1.5, 2.4);
    }
    const sz = Math.min(1.3, Math.max(0.8, fs / 16));
    ctx.font = `${fs}px ${FONT}`;
    for (const { w, i, t0 } of wt) {
      const rr = r - t0;
      if (rr < 0) continue;
      const dir = i % 2 ? -1 : 1;
      const col = i % 2 ? '#d83a3a' : '#2f6fe0';
      const px = w.cx;
      const py = Math.max(30, w.cells[0].y - fs * 1.6);
      const sx = dir > 0 ? -60 : W + 60;
      const ex = dir > 0 ? W + 60 : -60;
      if (rr < BB_IN + BB_OUT) {
        let x: number;
        let y: number;
        if (rr < BB_IN) {
          const q = rr / BB_IN;
          const e = 1 - Math.pow(1 - q, 2);
          x = sx + (px - sx) * e;
          y = bbStart[i] + (py - bbStart[i]) * e + Math.sin(q * 6) * 12 * (1 - q);
          const bx = x + dir * 46 * (1 - q); // the ball darts a little way ahead and is caught at the end
          const by = y + Math.sin(r / 70) * 14 * (1 - q) - 4;
          for (let k = 1; k <= 5; k++) {
            ctx.fillStyle = `rgba(255,220,100,${0.5 - k * 0.08})`;
            circ(bx - dir * k * 7, by + Math.sin(r / 70 - k) * 3, 2.4);
          }
          goldBall(bx, by, r);
        } else {
          const q = (rr - BB_IN) / BB_OUT;
          x = px + (ex - px) * q * q;
          y = py - 50 * q * q;
        }
        riderAt(x, y, dir, dir * Math.sin(r / 140 + i) * 0.05 + (rr >= BB_IN ? -0.2 : 0), sz, r, col);
      }
      if (rr >= BB_IN) {
        const e = rr - BB_IN;
        if (e < 350) { // the catch
          ctx.strokeStyle = `rgba(255,225,110,${1 - e / 350})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(px, py, 6 + 44 * (e / 350), 0, Math.PI * 2);
          ctx.stroke();
        }
        for (const c of w.cells) textLit(c, '#fff2c0', 'rgba(255,205,80,.95)', 10 - 4 * clamp1(e / 500), c.x, c.y, clamp1(e / 200));
      }
    }
    fadeToFinal(r);
  };

  // Zombies: green hands claw up out of the graves holding the words, heave them into place and sink back, while
  // zombies shamble through the mist behind.
  const ZOM_UP = 800; // the hand's heave
  const ZOM_BACK = 600; // and its sinking away
  const zomGy = H - 20;
  const zomWalk = Array.from({ length: 3 }, (_, k) => ({ x: rnd() * W, v: (k % 2 ? -1 : 1) * (0.012 + rnd() * 0.01), s: 0.55 + rnd() * 0.25 }));
  const zombieWalker = (x: number, dir: number, sz: number, r: number, k: number) => {
    ctx.save();
    ctx.translate(x, zomGy - 4);
    ctx.scale(dir * sz, sz);
    const sw = Math.sin(r / 260 + k * 2);
    ctx.fillStyle = 'rgba(40,52,34,.9)';
    ctx.fillRect(-4, -26, 3, 26 - Math.max(0, sw) * 3); // shuffling legs
    ctx.fillRect(1, -26, 3, 26 + Math.min(0, sw) * 3);
    ctx.fillStyle = '#3d3a4a'; // ragged clothes
    ctx.fillRect(-7, -50, 14, 26);
    ctx.fillStyle = '#6f9a4c';
    ctx.beginPath();
    ctx.arc(1, -58, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#10140a';
    circ(3.5, -59, 1.8);
    circ(-1, -59, 1.8);
    ctx.fillRect(0, -54, 6, 1.4);
    ctx.strokeStyle = '#6f9a4c'; // arms stretched out in front
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(4, -46);
    ctx.lineTo(24, -48 + sw * 1.5);
    ctx.moveTo(4, -42);
    ctx.lineTo(22, -42 - sw * 1.5);
    ctx.stroke();
    ctx.restore();
  };
  const zombieHand = (x: number, baseY: number, topY: number, r: number, i: number) => {
    const bend = Math.sin(r / 180 + i) * 5;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#496b30';
    ctx.lineWidth = 11;
    ctx.beginPath();
    ctx.moveTo(x, baseY);
    ctx.quadraticCurveTo(x + bend, (baseY + topY) / 2, x, topY);
    ctx.stroke();
    ctx.strokeStyle = '#7fae58';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(x, baseY);
    ctx.quadraticCurveTo(x + bend, (baseY + topY) / 2, x, topY);
    ctx.stroke();
    ctx.fillStyle = '#7fae58'; // the clutching hand
    circ(x, topY, 7);
    ctx.strokeStyle = '#7fae58';
    ctx.lineWidth = 2.6;
    for (let f = -2; f <= 1; f++) {
      ctx.beginPath();
      ctx.moveTo(x + f * 4 + 2, topY - 3);
      ctx.lineTo(x + f * 5.5 + 2 + Math.sin(r / 150 + f) * 1.5, topY - 12);
      ctx.stroke();
    }
    ctx.restore();
  };
  const drawZombies = (r: number) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0c1a14');
    g.addColorStop(1, '#1b2a20');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(210,235,190,.85)'; // a sickly moon
    circ(W * 0.84, H * 0.17, Math.min(W, H) * 0.075);
    ctx.fillStyle = 'rgba(30,46,34,.9)'; // tombstones
    for (let k = 0; k < Math.max(4, W / 90); k++) {
      const tx2 = ((k * 97 + 40) % W);
      ctx.beginPath();
      ctx.moveTo(tx2 - 9, zomGy);
      ctx.lineTo(tx2 - 9, zomGy - 20 - (k % 3) * 6);
      ctx.arc(tx2, zomGy - 20 - (k % 3) * 6, 9, Math.PI, 0);
      ctx.lineTo(tx2 + 9, zomGy);
      ctx.fill();
    }
    zomWalk.forEach((z, k) => {
      const x = (((z.x + r * z.v) % (W + 80)) + W + 80) % (W + 80) - 40;
      zombieWalker(x, z.v > 0 ? 1 : -1, z.s * Math.min(1.3, H / 280), r, k);
    });
    ctx.font = `${fs}px ${FONT}`;
    const held: { c: Cell; dy: number }[] = [];
    for (const { w, i, t0 } of wt) {
      const rr = r - t0;
      if (rr < 0) continue;
      const ty = w.cells[0].y;
      if (rr < ZOM_UP) {
        const q = ease(rr / ZOM_UP);
        const dy = (zomGy + fs * 0.6 - ty) * (1 - q);
        zombieHand(w.cx, zomGy + 6, ty + dy + fs * 0.8, r, i);
        for (const c of w.cells) held.push({ c, dy });
      } else {
        const e = rr - ZOM_UP;
        if (e < ZOM_BACK) zombieHand(w.cx, zomGy + 6, ty + fs * 0.8 + (zomGy + 14 - ty - fs * 0.8) * ease(e / ZOM_BACK), r, i);
        for (const c of w.cells) held.push({ c, dy: 0 });
      }
    }
    ctx.fillStyle = '#0b130e'; // the ground in front hides what is still underground
    ctx.fillRect(0, zomGy, W, H - zomGy);
    ctx.fillStyle = 'rgba(160,190,150,.07)'; // mist
    for (let k = 0; k < 5; k++) circ(((k * 0.23 + r * 0.00004) % 1.2) * W, zomGy - 6, 60);
    for (const h of held) {
      if (h.c.y + h.dy > zomGy) continue;
      textLit(h.c, '#e6ffd4', 'rgba(150,255,110,.85)', 9, h.c.x, h.c.y + h.dy);
    }
    fadeToFinal(r);
  };

  // Image destroyers: the scanned image / QR code is shown, then goes in one of several dramatic ways, and the
  // message is left in the middle of the screen.
  const fxImg = document.createElement('canvas');
  fxImg.width = Math.max(1, Math.round(iw));
  fxImg.height = Math.max(1, Math.round(ih));
  if (IMG_FX.includes(style)) fxImg.getContext('2d')!.drawImage(o.source, 0, 0, fxImg.width, fxImg.height);
  const fxW = fxImg.width;
  const fxH = fxImg.height;
  const fxCols: string[] = []; // the average colour of each 3-pixel column, for sand and drips
  if (style === 'sandfall' || style === 'melt' || style === 'rainwash') {
    try {
      const d = fxImg.getContext('2d')!.getImageData(0, 0, fxW, fxH).data;
      for (let x = 0; x < fxW; x += 3) {
        let rr = 0;
        let gg = 0;
        let bb = 0;
        let n = 0;
        for (let y = 0; y < fxH; y += 5) {
          const k = (y * fxW + x) * 4;
          rr += d[k];
          gg += d[k + 1];
          bb += d[k + 2];
          n++;
        }
        fxCols.push(`rgb(${Math.round(rr / n)},${Math.round(gg / n)},${Math.round(bb / n)})`);
      }
    } catch {
      /* a tainted image cannot be sampled: a sandy colour is used instead */
    }
  }
  const fxCol = (x: number) => fxCols[Math.min(fxCols.length - 1, Math.floor(x / 3))] ?? '#d8c08a';
  const fxP = (r: number) => clamp1(r / FX_DUR);
  const fxFade = (r: number) => clamp1((r + T_INTRO) / T_INTRO);
  const fxBg = (a: string, b: string) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };
  const fxText = (p: number) => { // the message comes up in the middle as the image goes
    const a = ease(clamp1((p - 0.5) / 0.45));
    if (a <= 0) return;
    ctx.font = `${fs}px ${FONT}`;
    for (const c of visible) textLit(c, '#e8fff4', 'rgba(80,255,190,.55)', 5, c.x, c.y, a);
  };
  const fxGrid = (size: number) => ({ n: Math.ceil(fxW / size), m: Math.ceil(fxH / size), size });

  // Dissolve: the picture breaks into little squares that each lift off as dust on the wind.
  const dsG = fxGrid(Math.max(5, Math.round(Math.min(fxW, fxH) / 38)));
  const dsT = Array.from({ length: dsG.n * dsG.m }, () => rnd());
  const drawDissolve = (r: number) => {
    fxBg('#121820', '#0b0f14');
    const p = fxP(r);
    const al = fxFade(r);
    const S = dsG.size;
    for (let j = 0; j < dsG.m; j++) {
      for (let i = 0; i < dsG.n; i++) {
        const t = dsT[j * dsG.n + i];
        const q = (p - t * 0.72) / 0.28;
        if (q >= 1) continue;
        const bx = i * S;
        const by = j * S;
        const bw = Math.min(S, fxW - bx);
        const bh = Math.min(S, fxH - by);
        if (q < 0) {
          ctx.globalAlpha = al;
          ctx.drawImage(fxImg, bx, by, bw, bh, ix + bx, iy + by, bw, bh);
        } else {
          ctx.globalAlpha = (1 - q) * al;
          const k = 1 - q * 0.5;
          ctx.drawImage(fxImg, bx, by, bw, bh, ix + bx + q * q * 70 * (0.6 + t), iy + by - q * 40 * t, bw * k, bh * k);
        }
      }
    }
    ctx.globalAlpha = 1;
    fxText(p);
    fadeToFinal(r);
  };

  // Sand: the picture pours away from the top down like sand through an hourglass, grains streaming down into a heap.
  const sdN = Math.ceil(fxW / 3);
  const sdOff = Array.from({ length: sdN }, () => rnd() * 0.3);
  const sdSp = Array.from({ length: sdN }, () => 0.6 + rnd() * 0.8);
  const drawSand = (r: number) => {
    fxBg('#1a1812', '#0d0c09');
    const p = fxP(r);
    const al = fxFade(r);
    const floor = iy + fxH;
    ctx.globalAlpha = al;
    for (let c = 0; c < sdN; c++) {
      const x = c * 3;
      const e = fxH * clamp1((p - sdOff[c]) / 0.62);
      if (e < fxH) ctx.drawImage(fxImg, x, e, Math.min(3, fxW - x), fxH - e, ix + x, iy + e, Math.min(3, fxW - x), fxH - e);
      if (e > 0 && e < fxH) { // grains streaming down from where the sand has gone
        ctx.fillStyle = fxCol(x);
        const top = iy + e;
        for (let k = 0; k < 3; k++) {
          const span = Math.max(8, floor - top);
          const y = top + (((r * 0.42 * sdSp[c] + k * 53 + c * 11) % span) + span) % span;
          ctx.fillRect(ix + x, y, 2, 3);
        }
      }
    }
    const heap = fxH * 0.2 * clamp1(p / 0.8) * (1 - clamp1((p - 0.86) / 0.14));
    for (let x = 0; x < fxW; x += 3) { // the heap at the bottom
      const u = (x - fxW / 2) / (fxW * 0.3);
      const h = heap * Math.exp(-u * u);
      ctx.fillStyle = fxCol(x);
      ctx.fillRect(ix + x, floor - h, 3, h);
    }
    ctx.globalAlpha = 1;
    fxText(p);
    fadeToFinal(r);
  };

  // Black hole: a hole opens in the middle and the picture is torn into a spiral and swallowed.
  const bhStars = Array.from({ length: 50 }, () => ({ x: rnd() * W, y: rnd() * H, s: 0.5 + rnd() * 1.2 }));
  const drawBlackHole = (r: number) => {
    fxBg('#06040e', '#0b0a1c');
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    for (const s of bhStars) circ(s.x, s.y, s.s);
    const p = fxP(r);
    const al = fxFade(r);
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.hypot(fxW, fxH) / 2;
    const N = 16;
    const sc2 = Math.max(0, 1 - p * 1.2);
    ctx.globalAlpha = al;
    if (sc2 > 0.01) {
      for (let k = 0; k < N; k++) {
        const r0 = (R * k) / N;
        const r1 = (R * (k + 1)) / N;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r1, 0, Math.PI * 2);
        ctx.arc(cx, cy, r0, 0, Math.PI * 2, true);
        ctx.clip();
        ctx.translate(cx, cy);
        ctx.rotate(p * 7 * Math.pow(1 - k / N, 1.3));
        ctx.scale(sc2, sc2);
        ctx.drawImage(fxImg, -fxW / 2, -fxH / 2);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    const hr = p < 0.86 ? 8 + 44 * ease(p / 0.86) : 52 * (1 - (p - 0.86) / 0.14);
    if (hr > 1) {
      const disk = ctx.createRadialGradient(cx, cy, hr * 0.8, cx, cy, hr * 2.2);
      disk.addColorStop(0, 'rgba(255,170,60,.85)');
      disk.addColorStop(0.5, 'rgba(180,70,220,.4)');
      disk.addColorStop(1, 'rgba(180,70,220,0)');
      ctx.fillStyle = disk;
      ctx.fillRect(cx - hr * 2.4, cy - hr * 2.4, hr * 4.8, hr * 4.8);
      ctx.fillStyle = '#000';
      circ(cx, cy, hr);
      ctx.strokeStyle = `rgba(255,200,120,${0.7})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, hr * 1.5, hr * 0.5, r / 400, 0, Math.PI * 2);
      ctx.stroke();
    }
    fxText(p);
    fadeToFinal(r);
  };

  // Hammer smash: a huge hammer slams down on the picture, it cracks and bursts into pieces that fly in every direction.
  const hsG = fxGrid(Math.max(10, Math.round(Math.min(fxW, fxH) / 9)));
  const hsT = Array.from({ length: hsG.n * hsG.m }, (_, k) => {
    const i = k % hsG.n;
    const j = Math.floor(k / hsG.n);
    const dx = (i + 0.5) * hsG.size - fxW / 2;
    const dy = (j + 0.5) * hsG.size - fxH / 2;
    const d = Math.hypot(dx, dy) || 1;
    return { vx: (dx / d) * (1.2 + rnd() * 3.2) + (rnd() - 0.5), vy: (dy / d) * (1.2 + rnd() * 3.2) - 2.2 - rnd() * 2, rot: (rnd() - 0.5) * 0.35 };
  });
  const HS_AT = 0.3; // the moment of impact
  const drawHammerSmash = (r: number) => {
    fxBg('#161318', '#0c0a0e');
    const p = fxP(r);
    const al = fxFade(r);
    const rI = HS_AT * FX_DUR;
    const tt = Math.max(0, r - rI) / 16; // frames since impact
    const shake = r > rI && r < rI + 320 ? (1 - (r - rI) / 320) * 7 : 0;
    ctx.save();
    ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    ctx.globalAlpha = al;
    const S = hsG.size;
    for (let j = 0; j < hsG.m; j++) {
      for (let i = 0; i < hsG.n; i++) {
        const t = hsT[j * hsG.n + i];
        const bx = i * S;
        const by = j * S;
        const bw = Math.min(S, fxW - bx);
        const bh = Math.min(S, fxH - by);
        if (r < rI) {
          ctx.drawImage(fxImg, bx, by, bw, bh, ix + bx, iy + by, bw, bh);
          continue;
        }
        const a2 = 1 - clamp1((tt * 16 - 1000) / 450);
        if (a2 <= 0) continue;
        ctx.save();
        ctx.globalAlpha = al * a2;
        ctx.translate(ix + bx + bw / 2 + t.vx * tt, iy + by + bh / 2 + t.vy * tt + 0.5 * 0.13 * tt * tt);
        ctx.rotate(t.rot * tt);
        ctx.drawImage(fxImg, bx, by, bw, bh, -bw / 2, -bh / 2, bw, bh);
        ctx.restore();
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    const cx = W / 2;
    const cy = H / 2;
    if (r >= 0 && r < rI + 500) { // the hammer swings in, hits and lifts away
      const q = clamp1(r / rI);
      const out = r > rI + 150 ? clamp1((r - rI - 150) / 350) : 0;
      const hx = W * 0.92 + (cx - W * 0.92) * q * q * (1 - 0) + out * 40;
      const hy = -50 + (cy - 22 + 50) * q * q - out * (cy + 80);
      hammer(hx, hy, Math.PI + (1 - q) * 1.0, Math.min(3.4, Math.max(2, H / 100)));
    }
    if (r > rI && r < rI + 260) { // the flash and the cracks
      const f = 1 - (r - rI) / 260;
      ctx.fillStyle = `rgba(255,255,255,${0.5 * f})`;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = `rgba(255,255,255,${f})`;
      ctx.lineWidth = 2;
      for (let k = 0; k < 9; k++) {
        const a = (k / 9) * Math.PI * 2 + 0.3;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        let px = cx;
        let py = cy;
        for (let s = 1; s <= 6; s++) {
          px += Math.cos(a + Math.sin(k * 7 + s) * 0.4) * Math.min(fxW, fxH) * 0.09;
          py += Math.sin(a + Math.sin(k * 7 + s) * 0.4) * Math.min(fxW, fxH) * 0.09;
          ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
    fxText(p);
    fadeToFinal(r);
  };

  // Shatter: cracks race across the picture like glass, then every triangular shard drops away.
  const shN = 7;
  const shPts = Array.from({ length: (shN + 1) * (shN + 1) }, (_, k) => {
    const i = k % (shN + 1);
    const j = Math.floor(k / (shN + 1));
    const edge = i === 0 || j === 0 || i === shN || j === shN;
    return { x: (i / shN) * fxW + (edge ? 0 : (rnd() - 0.5) * (fxW / shN) * 0.6), y: (j / shN) * fxH + (edge ? 0 : (rnd() - 0.5) * (fxH / shN) * 0.6) };
  });
  const shHit = { x: fxW * (0.35 + rnd() * 0.3), y: fxH * (0.35 + rnd() * 0.3) };
  const shTris: { a: { x: number; y: number }; b: { x: number; y: number }; c: { x: number; y: number }; d: number; vx: number; sp: number }[] = [];
  for (let j = 0; j < shN; j++) {
    for (let i = 0; i < shN; i++) {
      const p00 = shPts[j * (shN + 1) + i];
      const p10 = shPts[j * (shN + 1) + i + 1];
      const p01 = shPts[(j + 1) * (shN + 1) + i];
      const p11 = shPts[(j + 1) * (shN + 1) + i + 1];
      for (const [a, b, c] of [[p00, p10, p01], [p10, p11, p01]]) {
        const mx = (a.x + b.x + c.x) / 3;
        const my = (a.y + b.y + c.y) / 3;
        shTris.push({ a, b, c, d: Math.hypot(mx - shHit.x, my - shHit.y) / Math.hypot(fxW, fxH), vx: (rnd() - 0.5) * 2.4, sp: (rnd() - 0.5) * 0.12 });
      }
    }
  }
  const drawShatter = (r: number) => {
    fxBg('#10161e', '#0a0d12');
    const p = fxP(r);
    const al = fxFade(r);
    for (const t of shTris) {
      const rel = (p - 0.16 - t.d * 0.3) / 0.45; // each shard lets go in a wave from the impact point
      if (rel >= 1) continue;
      const mx = (t.a.x + t.b.x + t.c.x) / 3;
      const my = (t.a.y + t.b.y + t.c.y) / 3;
      const fall = Math.max(0, rel) * (FX_DUR * 0.45) / 16;
      ctx.save();
      ctx.globalAlpha = al * (1 - clamp1((rel - 0.6) / 0.4));
      ctx.translate(ix + mx + t.vx * fall, iy + my + 0.5 * 0.1 * fall * fall);
      ctx.rotate(t.sp * fall);
      ctx.translate(-mx, -my);
      ctx.beginPath();
      ctx.moveTo(t.a.x, t.a.y);
      ctx.lineTo(t.b.x, t.b.y);
      ctx.lineTo(t.c.x, t.c.y);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(fxImg, 0, 0);
      if (rel < 0) { // the cracks, spreading out from the impact point
        const reach = clamp1(p / 0.16);
        if (t.d < reach * 0.9) {
          ctx.strokeStyle = 'rgba(255,255,255,.8)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    fxText(p);
    fadeToFinal(r);
  };

  // Burn away: a fire creeps across the picture from one corner, charring it to ash.
  const bnG = fxGrid(Math.max(5, Math.round(Math.min(fxW, fxH) / 38)));
  const bnT = Array.from({ length: bnG.n * bnG.m }, (_, k) => {
    const i = k % bnG.n;
    const j = Math.floor(k / bnG.n);
    return ((1 - j / bnG.m) * 0.5 + (i / bnG.n) * 0.5) * 0.74 + rnd() * 0.1;
  });
  const drawBurn = (r: number) => {
    fxBg('#1a1210', '#0c0807');
    const p = fxP(r);
    const al = fxFade(r);
    const S = bnG.size;
    for (let j = 0; j < bnG.m; j++) {
      for (let i = 0; i < bnG.n; i++) {
        const q = (p - bnT[j * bnG.n + i]) / 0.2;
        if (q >= 1) continue;
        const bx = i * S;
        const by = j * S;
        const bw = Math.min(S, fxW - bx);
        const bh = Math.min(S, fxH - by);
        ctx.globalAlpha = al;
        ctx.drawImage(fxImg, bx, by, bw, bh, ix + bx, iy + by, bw, bh);
        if (q > 0) {
          ctx.fillStyle = `rgba(20,12,8,${Math.min(0.92, q * 1.6)})`; // charring
          ctx.fillRect(ix + bx, iy + by, bw, bh);
          if (q < 0.5) {
            ctx.fillStyle = `rgba(255,${Math.round(150 + 80 * (q * 2))},40,${0.85 * (1 - q * 2)})`; // the glowing edge
            ctx.fillRect(ix + bx, iy + by, bw, bh);
            ctx.fillStyle = `rgba(255,${Math.round(200 - 60 * q)},60,${0.7 * (1 - q * 2)})`; // a flame
            circ(ix + bx + bw / 2 + Math.sin(r / 80 + i) * 2, iy + by - q * 22, 2.4 + 2 * (1 - q));
          }
        }
      }
    }
    ctx.globalAlpha = 1;
    fxText(p);
    fadeToFinal(r);
  };

  // Shredder: the picture is cut into strips that are pulled down through a slot at the bottom, one after another.
  const rdN = Math.max(12, Math.round(fxW / 8));
  const rdW = fxW / rdN;
  const rdT = Array.from({ length: rdN }, (_, k) => (k / rdN) * 0.5 + rnd() * 0.06);
  const drawShredder = (r: number) => {
    fxBg('#14181e', '#0b0d11');
    const p = fxP(r);
    const al = fxFade(r);
    ctx.globalAlpha = al;
    for (let k = 0; k < rdN; k++) {
      const q = (p - rdT[k]) / 0.4;
      if (q >= 1) continue;
      const off = q > 0 ? q * q * (fxH + 40) : 0;
      const sway = q > 0 ? Math.sin(q * 9 + k) * 4 * q : 0;
      ctx.drawImage(fxImg, k * rdW, 0, rdW, fxH, ix + k * rdW + sway, iy + off, rdW - 0.5, fxH);
    }
    ctx.globalAlpha = 1;
    const slot = H - 10;
    ctx.fillStyle = '#05070a'; // the shredder's blade housing
    ctx.fillRect(0, slot, W, H - slot);
    ctx.fillStyle = '#7d8793';
    for (let x = 0; x < W; x += 9) ctx.fillRect(x, slot - 3, 5, 3);
    fxText(p);
    fadeToFinal(r);
  };

  // Melt: the picture droops and runs down in drips and pools at the bottom.
  const mtN = Math.ceil(fxW / 3);
  const mtK = Array.from({ length: mtN }, (_, c) => 0.45 + 0.55 * Math.abs(Math.sin(c * 0.37) * Math.cos(c * 0.11)) + rnd() * 0.25);
  const drawMelt = (r: number) => {
    fxBg('#1a1420', '#0e0a12');
    const p = fxP(r);
    const al = fxFade(r) * (1 - clamp1((p - 0.84) / 0.16));
    const floor = iy + fxH;
    ctx.globalAlpha = al;
    for (let c = 0; c < mtN; c++) {
      const x = c * 3;
      const d = Math.pow(clamp1(p / 0.88), 1.7) * fxH * mtK[c];
      const h = Math.max(0, fxH - d * 0.6);
      if (h > 0) ctx.drawImage(fxImg, x, 0, Math.min(3, fxW - x), fxH, ix + x, iy + d, Math.min(3, fxW - x), Math.min(h + d * 0.2, floor + 10 - iy - d));
      ctx.fillStyle = fxCol(x); // the drips and the puddle
      const pool = Math.min(14, 2 + d * 0.06);
      ctx.fillRect(ix + x, floor - pool, 3, pool);
    }
    ctx.globalAlpha = 1;
    fxText(p);
    fadeToFinal(r);
  };

  // Rain wash: it starts to rain and the picture's colours run and wash away, streaking down into a puddle.
  const rwN = Math.ceil(fxW / 3);
  const rwOff = Array.from({ length: rwN }, () => rnd() * 0.3);
  const rwLen = Array.from({ length: rwN }, () => 0.35 + rnd() * 0.65);
  const rwDrops = Array.from({ length: 150 }, () => ({ x: rnd() * W, y: rnd() * H, v: 0.9 + rnd() * 0.7, l: 10 + rnd() * 14 }));
  const drawRainWash = (r: number) => {
    fxBg('#1b2634', '#0b1118');
    const p = fxP(r);
    const al = fxFade(r);
    const floor = iy + fxH;
    ctx.globalAlpha = al;
    for (let c = 0; c < rwN; c++) {
      const x = c * 3;
      const w = Math.min(3, fxW - x);
      const e = fxH * clamp1((p - rwOff[c]) / 0.6); // how far down this column has been washed
      if (e < fxH) ctx.drawImage(fxImg, x, e, w, fxH - e, ix + x, iy + e, w, fxH - e);
      if (e > 0 && e < fxH) { // the colour running down the wet picture
        const sl = Math.min(e, fxH * rwLen[c] * 0.5);
        ctx.fillStyle = fxCol(x);
        for (let k = 0; k < 4; k++) {
          ctx.globalAlpha = al * (0.14 + 0.18 * k);
          ctx.fillRect(ix + x, iy + e - sl * (1 - k / 4), w, sl / 4 + 1);
        }
        ctx.globalAlpha = al;
      }
    }
    const pool = (1 - clamp1((p - 0.88) / 0.12)) * clamp1(p / 0.5); // the coloured puddle at the bottom
    for (let x = 0; x < fxW; x += 3) {
      ctx.globalAlpha = al * 0.65 * pool;
      ctx.fillStyle = fxCol(x);
      ctx.fillRect(ix + x, floor - 6 - Math.sin(x / 9 + r / 160) * 1.5, 3, 7 + 6 * pool);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(175,205,235,.5)'; // the rain
    ctx.lineWidth = 1;
    const shown = Math.floor(rwDrops.length * clamp1((r + T_INTRO) / (T_INTRO + 400)));
    for (let k = 0; k < shown; k++) {
      const d = rwDrops[k];
      const y = (((d.y + r * d.v * 0.95) % (H + 30)) + H + 30) % (H + 30) - 15;
      ctx.beginPath();
      ctx.moveTo(d.x, y);
      ctx.lineTo(d.x - 2.5, y + d.l);
      ctx.stroke();
    }
    fxText(p);
    fadeToFinal(r);
  };

  // Acid rain: green acid rain eats holes in the picture, which fizz and spread until it has dissolved away in smoke.
  const acN = 64;
  const acHoles = Array.from({ length: acN }, (_, i) => ({ x: rnd() * fxW, y: rnd() * fxH, s: (i / acN) * 0.6 + rnd() * 0.06, R: Math.max(fxW, fxH) * (0.1 + rnd() * 0.07) }));
  const acC = document.createElement('canvas');
  acC.width = fxW;
  acC.height = fxH;
  const acDrops = Array.from({ length: 110 }, () => ({ x: rnd() * W, y: rnd() * H, v: 0.9 + rnd() * 0.7, l: 8 + rnd() * 12 }));
  const drawAcid = (r: number) => {
    fxBg('#0f1a12', '#070c08');
    const p = fxP(r);
    const al = fxFade(r);
    const a2 = acC.getContext('2d')!;
    a2.globalCompositeOperation = 'source-over';
    a2.clearRect(0, 0, fxW, fxH);
    a2.drawImage(fxImg, 0, 0);
    a2.globalCompositeOperation = 'destination-out';
    a2.fillStyle = '#000';
    for (const h of acHoles) {
      const q = clamp1((p - h.s) / 0.3);
      if (q <= 0) continue;
      a2.beginPath();
      a2.arc(h.x, h.y, h.R * ease(q), 0, Math.PI * 2);
      a2.fill();
    }
    ctx.globalAlpha = al * (1 - clamp1((p - 0.9) / 0.1));
    ctx.drawImage(acC, ix, iy);
    ctx.globalAlpha = 1;
    for (const h of acHoles) { // the fizzing green edge of each hole, and the smoke rising from it
      const q = clamp1((p - h.s) / 0.3);
      if (q <= 0 || q >= 1) continue;
      ctx.strokeStyle = `rgba(160,255,70,${0.8 * (1 - q * 0.7)})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(ix + h.x, iy + h.y, h.R * ease(q) + 1, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const h of acHoles) {
      const age = (p - h.s) * FX_DUR;
      if (age <= 0 || age > 1500) continue;
      for (let k = 0; k < 3; k++) {
        ctx.fillStyle = `rgba(${150 + k * 20},${190 + k * 10},${140 + k * 10},${0.34 * (1 - age / 1500)})`;
        circ(ix + h.x + Math.sin(age / 170 + k * 2 + h.x) * 12, iy + h.y - age * 0.05 * (k + 1) - k * 4, 6 + age * 0.012 * (k + 1));
      }
    }
    ctx.strokeStyle = 'rgba(150,255,90,.55)'; // the acid rain
    ctx.lineWidth = 1.4;
    const shown = Math.floor(acDrops.length * clamp1((r + T_INTRO) / (T_INTRO + 300)));
    for (let k = 0; k < shown; k++) {
      const d = acDrops[k];
      const y = (((d.y + r * d.v * 0.95) % (H + 30)) + H + 30) % (H + 30) - 15;
      ctx.beginPath();
      ctx.moveTo(d.x, y);
      ctx.lineTo(d.x - 2, y + d.l);
      ctx.stroke();
    }
    fxText(p);
    fadeToFinal(r);
  };

  // Ice: the picture is frozen in a block of ice. A blowtorch sweeps across it in rows, melting the ice into drips and a
  // puddle, and the freed picture flops forward and slides away, leaving the message.
  const icePad = 10;
  const iceCell = Math.max(5, Math.round(Math.min(fxW, fxH) / 34));
  const iceN = Math.ceil((fxW + icePad * 2) / iceCell);
  const iceM = Math.ceil((fxH + icePad * 2) / iceCell);
  const ICE_FROM = 0.04; // the torch lights the ice here...
  const ICE_TO = 0.5; // ...and the ice is all gone here
  const icePt = { x: ix - icePad + 3, y: iy + fxH * 0.25 }; // the one place on the side of the block where the flame is held
  const iceMax = Math.hypot(fxW + icePad * 2, fxH * 0.75 + icePad);
  const iceMelt = new Float32Array(iceN * iceM); // when the melting reaches each bit of ice: outwards from the flame
  for (let j = 0; j < iceM; j++) {
    for (let i = 0; i < iceN; i++) {
      const cx = ix - icePad + (i + 0.5) * iceCell;
      const cy = iy - icePad + (j + 0.5) * iceCell;
      const d = Math.hypot(cx - icePt.x, cy - icePt.y) / iceMax;
      iceMelt[j * iceN + i] = ICE_FROM + (ICE_TO - ICE_FROM - 0.04) * Math.pow(d, 0.9) + Math.sin(i * 1.7 + j * 2.3) * 0.006;
    }
  }
  const iceThick = (k: number, p: number) => (iceMelt[k] < 0 ? 1 : 1 - clamp1((p - iceMelt[k]) / 0.1));
  const ICE_SC = 0.76; // the block is drawn a little smaller and to the right, to leave room on the left for the torch and the hand
  const iceShift = fxW * 0.2;
  const drawIce = (r: number) => {
    fxBg('#1b2530', '#0d1218');
    ctx.save();
    ctx.translate(iceShift + (ix + fxW / 2) * (1 - ICE_SC), (iy + fxH / 2) * (1 - ICE_SC));
    ctx.scale(ICE_SC, ICE_SC);
    const p = fxP(r);
    const al = fxFade(r);
    const bx = ix - icePad;
    const by = iy - icePad;
    const bW = fxW + icePad * 2;
    const bH = fxH + icePad * 2;
    let thickSum = 0;
    for (let k = 0; k < iceN * iceM; k++) thickSum += iceThick(k, p);
    const avg = thickSum / (iceN * iceM);
    const bottom = iy + fxH;
    // the puddle spreading from the melting block
    const pool = clamp1(1 - avg) * (1 - clamp1((p - 0.9) / 0.1));
    if (pool > 0) {
      ctx.fillStyle = `rgba(140,195,240,${0.55 * pool})`;
      ctx.beginPath();
      ctx.ellipse(W / 2, bottom + icePad * 0.5, (bW / 2) * (0.5 + 0.55 * pool), 5 + 7 * pool, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // the picture: stays put until the ice is gone, then flops forward onto its face and slides away
    const fl = clamp1((p - 0.58) / 0.34);
    ctx.globalAlpha = al * (1 - clamp1((fl - 0.78) / 0.22));
    if (fl <= 0) {
      ctx.drawImage(fxImg, ix, iy);
    } else {
      const th = (Math.PI / 2) * Math.min(1, fl * fl * 1.15);
      ctx.save();
      ctx.translate(ix + fxW / 2, bottom + fl * fl * 18);
      ctx.rotate(Math.sin(fl * 16) * 0.05 * (1 - fl));
      ctx.scale(1 - 0.12 * Math.sin(th), Math.max(0.03, Math.cos(th)));
      ctx.drawImage(fxImg, -fxW / 2, -fxH);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    if (avg > 0.002) {
      ctx.globalAlpha = al;
      for (let j = 0; j < iceM; j++) {
        for (let i = 0; i < iceN; i++) {
          const th = iceThick(j * iceN + i, p);
          if (th <= 0.01) continue;
          const x = bx + i * iceCell;
          const y = by + j * iceCell;
          const w = Math.min(iceCell, bx + bW - x);
          const h = Math.min(iceCell, by + bH - y);
          if (w <= 0 || h <= 0) continue;
          ctx.fillStyle = `rgba(${150 + 40 * (1 - th)},${205 + 20 * (1 - th)},255,${0.12 + 0.4 * th})`;
          ctx.fillRect(x, y, w + 0.5, h + 0.5);
          if (th < 0.6) { // wet, glistening edges as it thins
            ctx.fillStyle = `rgba(235,248,255,${0.35 * (1 - th)})`;
            ctx.fillRect(x, y, w, 1.2);
          }
        }
      }
      ctx.strokeStyle = `rgba(230,246,255,${0.6 * avg})`; // the block's edge, gloss and cracks
      ctx.lineWidth = 2;
      ctx.strokeRect(bx + 1, by + 1, bW - 2, bH - 2);
      ctx.strokeStyle = `rgba(255,255,255,${0.3 * avg})`;
      ctx.lineWidth = 1;
      for (const [x1, y1, x2, y2] of [[0.15, 0, 0.35, 0.4], [0.35, 0.4, 0.28, 0.75], [0.7, 0.1, 0.62, 0.5], [0.62, 0.5, 0.8, 0.9]]) {
        ctx.beginPath();
        ctx.moveTo(bx + x1 * bW, by + y1 * bH);
        ctx.lineTo(bx + x2 * bW, by + y2 * bH);
        ctx.stroke();
      }
      ctx.fillStyle = `rgba(255,255,255,${0.12 * avg})`;
      ctx.beginPath();
      ctx.moveTo(bx + bW * 0.08, by);
      ctx.lineTo(bx + bW * 0.28, by);
      ctx.lineTo(bx + bW * 0.05, by + bH);
      ctx.lineTo(bx, by + bH);
      ctx.lineTo(bx, by + bH * 0.5);
      ctx.fill();
      ctx.globalAlpha = 1;
      for (let i = 0; i < iceN; i++) { // drips running off the melted bottom edge
        const th = iceThick((iceM - 1) * iceN + i, p);
        if (th > 0.7 || th <= 0) continue;
        const dx = bx + (i + 0.5) * iceCell;
        const ph = (r * 0.18 + i * 53) % 46;
        ctx.fillStyle = 'rgba(170,215,250,.75)';
        ctx.beginPath();
        ctx.ellipse(dx, bottom + icePad + ph, 1.7, 2.8 + ph * 0.05, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    const tp = { x: iceShift + (ix + fxW / 2) * (1 - ICE_SC) + icePt.x * ICE_SC, y: (iy + fxH / 2) * (1 - ICE_SC) + icePt.y * ICE_SC }; // where the flame is on the stage
    if (p >= ICE_FROM - 0.02 && p <= ICE_TO + 0.05) { // a hand-held propane torch, kept in one place against the side of the block
      const out = clamp1((p - ICE_TO) / 0.05); // snuffed and pulled away once the ice has gone
      const th = -0.5; // the torch points up and to the right, so the hand and arm trail down to the left
      const ux = Math.cos(th);
      const uy = Math.sin(th);
      const nx = tp.x - ux * 48 - out * 34;
      const ny = tp.y - uy * 48 + out * 24;
      ctx.save();
      ctx.translate(nx, ny);
      ctx.rotate(th);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#34495e'; // the sleeve, going off the edge of the stage
      ctx.lineWidth = 36;
      ctx.beginPath();
      ctx.moveTo(-44, 70);
      ctx.lineTo(-44, 240);
      ctx.stroke();
      ctx.fillStyle = '#e8b923'; // the propane bottle, in line with the torch
      ctx.strokeStyle = '#7a5d10';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(-172, -13, 80, 26, 7);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(-170, -13, 8, 26);
      ctx.fillStyle = '#9aa5b1'; // the barrel
      ctx.fillRect(-80, -5, 68, 10);
      ctx.fillStyle = '#c7a24a'; // the brass valve block and burner head
      ctx.fillRect(-94, -9, 14, 18);
      ctx.beginPath();
      ctx.moveTo(-14, -8);
      ctx.lineTo(0, -4.5);
      ctx.lineTo(0, 4.5);
      ctx.lineTo(-14, 8);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#b03a2e'; // the gas knob
      ctx.beginPath();
      ctx.arc(-87, -14, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2c3038'; // the rubber grip the hand holds
      ctx.beginPath();
      ctx.roundRect(-76, -8.5, 52, 17, 4);
      ctx.fill();
      const skin = (x0: number, x1: number) => { // skin shaded across a part: light on one side, darker on the other
        const g = ctx.createLinearGradient(x0, 0, x1, 0);
        g.addColorStop(0, '#d9a47c');
        g.addColorStop(0.35, '#efc3a0');
        g.addColorStop(1, '#c48a63');
        return g;
      };
      ctx.strokeStyle = '#8c5a3c';
      ctx.lineWidth = 1.3;
      ctx.fillStyle = skin(-72, -26); // the forearm and the back of the hand
      ctx.beginPath();
      ctx.moveTo(-60, 70);
      ctx.bezierCurveTo(-63, 40, -76, 28, -73, 6);
      ctx.lineTo(-27, 6);
      ctx.bezierCurveTo(-25, 28, -31, 40, -30, 70);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(140,90,60,.35)'; // tendons on the back of the hand
      ctx.lineWidth = 1;
      for (const tx of [-60, -50, -40]) {
        ctx.beginPath();
        ctx.moveTo(tx, 14);
        ctx.quadraticCurveTo(tx + 1, 38, tx - (tx + 50) * 0.08, 52);
        ctx.stroke();
      }
      ctx.fillStyle = '#3d5a80'; // the rolled sleeve
      ctx.strokeStyle = '#243850';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(-70, 62, 46, 16, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.18)';
      ctx.fillRect(-68, 64, 42, 4);
      const fingers: [number, number, number, number][] = [[-71, 9.5, -16, 16], [-61.5, 10.5, -19, 18], [-51, 11, -20, 19], [-40, 11, -19, 18]]; // pinky to index: x, width, top, bottom
      for (const [fx, fw, ft, fb] of fingers) { // four fingers wrapped round the grip, with their joints
        ctx.fillStyle = skin(fx, fx + fw);
        ctx.strokeStyle = '#8c5a3c';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.roundRect(fx, ft, fw, fb - ft, fw / 2);
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = 'rgba(120,70,45,.55)';
        ctx.lineWidth = 1;
        for (const f of [0.34, 0.66]) {
          const cy = ft + (fb - ft) * f;
          ctx.beginPath();
          ctx.moveTo(fx + 1.5, cy);
          ctx.quadraticCurveTo(fx + fw / 2, cy + 1.6, fx + fw - 1.5, cy);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(255,238,220,.45)'; // the knuckle catching the light
        ctx.beginPath();
        ctx.ellipse(fx + fw * 0.4, fb - 5, fw * 0.28, 3, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = skin(-62, -26); // the thumb along the top of the grip, with its nail
      ctx.strokeStyle = '#8c5a3c';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.roundRect(-64, -29, 40, 12, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#f7ddcb';
      ctx.strokeStyle = 'rgba(140,90,60,.6)';
      ctx.beginPath();
      ctx.ellipse(-30, -23, 6, 3.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(120,70,45,.5)';
      ctx.beginPath();
      ctx.moveTo(-47, -28);
      ctx.quadraticCurveTo(-46, -23, -47, -18);
      ctx.stroke();
      if (out < 1) {
        const Lf = (48 + 10) * (1 - out);
        const flick = 1 + Math.sin(r / 31) * 0.1 + Math.sin(r / 13) * 0.05;
        const fg = ctx.createLinearGradient(0, 0, Lf, 0);
        fg.addColorStop(0, 'rgba(120,175,255,.95)');
        fg.addColorStop(0.35, 'rgba(255,225,140,.9)');
        fg.addColorStop(1, 'rgba(255,120,30,.0)');
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.moveTo(0, -4);
        ctx.quadraticCurveTo(Lf * 0.55 * flick, -13, Lf * flick, 0);
        ctx.quadraticCurveTo(Lf * 0.55 * flick, 13, 0, 4);
        ctx.fill();
      }
      ctx.restore();
      if (out < 1) {
        const g = ctx.createRadialGradient(tp.x, tp.y, 2, tp.x, tp.y, 34);
        g.addColorStop(0, 'rgba(255,240,200,.9)');
        g.addColorStop(0.4, 'rgba(255,170,60,.5)');
        g.addColorStop(1, 'rgba(255,120,30,0)');
        ctx.fillStyle = g;
        circ(tp.x, tp.y, 34);
        const rm = ICE_SC * iceMax * Math.pow(clamp1((p - ICE_FROM) / (ICE_TO - ICE_FROM - 0.04)), 1.1); // steam off the edge of the melted patch
        for (let k = 0; k < 6; k++) {
          const age = (Math.max(0, r) * 0.06 + k * 11) % 56;
          const a = -1.2 + k * 0.45;
          ctx.fillStyle = `rgba(225,238,248,${0.4 * (1 - age / 56)})`;
          circ(tp.x + Math.cos(a) * rm * 0.8 + Math.sin(age / 7 + k * 2) * 8, tp.y + Math.sin(a) * rm * 0.5 - age, 5 + age * 0.12);
        }
      }
    }
    fxText(0.5 + 0.45 * clamp1((p - 0.78) / 0.2));
    fadeToFinal(r);
  };

  // Shaken apart: the picture judders harder and harder, loosening into pieces that drop away and tumble off.
  const skG = fxGrid(Math.max(6, Math.round(Math.min(fxW, fxH) / 22)));
  const skT = Array.from({ length: skG.n * skG.m }, () => ({ at: 0.34 + rnd() * 0.36, vx: (rnd() - 0.5) * 5, vy: -1 + rnd() * 1.5, sp: (rnd() - 0.5) * 0.5 }));
  const drawShaken = (r: number) => {
    fxBg('#161a22', '#0b0d12');
    const p = fxP(r);
    const al = fxFade(r);
    const S = skG.size;
    const amp = 2 + 16 * clamp1(p / 0.5);
    const shk = p < 0.75 ? 1 : 0;
    const jx = Math.sin(r / 23) * amp * shk;
    const jy = Math.cos(r / 17) * amp * 0.6 * shk;
    ctx.globalAlpha = al;
    for (let j = 0; j < skG.m; j++) {
      for (let i = 0; i < skG.n; i++) {
        const t = skT[j * skG.n + i];
        const bx = i * S;
        const by = j * S;
        const bw = Math.min(S, fxW - bx);
        const bh = Math.min(S, fxH - by);
        const rel = (p - t.at) / 0.3;
        if (rel >= 1) continue;
        let dx = ix + bx + jx + Math.sin(r / 9 + i * 3 + j) * amp * 0.25;
        let dy = iy + by + jy + Math.cos(r / 11 + j * 2 + i) * amp * 0.25;
        let ang = 0;
        if (rel > 0) { // let go: fall and tumble
          const f = rel * 24;
          dx += t.vx * f;
          dy += t.vy * f + 0.5 * 0.55 * f * f;
          ang = t.sp * f;
        }
        ctx.save();
        ctx.globalAlpha = al * (1 - clamp1((rel - 0.55) / 0.45));
        ctx.translate(dx + bw / 2, dy + bh / 2);
        ctx.rotate(ang);
        ctx.drawImage(fxImg, bx, by, bw, bh, -bw / 2, -bh / 2, bw, bh);
        if (rel <= 0 && p > 0.15) { // hairline cracks between the tiles as the strain builds
          ctx.strokeStyle = `rgba(10,10,14,${Math.min(0.55, (p - 0.15) * 1.4)})`;
          ctx.lineWidth = 1;
          ctx.strokeRect(-bw / 2 + 0.5, -bh / 2 + 0.5, bw - 1, bh - 1);
        }
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    for (let k = 0; k < 6 && p < 0.7; k++) { // dust shaken loose from the base
      const age = (Math.max(0, r) * 0.05 + k * 17) % 40;
      ctx.fillStyle = `rgba(190,190,200,${0.35 * (1 - age / 40) * clamp1(p / 0.3)})`;
      circ(ix + ((k * 97) % fxW), iy + fxH + age * 0.6, 2 + age * 0.08);
    }
    fxText(p);
    fadeToFinal(r);
  };

  // Foot: a giant cartoon cut-out foot drops out of the sky and stamps the picture flat, then lifts away.
  const ftW = Math.max(150, fxW * 0.85);
  const ftHit = 0.4; // the moment of the stomp
  const ftChips = Array.from({ length: 18 }, () => ({ a: -Math.PI * (0.1 + rnd() * 0.8), v: 3 + rnd() * 6, s: 2 + rnd() * 4 }));
  const ftSole = (p: number) => { // the height of the foot's toe line
    const hi = -30;
    const lo = iy + fxH;
    if (p < ftHit) return hi + (lo - hi) * (clamp1(p / ftHit) ** 2.2);
    if (p < 0.58) return lo;
    return lo + (hi - lo) * ease(clamp1((p - 0.58) / 0.27));
  };
  const drawFoot = (r: number) => {
    fxBg('#1d1a2a', '#0e0c16');
    const p = fxP(r);
    const al = fxFade(r);
    const sole = ftSole(p);
    const bottom = iy + fxH;
    const since = clamp1((p - ftHit) / 0.12);
    ctx.save();
    if (p >= ftHit && p < ftHit + 0.14) { // the whole stage jolts at the impact
      const k = (1 - (p - ftHit) / 0.14) * 9;
      ctx.translate(Math.sin(r / 13) * k, Math.cos(r / 9) * k);
    }
    // the picture: squashed under the sole, bulging out at the sides, and left a flat stain that fades
    const pressed = Math.max(0.05, (bottom - Math.max(iy, sole)) / fxH);
    const stain = 1 - clamp1((p - 0.72) / 0.2);
    ctx.globalAlpha = al * stain;
    const sq = p < ftHit ? pressed : 0.05;
    const bulge = 1 + (1 - sq) * 0.14 * (p < ftHit ? 1 : 1 + since * 0.6);
    ctx.save();
    ctx.translate(ix + fxW / 2, bottom);
    ctx.scale(bulge, sq);
    ctx.drawImage(fxImg, -fxW / 2, -fxH);
    ctx.restore();
    if (p >= ftHit && stain > 0) { // cracks splitting out across the flattened picture
      ctx.strokeStyle = 'rgba(255,255,255,.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 0; k < 7; k++) {
        const a = Math.PI * (k / 6);
        ctx.moveTo(ix + fxW / 2, bottom - 2);
        ctx.lineTo(ix + fxW / 2 - Math.cos(a) * fxW * 0.55 * since, bottom - 2 - Math.sin(a) * 6 * since);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // chips and dust thrown out from under the foot
    if (p >= ftHit && p < 0.8) {
      const q = clamp1((p - ftHit) / 0.3);
      for (const c of ftChips) {
        ctx.fillStyle = `rgba(210,210,225,${0.8 * (1 - q)})`;
        const cx = ix + fxW / 2 + Math.cos(c.a) * c.v * q * 40;
        const cy = bottom + Math.sin(c.a) * c.v * q * 40 + 90 * q * q;
        ctx.fillRect(cx, cy, c.s, c.s);
      }
      for (let side = -1; side <= 1; side += 2) {
        for (let k = 0; k < 4; k++) {
          ctx.fillStyle = `rgba(170,165,185,${0.4 * (1 - q)})`;
          circ(ix + fxW / 2 + side * (fxW * 0.45 + q * (30 + k * 18)), bottom - q * (8 + k * 9), Math.max(0, 6 + k * 3 + q * 14));
        }
      }
    }
    // the foot itself: a big foot seen from the side, toes to the right, shaded like skin, with its leg going up off the stage
    const L = ftW * 1.3;
    const cx = ix + fxW / 2;
    const yTop = Math.min(-0.45, (-14 - sole) / L);
    if (sole - 0.42 * L > -14 - L) {
      ctx.save();
      ctx.translate(cx, sole);
      ctx.scale(L, L);
      ctx.lineWidth = 2 / L;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#7a4f38';
      const body = ctx.createLinearGradient(0, -0.3, 0, 0.01); // lit from above, in shade underneath
      body.addColorStop(0, '#f1cfb2');
      body.addColorStop(0.55, '#e3b690');
      body.addColorStop(1, '#bf8660');
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.moveTo(-0.44, 0); // the heel's underside
      ctx.bezierCurveTo(-0.3, 0.005, -0.18, -0.03, -0.05, -0.035); // the sole, with a slight arch
      ctx.bezierCurveTo(0.1, -0.035, 0.25, 0, 0.4, 0);
      ctx.bezierCurveTo(0.5, 0, 0.53, -0.07, 0.47, -0.12); // round the big toe
      ctx.bezierCurveTo(0.4, -0.17, 0.25, -0.17, 0.12, -0.23); // up the top of the foot
      ctx.bezierCurveTo(0.08, -0.3, 0.1, -0.36, 0.09, -0.43); // the front of the ankle
      ctx.lineTo(0.09, yTop); // the leg, up out of sight
      ctx.lineTo(-0.17, yTop);
      ctx.lineTo(-0.17, -0.4);
      ctx.bezierCurveTo(-0.4, -0.33, -0.5, -0.22, -0.5, -0.1); // the back of the heel
      ctx.bezierCurveTo(-0.5, -0.04, -0.48, 0, -0.44, 0);
      ctx.closePath();
      ctx.fill();
      ctx.save();
      ctx.clip();
      const leg = ctx.createLinearGradient(-0.17, 0, 0.09, 0); // the leg is rounder: lit in the middle, dark at the edges
      leg.addColorStop(0, 'rgba(120,70,45,.3)');
      leg.addColorStop(0.45, 'rgba(255,240,225,.28)');
      leg.addColorStop(1, 'rgba(120,70,45,.3)');
      ctx.fillStyle = leg;
      ctx.fillRect(-0.17, yTop, 0.26, -yTop - 0.55);
      for (let k = 0; k < 8; k++) { // the shading fades out where the leg meets the foot
        ctx.globalAlpha = 1 - k / 8;
        ctx.fillRect(-0.17, -0.55 + k * 0.025, 0.26, 0.026);
      }
      ctx.globalAlpha = 1;
      const heel = ctx.createRadialGradient(-0.38, -0.08, 0.01, -0.38, -0.08, 0.16); // the heel's curve and shadow
      heel.addColorStop(0, 'rgba(255,235,215,.3)');
      heel.addColorStop(0.7, 'rgba(120,70,45,.12)');
      heel.addColorStop(1, 'rgba(120,70,45,0)');
      ctx.fillStyle = heel;
      ctx.fillRect(-0.55, -0.25, 0.3, 0.27);
      ctx.fillStyle = 'rgba(100,60,40,.3)'; // the shadow under the sole
      ctx.fillRect(-0.6, -0.022, 1.2, 0.03);
      ctx.restore();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(122,79,56,.5)'; // the Achilles tendon, the ankle's creases and the tendons across the instep
      ctx.lineWidth = 1.2 / L;
      ctx.beginPath();
      ctx.moveTo(-0.15, -0.38);
      ctx.quadraticCurveTo(-0.2, -0.2, -0.3, -0.1);
      ctx.moveTo(0.085, -0.36);
      ctx.quadraticCurveTo(0.06, -0.34, 0.03, -0.36);
      ctx.moveTo(0.085, -0.31);
      ctx.quadraticCurveTo(0.06, -0.29, 0.04, -0.31);
      for (const dy of [0, 0.02, 0.04]) {
        ctx.moveTo(0.1, -0.22 + dy);
        ctx.quadraticCurveTo(0.22, -0.2 + dy * 1.2, 0.34, -0.16 + dy * 0.6);
      }
      ctx.stroke();
      ctx.strokeStyle = '#7a4f38';
      ctx.lineWidth = 2 / L;
      const toe = (x: number, y: number, rx: number, ry: number, rot: number, big: boolean) => {
        const g = ctx.createRadialGradient(x - rx * 0.3, y - ry * 0.4, rx * 0.1, x, y, rx * 1.2);
        g.addColorStop(0, '#f7dcc2');
        g.addColorStop(0.6, '#e8bd98');
        g.addColorStop(1, '#c58f68');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#f8e4d4'; // the toenail, with a glint
        ctx.strokeStyle = 'rgba(122,79,56,.65)';
        ctx.lineWidth = 1.2 / L;
        ctx.beginPath();
        ctx.ellipse(x + rx * 0.3, y - ry * 0.45, rx * (big ? 0.42 : 0.5), ry * (big ? 0.3 : 0.34), rot - 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,.7)';
        ctx.beginPath();
        ctx.ellipse(x + rx * 0.22, y - ry * 0.52, rx * 0.12, ry * 0.07, rot - 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#7a4f38';
        ctx.lineWidth = 2 / L;
      };
      toe(0.17, -0.2, 0.045, 0.036, -0.5, false); // the small toes, lined up behind the big one
      toe(0.25, -0.18, 0.05, 0.04, -0.45, false);
      toe(0.32, -0.15, 0.055, 0.045, -0.4, false);
      toe(0.42, -0.07, 0.092, 0.077, 0, true);
      ctx.strokeStyle = 'rgba(122,79,56,.5)'; // the crease at the big toe's joint
      ctx.lineWidth = 1.2 / L;
      ctx.beginPath();
      ctx.moveTo(0.35, -0.115);
      ctx.quadraticCurveTo(0.34, -0.07, 0.36, -0.02);
      ctx.stroke();
      ctx.beginPath(); // the ankle bone
      ctx.arc(-0.02, -0.3, 0.032, Math.PI * 0.2, Math.PI * 1.2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
    fxText(p);
    fadeToFinal(r);
  };

  // Builder: a builder in a hard hat and his truck work at the bottom of the stage. The truck's crane lifts each word, built as a
  // little brick wall, up into place, one line after another from the bottom line to the top.
  const BLD_LIFT = 440; // how long the crane takes to swing a word into place
  const BLD_SPAN = Math.min(4200, Math.max(1600, words.length * 330)); // the whole job
  const bs = Math.max(0.55, Math.min(1.1, H / 270)); // the size of the truck and the builder
  const gY = H - 6; // the ground
  const bldOrder = words.map((w, i) => ({ w, i })).sort((a, b) => b.w.cells[0].y - a.w.cells[0].y || a.w.x0 - b.w.x0); // the bottom line first
  const bldT = new Array<number>(words.length).fill(0);
  bldOrder.forEach((o2, rank) => (bldT[o2.i] = (rank / Math.max(1, words.length)) * BLD_SPAN));
  const bldBox = (w: (typeof words)[number]) => {
    const y = w.cells[0].y;
    return { x: w.x0 - 4, y: y - fs * 0.95, w: w.x1 - w.x0 + 8, h: fs * 1.3 };
  };
  const bricks = (x: number, y: number, w: number, h: number, alpha: number) => { // a little wall of bricks
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = '#b5542f';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(236,222,200,.6)';
    ctx.lineWidth = 1;
    const rh = Math.max(5, 7 * bs);
    const bw = Math.max(10, 16 * bs);
    ctx.beginPath();
    for (let j = 0, yy = y; yy < y + h; j++, yy += rh) {
      ctx.moveTo(x, yy);
      ctx.lineTo(x + w, yy);
      for (let xx = x + (j % 2) * (bw / 2); xx < x + w; xx += bw) {
        ctx.moveTo(xx, yy);
        ctx.lineTo(xx, yy + rh);
      }
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,.18)'; // the shaded underside
    ctx.fillRect(x, y + h - 3, w, 3);
    ctx.restore();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#6e2f18';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);
    ctx.globalAlpha = 1;
  };
  const bldWheel = (x: number, y: number, rad: number, spin: number) => {
    ctx.fillStyle = '#1b1d22';
    circ(x, y, rad);
    ctx.fillStyle = '#9aa3ad';
    circ(x, y, rad * 0.5);
    ctx.strokeStyle = '#444b55';
    ctx.lineWidth = 2;
    for (let k = 0; k < 3; k++) {
      const a = spin + (k * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * rad * 0.5, y + Math.sin(a) * rad * 0.5);
      ctx.stroke();
    }
  };
  const bldTruck = (tx: number, spin: number) => { // a yellow truck with a load of bricks, facing right
    const k = bs;
    ctx.fillStyle = '#f2b705'; // the bed
    ctx.fillRect(tx, gY - 46 * k, 80 * k, 30 * k);
    ctx.fillStyle = '#c99500';
    ctx.fillRect(tx, gY - 20 * k, 128 * k, 8 * k); // the chassis
    ctx.fillStyle = '#b5542f'; // the load of bricks
    for (let j = 0; j < 3; j++) for (let i = 0; i < 5 - j; i++) ctx.fillRect(tx + (6 + i * 14 + j * 7) * k, gY - (58 + j * 9) * k, 12 * k, 8 * k);
    ctx.fillStyle = '#f2b705'; // the cab
    ctx.beginPath();
    ctx.moveTo(tx + 82 * k, gY - 12 * k);
    ctx.lineTo(tx + 82 * k, gY - 58 * k);
    ctx.lineTo(tx + 112 * k, gY - 58 * k);
    ctx.lineTo(tx + 128 * k, gY - 34 * k);
    ctx.lineTo(tx + 128 * k, gY - 12 * k);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#bfe3f5'; // the window
    ctx.beginPath();
    ctx.moveTo(tx + 88 * k, gY - 52 * k);
    ctx.lineTo(tx + 110 * k, gY - 52 * k);
    ctx.lineTo(tx + 121 * k, gY - 36 * k);
    ctx.lineTo(tx + 88 * k, gY - 36 * k);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff3a8';
    ctx.fillRect(tx + 125 * k, gY - 28 * k, 4 * k, 7 * k); // the headlight
    ctx.strokeStyle = '#8a6a00';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(tx, gY - 46 * k, 80 * k, 30 * k);
    bldWheel(tx + 26 * k, gY - 11 * k, 11 * k, spin);
    bldWheel(tx + 104 * k, gY - 11 * k, 11 * k, spin);
  };
  const bldMan = (x: number, swing: number, cheer: number) => { // the builder, with a yellow hard hat and a mallet
    const k = bs;
    ctx.lineCap = 'round';
    ctx.fillStyle = '#2f4f8f'; // dungarees
    ctx.fillRect(x - 9 * k, gY - 30 * k, 8 * k, 28 * k);
    ctx.fillRect(x + 1 * k, gY - 30 * k, 8 * k, 28 * k);
    ctx.fillStyle = '#3b2a1a'; // boots
    ctx.fillRect(x - 11 * k, gY - 4 * k, 11 * k, 5 * k);
    ctx.fillRect(x + 1 * k, gY - 4 * k, 11 * k, 5 * k);
    ctx.fillStyle = '#e8742a'; // shirt
    ctx.fillRect(x - 10 * k, gY - 52 * k, 20 * k, 24 * k);
    ctx.fillStyle = '#2f4f8f';
    ctx.fillRect(x - 10 * k, gY - 38 * k, 20 * k, 10 * k); // the bib of the dungarees
    ctx.fillStyle = '#6b4a1e'; // the tool belt
    ctx.fillRect(x - 10 * k, gY - 31 * k, 20 * k, 3 * k);
    const arm = (sx: number, ang: number, withMallet: boolean) => {
      ctx.save();
      ctx.translate(sx, gY - 48 * k);
      ctx.rotate(ang);
      ctx.strokeStyle = '#e8742a';
      ctx.lineWidth = 6 * k;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, 20 * k);
      ctx.stroke();
      ctx.fillStyle = '#e8b78f';
      circ(0, 22 * k, 4 * k);
      if (withMallet) {
        ctx.strokeStyle = '#8a5a2b';
        ctx.lineWidth = 3 * k;
        ctx.beginPath();
        ctx.moveTo(0, 22 * k);
        ctx.lineTo(0, 40 * k);
        ctx.stroke();
        ctx.fillStyle = '#555c66';
        ctx.fillRect(-7 * k, 38 * k, 14 * k, 8 * k);
      }
      ctx.restore();
    };
    arm(x - 11 * k, -2.5 * cheer + 0.2, false);
    arm(x + 11 * k, cheer > 0 ? 2.5 * cheer - 0.2 : -0.9 + swing * 1.4, cheer === 0);
    ctx.fillStyle = '#e8b78f'; // head
    circ(x, gY - 60 * k, 9 * k);
    ctx.fillStyle = '#3a2a1a';
    circ(x - 3 * k, gY - 61 * k, 1.2 * k);
    circ(x + 3 * k, gY - 61 * k, 1.2 * k);
    ctx.strokeStyle = '#7a3b2a';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(x, gY - 58 * k, 3.5 * k, 0.2, Math.PI - 0.2);
    ctx.stroke();
    ctx.fillStyle = '#f7d21a'; // the hard hat
    ctx.beginPath();
    ctx.arc(x, gY - 63 * k, 10.5 * k, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(x - 13 * k, gY - 64 * k, 26 * k, 3 * k);
    ctx.strokeStyle = '#a48800';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(x, gY - 63 * k, 10.5 * k, Math.PI, 0);
    ctx.stroke();
  };
  const drawBuilder = (r: number) => {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#1d2744');
    sky.addColorStop(1, '#34476b');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#4a4030'; // the ground
    ctx.fillRect(0, gY, W, H - gY);
    const intro = ease(clamp1((r + T_INTRO) / T_INTRO));
    const tx = -150 * bs + (14 + 150 * bs) * intro;
    const mx = tx + 160 * bs;
    ctx.font = `${fs}px ${FONT}`;
    ctx.textBaseline = 'alphabetic';
    // the truck and the builder stand behind the wall of words
    let carry = -1;
    for (let i = 0; i < words.length; i++) if (r - bldT[i] >= 0 && r - bldT[i] < BLD_LIFT + 120) carry = i;
    const hit = carry >= 0 ? Math.sin((r - bldT[carry]) / 55) : 0;
    bldTruck(tx, -r / 120);
    const finished = r > BLD_SPAN + BLD_LIFT;
    const cheer = finished ? Math.abs(Math.sin(r / 110)) : 0;
    bldMan(mx, hit, cheer > 0 ? Math.max(0.2, cheer) : 0);
    // the words that are built
    for (let i = 0; i < words.length; i++) {
      const rel = r - bldT[i];
      if (rel < 0) continue;
      const b = bldBox(words[i]);
      if (rel < BLD_LIFT) continue;
      const e = rel - BLD_LIFT;
      const drop = e < 220 ? Math.sin((e / 220) * Math.PI) * -3 * (1 - e / 220) : 0;
      bricks(b.x, b.y + drop, b.w, b.h, 1);
      for (const c of words[i].cells) textLit(c, '#fffaf0', 'rgba(0,0,0,.65)', 3, c.x, c.y + drop);
      if (e < 320) { // the dust of the landing
        for (let d = 0; d < 4; d++) {
          ctx.fillStyle = `rgba(210,200,185,${0.45 * (1 - e / 320)})`;
          circ(b.x + (b.w * (d + 0.5)) / 4, b.y + b.h - e * 0.02, 3 + e * 0.02);
        }
      }
    }
    // the crane: it follows the word being lifted, and otherwise rests
    const pivot = { x: tx + 64 * bs, y: gY - 54 * bs };
    let aim = { x: tx + 70 * bs, y: gY - 120 * bs };
    if (carry >= 0) {
      const rel = r - bldT[carry];
      const b = bldBox(words[carry]);
      const q = ease(clamp1(rel / BLD_LIFT));
      const sx = tx + 40 * bs;
      const sy = gY - 62 * bs;
      const tgx = b.x + b.w / 2;
      const tgy = b.y + b.h / 2;
      const sc = 0.3 + 0.7 * q;
      const cx = sx + (tgx - sx) * q;
      const cy = sy + (tgy - sy) * q - Math.sin(q * Math.PI) * 14;
      aim = { x: cx, y: cy - (b.h * sc) / 2 - 10 };
      if (rel < BLD_LIFT) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Math.sin(rel / 38) * 0.06 * (1 - q));
        bricks(-(b.w * sc) / 2, -(b.h * sc) / 2, b.w * sc, b.h * sc, 1);
        ctx.restore();
      }
    }
    ctx.strokeStyle = '#c99500'; // the boom
    ctx.lineWidth = 6 * bs;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pivot.x, pivot.y);
    ctx.lineTo(aim.x, aim.y);
    ctx.stroke();
    ctx.strokeStyle = '#2b2b2b'; // the cable and hook
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(aim.x, aim.y);
    ctx.lineTo(aim.x, aim.y + 10);
    ctx.stroke();
    ctx.fillStyle = '#c99500';
    circ(pivot.x, pivot.y, 5 * bs);
    fadeToFinal(r);
  };

  // Oddbods: a gang of seven odd, brightly coloured blob creatures. Each one boings in carrying a word above its head, leaps up
  // and sticks the word in place, lands with a squash and bounces off again. At the end the letters keep a hint of each
  // blob's colour until the usual text fades in.
  const ODD_IN = 650; // the bouncy hop in from the side
  const ODD_LEAP = 560; // the leap up to the word's place and the fall back down
  const ODD_OUT = 650; // the bounce off the stage
  const ODD_COLS = ['#e8413a', '#ffd23f', '#5cc24a', '#3fa2f0', '#9b5cf0', '#ff7ac0', '#ff9a2e'];
  const ob = Math.max(0.6, Math.min(1.15, H / 270)); // the size of a blob
  const oddBushes = Array.from({ length: 7 }, (_, i) => ({ x: ((i + rnd() * 0.6) / 7) * W, s: 16 + rnd() * 18 }));
  const oddBlob = (x: number, feet: number, kind: number, dir: number, squash: number, step: number, armsUp: number) => {
    const col = ODD_COLS[kind % ODD_COLS.length];
    const k = ob;
    const bw = 13 * k; // half the width of the body
    const bh = 36 * k; // the height of the body
    ctx.save();
    ctx.translate(x, feet);
    ctx.scale(1 + squash * 0.35, 1 - squash * 0.3);
    ctx.lineCap = 'round';
    // legs
    ctx.strokeStyle = col;
    ctx.lineWidth = 5 * k;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * 5 * k, -6 * k);
      ctx.lineTo(s * 5 * k + Math.sin(step) * s * 3 * k, 0);
      ctx.stroke();
    }
    // the body: a tall jelly bean
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.ellipse(0, -bh / 2 - 4 * k, bw, bh / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.28)'; // a shine
    ctx.beginPath();
    ctx.ellipse(-bw * 0.45, -bh * 0.72, bw * 0.22, bh * 0.16, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.22)'; // a pale belly
    ctx.beginPath();
    ctx.ellipse(0, -bh * 0.32, bw * 0.6, bh * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
    // arms: down and swinging, or raised to hold the word up
    ctx.strokeStyle = col;
    ctx.lineWidth = 4 * k;
    for (const s of [-1, 1]) {
      const hx = s * (bw + 6 * k) - s * armsUp * 6 * k;
      const hy = -bh * 0.45 + Math.sin(step + s) * 2 * k * (1 - armsUp) - armsUp * bh * 0.75;
      ctx.beginPath();
      ctx.moveTo(s * bw * 0.85, -bh * 0.55);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.fillStyle = col;
      circ(hx, hy, 2.6 * k);
    }
    // a little something on top, different for each of them
    const topY = -bh - 4 * k;
    ctx.fillStyle = col;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2 * k;
    if (kind % 7 === 0) { // a curly tuft
      ctx.beginPath();
      ctx.moveTo(0, topY + 2 * k);
      ctx.quadraticCurveTo(6 * k, topY - 8 * k, 1 * k, topY - 9 * k);
      ctx.stroke();
    } else if (kind % 7 === 2) { // two round ears
      circ(-bw * 0.65, topY + 6 * k, 4 * k);
      circ(bw * 0.65, topY + 6 * k, 4 * k);
    } else if (kind % 7 === 4) { // an antenna with a bobble
      ctx.beginPath();
      ctx.moveTo(0, topY + 2 * k);
      ctx.lineTo(Math.sin(step) * 2 * k, topY - 8 * k);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      circ(Math.sin(step) * 2 * k, topY - 9 * k, 2.5 * k);
    } else if (kind % 7 === 6) { // three spiky hairs
      ctx.beginPath();
      for (const s of [-1, 0, 1]) {
        ctx.moveTo(s * 3 * k, topY + 3 * k);
        ctx.lineTo(s * 5 * k, topY - 5 * k);
      }
      ctx.stroke();
    }
    // big eyes looking where it is going
    const ey = -bh * 0.74;
    const er = 5.2 * k;
    const look = dir * 1.6 * k;
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#ffffff';
      circ(s * 5.3 * k, ey, er);
      ctx.fillStyle = '#1a1a22';
      circ(s * 5.3 * k + look, ey + (armsUp > 0.5 ? -1.4 * k : 0.6 * k), er * 0.45);
      if (kind % 7 === 3) { // sleepy lids
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(s * 5.3 * k, ey, er + 0.5, Math.PI, 0);
        ctx.fill();
      } else if (kind % 7 === 1) { // cross little eyebrows
        ctx.strokeStyle = '#1a1a22';
        ctx.lineWidth = 1.4 * k;
        ctx.beginPath();
        ctx.moveTo(s * 2 * k, ey - er - 1 * k);
        ctx.lineTo(s * 9 * k, ey - er - 3 * k);
        ctx.stroke();
      }
    }
    // the mouth: a grin, or an open "wheee" when it is in the air
    ctx.fillStyle = '#5a1020';
    ctx.strokeStyle = '#3a0c16';
    ctx.lineWidth = 1.5 * k;
    if (armsUp > 0.5) {
      ctx.beginPath();
      ctx.ellipse(0, -bh * 0.5, 3.4 * k, 4 * k, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(0, -bh * 0.55, 5 * k, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }
    ctx.restore();
  };
  const drawOddbods = (r: number) => {
    const gy = H - 10;
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#1b3a5c');
    sky.addColorStop(1, '#2c5a6e');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#2f7a3a'; // round bushes and the grass
    for (const b of oddBushes) circ(b.x, gy + 4, b.s * ob);
    ctx.fillStyle = '#3e9a46';
    ctx.fillRect(0, gy, W, H - gy);
    ctx.font = `${fs}px ${FONT}`;
    ctx.textBaseline = 'alphabetic';
    const settled: { c: Cell; col: string; wob: number }[] = [];
    const carried: { c: Cell; x: number; y: number; col: string }[] = [];
    const blobs: (() => void)[] = [];
    const bodyH = 40 * ob;
    for (const { w, i, t0: wt0 } of wt) {
      const rr = r - wt0;
      if (rr < 0) continue;
      const kind = i % ODD_COLS.length;
      const col = ODD_COLS[kind];
      const dirIn = i % 2 ? -1 : 1; // 1: comes in from the left
      const edge = dirIn > 0 ? -30 : W + 30;
      const lift = (i % 3) * 15; // carried words ride at three heights so they do not pile up
      const holdY = (feet: number) => feet - bodyH - 16 * ob - lift; // where a word sits when held up overhead
      if (rr < ODD_IN) {
        const q = rr / ODD_IN;
        const x = edge + (w.cx - edge) * (1 - Math.pow(1 - q, 2));
        const hopPh = (rr / ODD_IN) * Math.PI * 4; // four boings on the way in
        const hop = Math.abs(Math.sin(hopPh)) * 14 * ob;
        const sq = Math.max(0, 0.5 - Math.abs(Math.sin(hopPh))) * 0.6; // squashed on each landing
        const feet = gy - hop;
        blobs.push(() => oddBlob(x, feet, kind, dirIn, sq, hopPh * 1.5, 1));
        for (const c of w.cells) carried.push({ c, x: c.x + (x - w.cx), y: holdY(feet), col });
      } else if (rr < ODD_IN + ODD_LEAP) {
        const p = (rr - ODD_IN) / ODD_LEAP;
        const lineY = w.cells[0].y;
        const peakFeet = Math.min(gy, lineY + bodyH + 16 * ob + lift); // high enough to hold the word at its line
        const arc = Math.sin(p * Math.PI);
        const feet = p < 0.12 ? gy : gy + (peakFeet - gy) * arc;
        const crouch = p < 0.12 ? Math.sin((p / 0.12) * Math.PI) * 0.8 : 0;
        blobs.push(() => oddBlob(w.cx, feet, kind, 0, crouch, 0, p < 0.5 ? 1 : 1 - (p - 0.5) * 2));
        if (p < 0.5) for (const c of w.cells) carried.push({ c, x: c.x, y: holdY(feet) + (c.y - holdY(feet)) * ease(p * 2), col });
        else for (const c of w.cells) settled.push({ c, col, wob: Math.sin((p - 0.5) * 40) * 2 * (1 - p) });
      } else {
        const e = rr - ODD_IN - ODD_LEAP;
        for (const c of w.cells) settled.push({ c, col, wob: 0 });
        if (e < 180) blobs.push(() => oddBlob(w.cx, gy, kind, 0, Math.sin((e / 180) * Math.PI) * 0.9, 0, 0)); // the landing squash
        else if (e < 180 + ODD_OUT) {
          const q = (e - 180) / ODD_OUT;
          const target = dirIn > 0 ? W + 40 : -40; // it bounces off the way it was heading
          const hopPh = q * Math.PI * 3;
          blobs.push(() => oddBlob(w.cx + (target - w.cx) * q * q, gy - Math.abs(Math.sin(hopPh)) * 16 * ob, kind, dirIn, 0, hopPh * 1.5, 0));
        }
      }
    }
    for (const s of settled) textLit(s.c, '#ffffff', s.col, 7, s.c.x, s.c.y + s.wob);
    for (const b of blobs) b();
    for (const k of carried) textLit(k.c, '#ffffff', k.col, 9, k.x, k.y);
    fadeToFinal(r);
  };

  const special: Partial<Record<RevealStyle, (r: number, t: number) => void>> = {
    minions: drawMinions,
    snowglobe: drawSnowglobe,
    rocket: drawRocket,
    lightning: drawStorm,
    helicopters: drawHelis,
    banner: drawBanner,
    balloons: drawBalloons,
    quill: drawQuill,
    dominoes: drawDominoes,
    treasure: drawTreasure,
    paperplanes: drawPlanes,
    ghosts: drawGhosts,
    seance: drawSeance,
    poltergeist: drawPolter,
    haunted: drawHaunted,
    dragon: drawDragon,
    panther: drawPink,
    roadrunner: drawRoad,
    genie: drawGenie,
    fartgun: drawFartGun,
    arrows: drawArrows,
    tiles: drawTiles,
    witches: drawWitches,
    redarrows: drawRedArrows,
    pirate: drawPirate,
    fogwriter: drawFogWriter,
    whale: drawWhale,
    submarine: drawSubmarine,
    bomber: drawBomber,
    kraken: drawKraken,
    thor: drawThor,
    spiders: drawSpiders,
    hatdance: drawHatDance,
    lasers: drawLasers,
    earthquake: drawQuake,
    volcano: drawVolcano,
    emoji: drawEmoji,
    sharks: drawSharks,
    broomball: drawBroomball,
    zombies: drawZombies,
    dissolve: drawDissolve,
    sandfall: drawSand,
    blackhole: drawBlackHole,
    hammersmash: drawHammerSmash,
    shatter: drawShatter,
    burnaway: drawBurn,
    shredder: drawShredder,
    melt: drawMelt,
    rainwash: drawRainWash,
    acidrain: drawAcid,
    icemelt: drawIce,
    shaken: drawShaken,
    footsmash: drawFoot,
    builder: drawBuilder,
    oddbods: drawOddbods,
  };

  const frame = (now: number) => {
    const t = now - t0;
    if (skipped || t >= T_END) {
      drawFinal();
      resolveDone();
      return;
    }
    const r = t - T_INTRO;
    const own = special[style];
    if (own) {
      own(r, t);
      requestAnimationFrame(frame);
      return;
    }
    if (style === 'matrix') {
      if (t < T_SCAN) {
        drawScan(t / T_SCAN);
      } else if (t < T_INTRO) {
        if (!rainStarted) {
          rainStarted = true;
          clear();
          ctx.globalAlpha = 0.5;
          ctx.drawImage(o.source, ix, iy, iw, ih);
          ctx.globalAlpha = 1;
        }
        rain(0.14);
      } else {
        ctx.fillStyle = `rgba(${BG},.35)`;
        ctx.fillRect(0, 0, W, H);
        rain(0);
        ctx.fillStyle = `rgba(${BG},.88)`;
        ctx.fillRect(pad / 2, pad / 2, W - pad, H - pad);
        drawCells(r, (c) => r >= c.lock, true);
      }
    } else if (t < T_INTRO) {
      const p = t / T_INTRO;
      if (style === 'wizard') {
        drawWizard(r, t);
      } else if (style === 'bomb') {
        drawBomb(r, t);
      } else if (style === 'hearts') {
        drawHearts(r, t);
      } else if (style === 'flowers') {
        drawFlowers(r, t);
      } else if (style === 'asteroids') {
        drawAsteroids(r, t);
      } else if (style === 'ticker') {
        drawTicker(r);
      } else if (style === 'radar') {
        drawRadar(r);
      } else if (style === 'film') {
        drawFilm(r, t);
      } else if (style === 'parade') {
        drawParade(r, t);
      } else if (style === 'oldtype') {
        drawOldType(r, t);
      } else if (style === 'printer') {
        drawPrinter(r, t);
      } else if (style === 'train') {
        drawTrain(t);
      } else if (style === 'safe') {
        drawSafe(0, t, true);
      } else if (style === 'ink') {
        drawInk(r, t);
      } else if (style === 'jackpot') {
        drawJackpot(r, t);
      } else if (style === 'swarm') {
        drawSwarm(r, t);
      } else if (style === 'bubbles') {
        drawBubbles(r);
      } else if (style === 'ufo') {
        drawUfo(t);
      } else if (style === 'spotlight') {
        drawSpot(0);
      } else if (style === 'plane') {
        drawPlane(t);
      } else if (style === 'moon') {
        drawMoon(0, 0, t);
      } else if (style === 'curtain') {
        drawCurtain(0);
      } else if (style === 'can') {
        clear();
        drawCan(ease(p), (1 - ease(p)) * 100, 0);
      } else if (style === 'flag') {
        clear();
        drawGun(MUZZLE - (1 - ease(p)) * 170 + (p > 0.8 ? (rnd() - 0.5) * 3 : 0));
      } else if (style === 'pixelate') {
        clear();
        drawPixels(1 + p * p * 30, 1);
      } else if (style === 'fireworks') {
        drawScan(p);
      } else drawScan(p, style === 'typewriter' ? 1 - p * 0.75 : 1);
    } else if (style === 'scramble') {
      clear();
      drawCells(r, (c) => r >= c.lock, true);
    } else if (style === 'typewriter') {
      clear();
      const n = Math.floor(Math.min(1, r / T_RES) * visible.length + 0.5);
      drawCells(r, (_c, i) => i < n, false, false);
      const cur = visible[Math.min(n, visible.length - 1)];
      if (cur && Math.floor(r / 260) % 2 === 0) {
        ctx.fillStyle = '#7dffe0';
        ctx.fillRect(cur.x, cur.y - fs + 2, cw * 0.7, fs);
      }
    } else if (style === 'pixelate') {
      clear();
      drawPixels(30, Math.max(0, 1 - (r / T_RES) * 1.3));
      ctx.fillStyle = `rgba(${BG},.55)`;
      ctx.fillRect(0, 0, W, H);
      drawCells(r, (c) => r >= c.lock, false);
    } else if (style === 'iris') {
      clear();
      ctx.globalAlpha = 0.45;
      ctx.drawImage(o.source, ix, iy, iw, ih);
      ctx.globalAlpha = 1;
      const e = 1 - Math.pow(1 - Math.min(1, r / T_RES), 3);
      const rad = (e * Math.hypot(W, H)) / 2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, rad, 0, Math.PI * 2);
      ctx.clip();
      clear();
      drawCells(r, () => true, false, false);
      ctx.restore();
      ctx.strokeStyle = 'rgba(120,255,220,.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, rad, 0, Math.PI * 2);
      ctx.stroke();
    } else if (style === 'wizard') {
      drawWizard(r, t);
    } else if (style === 'bomb') {
      drawBomb(r, t);
    } else if (style === 'hearts') {
      drawHearts(r, t);
    } else if (style === 'flowers') {
      drawFlowers(r, t);
    } else if (style === 'asteroids') {
      drawAsteroids(r, t);
    } else if (style === 'ticker') {
      drawTicker(r);
    } else if (style === 'radar') {
      drawRadar(r);
    } else if (style === 'film') {
      drawFilm(r, t);
    } else if (style === 'parade') {
      drawParade(r, t);
    } else if (style === 'oldtype') {
      drawOldType(r, t);
    } else if (style === 'printer') {
      drawPrinter(r, t);
    } else if (style === 'train') {
      drawTrain(t);
    } else if (style === 'safe') {
      drawSafe(Math.min(1, r / T_RES), t, false);
    } else if (style === 'ink') {
      drawInk(r, t);
    } else if (style === 'jackpot') {
      drawJackpot(r, t);
    } else if (style === 'swarm') {
      drawSwarm(r, t);
    } else if (style === 'bubbles') {
      drawBubbles(r);
    } else if (style === 'ufo') {
      drawUfo(t);
    } else if (style === 'spotlight') {
      drawSpot(Math.min(1, r / (T_RES - 200)));
    } else if (style === 'plane') {
      drawPlane(t);
    } else if (style === 'moon') {
      const p = Math.min(1, r / (T_RES - 700));
      drawMoon(p * p * (3 - 2 * p), Math.min(1, Math.max(0, (r - (T_RES - 700)) / 700)), t);
    } else if (style === 'curtain') {
      const p = Math.min(1, r / (T_RES - 200));
      drawCurtain(p * p * (3 - 2 * p));
    } else if (style === 'can') {
      clear();
      ctx.font = `${fs}px ${FONT}`;
      for (const c of visible) {
        const p = (r - c.lock) / FLIGHT;
        if (p < 0) continue;
        const q = Math.min(1, p);
        ctx.fillStyle = q < 1 ? '#7dffe0' : '#e8fff4';
        ctx.shadowColor = 'rgba(80,255,190,.6)';
        ctx.shadowBlur = q < 1 ? 10 : 5;
        ctx.fillText(c.ch, mouthX + (c.x - mouthX) * q, mouthY + (c.y - mouthY) * q * q - 70 * q * (1 - q));
      }
      ctx.shadowBlur = 0;
      const out = ease((r - (T_RES - 450)) / 450);
      drawCan(1, out * 140, Math.sin(r / 45) * 0.04 * (1 - out));
    } else if (style === 'flag') {
      clear();
      const p = Math.min(1, r / 1100);
      const e = p * p * (3 - 2 * p); // slow start so the gun and the flag are seen leaving the barrel
      const L = MUZZLE * (1 - e);
      const R = MUZZLE + (W - MUZZLE) * e;
      const hh = (H / 2 - 6) * ease(p * 3);
      // a wavy cloth: the edges, the folds and the writing ripple like a flag in the wind, then settle
      const damp = 1 - clamp01((r - 1000) / 400);
      const wv = (x: number) => 8 * damp * (0.2 + 0.8 * clamp01((x - L) / Math.max(60, R - L))) * Math.sin((x - L) * 0.04 - t * 0.009);
      const notch = Math.min(14, (R - L) * 0.1) * damp;
      const flagPath = () => {
        ctx.beginPath();
        ctx.moveTo(L, gunY - hh + wv(L));
        for (let x = L + 6; x < R; x += 6) ctx.lineTo(x, gunY - hh + wv(x));
        ctx.lineTo(R, gunY - hh + wv(R));
        ctx.lineTo(R - notch, gunY + wv(R));
        ctx.lineTo(R, gunY + hh + wv(R));
        for (let x = R - 6; x > L; x -= 6) ctx.lineTo(x, gunY + hh + wv(x));
        ctx.lineTo(L, gunY + hh + wv(L));
        ctx.closePath();
      };
      ctx.save();
      flagPath();
      ctx.clip();
      ctx.fillStyle = 'rgb(22,34,46)';
      ctx.fillRect(L - 2, 0, R - L + 4, H);
      ctx.globalAlpha = damp;
      ctx.fillStyle = '#9b1c2e';
      ctx.fillRect(L - 2, 0, R - L + 4, H);
      for (let x = L; x < R; x += 6) {
        const s = Math.cos((x - L) * 0.04 - t * 0.009);
        ctx.fillStyle = s > 0 ? `rgba(255,255,255,${0.14 * s})` : `rgba(0,0,0,${-0.22 * s})`;
        ctx.fillRect(x, 0, 6, H);
      }
      ctx.globalAlpha = 1;
      ctx.font = `${fs}px ${FONT}`;
      ctx.fillStyle = '#fff6e0';
      for (const c of visible) ctx.fillText(c.ch, c.x, c.y + wv(c.x));
      ctx.restore();
      flagPath();
      ctx.strokeStyle = `rgba(224,176,48,${damp})`;
      ctx.lineWidth = 3;
      ctx.stroke();
      drawGun(L + 4);
      if (r < 240) {
        const f = 1 - r / 240;
        ctx.fillStyle = `rgba(255,255,255,${0.5 * f})`;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = `rgba(255,200,40,${f})`;
        ctx.beginPath();
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const rad = (k % 2 ? 16 : 40) * (0.6 + f);
          ctx.lineTo(MUZZLE + Math.cos(a) * rad, gunY + Math.sin(a) * rad);
        }
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = `rgba(220,40,40,${f})`;
        ctx.font = `bold 22px ${FONT}`;
        ctx.fillText('BANG!', MUZZLE + 14, gunY - 44);
      }
    } else {
      if (r < 20) clear();
      drawFireworks(r);
    }
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
  return {
    done,
    skip: () => {
      skipped = true;
    },
  };
}
