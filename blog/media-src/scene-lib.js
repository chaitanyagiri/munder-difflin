// Scene library for the blog's hand-drawn hero illustrations.
// Style contract (see .claude/skills/ian-xiaohei-illustrations/SKILL.md local
// overrides): 1600x900, pure white, thin wobbly ink lines, yellow #FFCA54
// Xiaohei with black dot eyes, sparse orange/blue/amber English annotations,
// one concept per image, never red.
//
// Rendered by render.html; re-render any hero by opening
// render.html?slug=<post-slug> and screenshotting the 1600x900 viewport.

const INK = "#111";
const YEL = "#FFCA54";
const BLUE = "#4263EB";
const ORANGE = "#F08C00";
const AMBER = "#E8A33D";

// tiny seeded rng for per-slug jitter
function rng(seed) {
  let h = 2166136261;
  for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822519); h = Math.imul(h ^ (h >>> 13), 3266489917); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}
const J = (r, n) => (r() - 0.5) * 2 * n; // jitter ±n

// ---- parts ----
const hei = (x, y, s, { legs = "stand", armL = "down", armR = "down" } = {}) => {
  const rx = 58 * s, ry = 70 * s;
  let out = `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${YEL}" stroke="${INK}"/>`;
  out += `<circle cx="${x - 18 * s}" cy="${y - 18 * s}" r="${6 * s}" fill="${INK}" stroke="none"/>`;
  out += `<circle cx="${x + 18 * s}" cy="${y - 18 * s}" r="${6 * s}" fill="${INK}" stroke="none"/>`;
  const ab = y + 10 * s; // arm base height
  const arm = (side, kind) => {
    const d = side === "L" ? -1 : 1, bx = x + d * rx * 0.92;
    if (kind === "none") return "";
    if (kind === "down") return `<path d="M${bx} ${ab} C ${bx + d * 18 * s} ${ab + 30 * s}, ${bx + d * 24 * s} ${ab + 52 * s}, ${bx + d * 26 * s} ${ab + 66 * s}"/>`;
    if (kind === "out") return `<path d="M${bx} ${ab} C ${bx + d * 40 * s} ${ab - 6 * s}, ${bx + d * 66 * s} ${ab - 10 * s}, ${bx + d * 86 * s} ${ab - 8 * s}"/>`;
    if (kind === "up") return `<path d="M${bx} ${ab} C ${bx + d * 34 * s} ${ab - 34 * s}, ${bx + d * 50 * s} ${ab - 62 * s}, ${bx + d * 56 * s} ${ab - 84 * s}"/>`;
    return "";
  };
  out += arm("L", armL) + arm("R", armR);
  const lb = y + ry - 6 * s; // leg base
  if (legs === "stand") {
    out += `<path d="M${x - 15 * s} ${lb} L${x - 17 * s} ${lb + 56 * s} M${x - 17 * s} ${lb + 56 * s} l${-14 * s} ${4 * s}"/>`;
    out += `<path d="M${x + 15 * s} ${lb} L${x + 17 * s} ${lb + 56 * s} M${x + 17 * s} ${lb + 56 * s} l${14 * s} ${4 * s}"/>`;
  } else if (legs === "walk") {
    out += `<path d="M${x - 13 * s} ${lb} L${x - 30 * s} ${lb + 52 * s} M${x - 30 * s} ${lb + 52 * s} l${-14 * s} ${4 * s}"/>`;
    out += `<path d="M${x + 13 * s} ${lb} L${x + 32 * s} ${lb + 50 * s} M${x + 32 * s} ${lb + 50 * s} l${14 * s} ${2 * s}"/>`;
  }
  return out;
};

const desk = (x, y, w) => `<path d="M${x} ${y} h${w}"/><path d="M${x + w * 0.1} ${y} v${86} M${x + w * 0.9} ${y} v${86}"/>`;
const terminal = (x, y, w, h) => {
  const lines = [[0.14, 0.55], [0.14, 0.8], [0.14, 0.4]].map((l, i) =>
    `<path d="M${x + w * l[0]} ${y + h * (0.45 + i * 0.2)} h${w * l[1]}"/>`).join("");
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/><path d="M${x} ${y + h * 0.22} h${w}"/>` +
    `<circle cx="${x + 16}" cy="${y + h * 0.11}" r="4"/><circle cx="${x + 32}" cy="${y + h * 0.11}" r="4"/><circle cx="${x + 48}" cy="${y + h * 0.11}" r="4"/>` + lines;
};
const sticky = (x, y, s, rot = 0) => `<rect x="${x}" y="${y}" width="${s}" height="${s}" transform="rotate(${rot} ${x + s / 2} ${y + s / 2})"/>`;
const envelope = (x, y, w, rot = 0) => {
  const h = w * 0.66;
  return `<g transform="rotate(${rot} ${x + w / 2} ${y + h / 2})"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/><path d="M${x} ${y + 4} L${x + w / 2} ${y + h * 0.55} L${x + w} ${y + 4}"/></g>`;
};
const clock = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}"/><path d="M${x} ${y} L${x} ${y - r * 0.66} M${x} ${y} L${x + r * 0.5} ${y}"/><path d="M${x} ${y - r} v-10 M${x} ${y + r} v10 M${x - r} ${y} h-10 M${x + r} ${y} h10"/>`;
const moonzzz = (x, y) => `<path d="M${x} ${y} a44 44 0 1 0 34 72 a36 36 0 0 1 -34 -72 z"/>` +
  `<text x="${x + 74}" y="${y + 4}" font-size="42" fill="${INK}" stroke="none" font-family="Caveat">z</text><text x="${x + 104}" y="${y - 20}" font-size="34" fill="${INK}" stroke="none" font-family="Caveat">z</text><text x="${x + 128}" y="${y - 40}" font-size="26" fill="${INK}" stroke="none" font-family="Caveat">z</text>`;
const shield = (x, y, s) => `<path d="M${x} ${y - 60 * s} c ${30 * s} ${14 * s} ${52 * s} ${14 * s} ${64 * s} ${8 * s} v ${64 * s} c 0 ${44 * s} ${-24 * s} ${64 * s} ${-64 * s} ${82 * s} c ${-40 * s} ${-18 * s} ${-64 * s} ${-38 * s} ${-64 * s} ${-82 * s} v ${-64 * s} c ${12 * s} ${6 * s} ${34 * s} ${6 * s} ${64 * s} ${-8 * s} z"/><path d="M${x - 20 * s} ${y + 4 * s} l ${14 * s} ${16 * s} l ${28 * s} ${-34 * s}" stroke-width="4"/>`;
const book = (x, y, w) => {
  const h = w * 0.62;
  return `<path d="M${x} ${y} C ${x + w * 0.22} ${y - h * 0.14}, ${x + w * 0.42} ${y - h * 0.14}, ${x + w * 0.5} ${y} C ${x + w * 0.58} ${y - h * 0.14}, ${x + w * 0.78} ${y - h * 0.14}, ${x + w} ${y} V ${y + h} C ${x + w * 0.78} ${y + h * 0.88}, ${x + w * 0.58} ${y + h * 0.88}, ${x + w * 0.5} ${y + h} C ${x + w * 0.42} ${y + h * 0.88}, ${x + w * 0.22} ${y + h * 0.88}, ${x} ${y + h} Z M${x + w * 0.5} ${y} V ${y + h}"/>` +
    [0.22, 0.42, 0.62].map(t => `<path d="M${x + w * 0.08} ${y + h * t} h${w * 0.3} M${x + w * 0.62} ${y + h * t} h${w * 0.3}"/>`).join("");
};
const coins = (x, y, n) => Array.from({ length: n }, (_, i) => `<ellipse cx="${x}" cy="${y - i * 16}" rx="34" ry="10"/>`).join("");
const bell = (x, y, s) => `<path d="M${x - 40 * s} ${y} c 0 ${-36 * s} ${22 * s} ${-52 * s} ${40 * s} ${-52 * s} c ${18 * s} 0 ${40 * s} ${16 * s} ${40 * s} ${52 * s} z"/><circle cx="${x}" cy="${y + 12 * s}" r="${5 * s}"/>`;
const bolt = (x, y, s) => `<path d="M${x} ${y} l${-16 * s} ${30 * s} h${12 * s} l${-14 * s} ${30 * s} l${34 * s} ${-38 * s} h${-14 * s} l${18 * s} ${-22 * s} z"/>`;
const magnifier = (x, y, s) => `<circle cx="${x}" cy="${y}" r="${26 * s}"/><path d="M${x + 19 * s} ${y + 19 * s} l${26 * s} ${26 * s}" stroke-width="4"/>`;
const bubble = (x, y, w, h, dir = 1) => `<path d="M${x} ${y} h${w} v${h} h${-(w * 0.55)} l${-18 * dir} 22 v-22 h${-(w * 0.45 - 18)} z"/>`;
const box = (x, y, w, h, label) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4"/>` + (label ? `<path d="M${x + w * 0.16} ${y + h * 0.4} h${w * 0.68} M${x + w * 0.16} ${y + h * 0.62} h${w * 0.45}"/>` : "");
const flag = (x, y, s) => `<path d="M${x} ${y} v${-70 * s}"/><path d="M${x} ${y - 70 * s} h${46 * s} l${-12 * s} ${14 * s} l${12 * s} ${14 * s} h${-46 * s} z"/>`;
let LABELS = "";
const txt = (x, y, str, color, size = 34, anchor = "start") => {
  if (str) LABELS += `<text x="${x}" y="${y}" fill="${color}" stroke="none" font-size="${size}" font-weight="600" text-anchor="${anchor}" font-family="Caveat">${str}</text>`;
  return "";
};
const miniAtDesk = (x, y) => desk(x - 70, y + 30, 230) + terminal(x - 20, y - 56, 140, 86) + hei(x - 76, y - 4, 0.45, { legs: "none", armR: "out", armL: "none" });

// ---- archetypes ----
// Every archetype fn(r, A) → svg string; A = {blue, orange, amber} annotations.
const ARCH = {
  routing(r, A) {
    let s = "";
    s += envelope(180, 470 + J(r, 10), 86) + envelope(205, 405, 86, -6) + envelope(165, 350, 86, 4);
    s += `<path d="M300 480 C 380 490, 430 500, 500 520" marker-end="url(#ah)"/>`;
    s += desk(520, 600, 460);
    s += box(575, 560, 85, 38) + box(720, 560, 85, 38) + box(855, 560, 85, 38);
    s += hei(700, 445, 1, { legs: "none", armL: "down", armR: "out" });
    s += envelope(830, 495, 54, 8);
    s += `<path d="M955 545 C 1080 500, 1160 430, 1255 380" marker-end="url(#ah)"/>`;
    s += `<path d="M955 578 C 1100 575, 1200 570, 1295 565" marker-end="url(#ah)"/>`;
    s += `<path d="M955 605 C 1080 660, 1160 710, 1245 755" marker-end="url(#ah)"/>`;
    s += miniAtDesk(1370, 345) ;
    s += box(1330, 540, 70, 40, true);
    s += bell(1350, 780, 1) + `<path d="M1385 715 l14 -14 M1394 736 l18 -6"/>`;
    return s + txt(150, 315, A.amber || "incoming", AMBER, 30) + txt(1580, 300, A.blue, BLUE, 34, "end") + txt(1580, 845, A.orange, ORANGE, 34, "end");
  },
  fleet(r, A) {
    let s = "";
    [260, 640].forEach((x, i) => { s += hei(x - 90, 500 + J(r, 8), 0.55, { legs: "none", armR: "out", armL: "none" }) + desk(x - 50, 560, 240) + terminal(x, 456, 140, 88); });
    s += hei(950, 520, 0.9, { legs: "walk", armL: "down", armR: "out" }) + sticky(1040, 466, 46, -5);
    s += `<rect x="1170" y="330" width="330" height="360" rx="4"/><path d="M1280 330 v360 M1390 330 v360"/><path d="M1170 385 h330"/>`;
    s += sticky(1192, 405, 60, -3) + sticky(1198, 480, 60, 2) + sticky(1302, 410, 60, 3) + sticky(1412, 420, 60, 2);
    s += `<path d="M1424 500 l18 18 l30 -34" stroke-width="4"/>`;
    s += txt(1198, 368, "todo", BLUE, 28) + txt(1300, 368, "doing", BLUE, 28) + txt(1404, 368, "done", BLUE, 28);
    return s + txt(170, 740, A.blue, BLUE, 34) + txt(880, 760, A.orange, ORANGE, 34);
  },
  kanban(r, A) {
    let s = `<rect x="960" y="270" width="440" height="440" rx="4"/><path d="M1107 270 v440 M1254 270 v440"/><path d="M960 336 h440"/>`;
    s += sticky(985, 360, 70, -3) + sticky(992, 460, 70, 2) + sticky(985, 560, 70, -2) + sticky(1130, 370, 70, 3) + sticky(1136, 470, 70, -3) + sticky(1280, 380, 70, 2);
    s += `<path d="M1298 480 l20 20 l34 -38" stroke-width="4"/>`;
    s += txt(1000, 318, "todo", BLUE, 30) + txt(1145, 318, "doing", BLUE, 30) + txt(1290, 318, "done", BLUE, 30);
    s += hei(700, 480, 1, { legs: "walk", armR: "out", armL: "down" }) + sticky(800, 420, 52, -6);
    return s + txt(180, 400, A.blue, BLUE, 34) + txt(240, 760, A.orange, ORANGE, 34);
  },
  memory(r, A) {
    let s = `<rect x="1020" y="250" width="380" height="470" rx="4"/>`;
    [0, 1, 2, 3].forEach(i => { s += `<rect x="1050" y="${280 + i * 110}" width="320" height="84" rx="3"/><path d="M${1180} ${318 + i * 110} h60"/>`; });
    s += `<rect x="1050" y="500" width="320" height="84" rx="3" transform="translate(28 0)"/>`;
    s += hei(800, 470, 1, { legs: "stand", armR: "out", armL: "down" }) + sticky(900, 420, 48, -8);
    s += `<path d="M330 470 h180 M330 500 h140 M330 530 h160"/><rect x="300" y="430" width="240" height="140" rx="6"/>`;
    s += `<path d="M560 500 C 640 495, 680 490, 720 486" marker-end="url(#ah)"/>`;
    return s + txt(290, 400, A.amber || "today's findings", AMBER, 30) + txt(1580, 210, A.blue, BLUE, 34, "end") + txt(300, 780, A.orange, ORANGE, 34);
  },
  versus(r, A) {
    let s = box(280, 380, 260, 190, true) + `<path d="M280 430 h260"/><circle cx="302" cy="405" r="4"/><circle cx="320" cy="405" r="4"/>`;
    s += box(1060, 380, 260, 190, true) + `<path d="M1060 430 h260"/><circle cx="1082" cy="405" r="4"/><circle cx="1100" cy="405" r="4"/>`;
    s += hei(800, 480, 1, { legs: "stand", armR: "up", armL: "down" }) + magnifier(880, 380, 1);
    s += `<text x="800" y="330" fill="${INK}" stroke="none" font-size="52" font-weight="600" text-anchor="middle" font-family="Caveat">vs</text>`;
    return s + txt(410, 350, A.blue, BLUE, 34, "middle") + txt(1190, 350, A.blue2 || "", BLUE, 34, "middle") + txt(800, 790, A.orange, ORANGE, 34, "middle");
  },
  guard(r, A) {
    let s = shield(660, 440, 1.7) + `<path d="M660 640 v100"/>`;
    s += hei(920, 500, 1, { legs: "stand", armL: "out", armR: "down" });
    s += bolt(330, 300, 1.2) + bolt(270, 470, 1) + bolt(350, 610, 1.1);
    s += `<path d="M420 330 C 480 360, 520 380, 560 400" marker-end="url(#ah)"/>`;
    s += `<path d="M420 620 C 480 600, 520 590, 565 575" marker-end="url(#ah)"/>`;
    return s + txt(230, 240, A.amber || "untrusted input", AMBER, 30) + txt(660, 250, A.blue, BLUE, 34, "middle") + txt(1000, 760, A.orange, ORANGE, 34);
  },
  night(r, A) {
    let s = moonzzz(220, 200);
    // sleeper: head down on the desk, closed eyes, zzz handled by moon
    s += desk(300, 610, 320);
    s += `<g transform="rotate(-14 450 540)"><ellipse cx="450" cy="540" rx="58" ry="70" fill="${YEL}" stroke="${INK}"/><path d="M424 528 c 5 5 12 5 17 0 M456 524 c 5 5 12 5 17 0"/></g>`;
    s += `<path d="M340 610 C 400 585, 520 585, 600 605"/>`; // blanket over the desk edge
    s += miniAtDesk(900, 500) + miniAtDesk(1260, 500);
    s += clock(1440, 220, 60);
    return s + txt(300, 780, A.orange, ORANGE, 34) + txt(900, 740, A.blue, BLUE, 34);
  },
  wire(r, A) {
    let s = bolt(220, 300, 1.4);
    s += `<path d="M290 380 C 400 430, 500 450, 590 460" marker-end="url(#ah)"/>`;
    s += bell(680, 440, 1.3) + `<path d="M745 360 l16 -16 M755 385 l20 -8"/>`;
    s += `<path d="M760 480 C 850 520, 900 540, 960 555" marker-end="url(#ah)"/>`;
    s += hei(1090, 480, 1, { legs: "walk", armL: "down", armR: "out" });
    s += desk(1180, 610, 260) + terminal(1230, 500, 150, 96);
    return s + txt(170, 240, A.blue, BLUE, 34) + txt(1000, 760, A.orange, ORANGE, 34);
  },
  stack(r, A) {
    let s = "";
    [0, 1, 2].forEach(i => { s += box(620, 600 - i * 92, 300 - i * 30, 84, true); });
    s += hei(1080, 420, 1, { legs: "stand", armL: "up", armR: "down" });
    s += box(940, 300, 220, 80, true);
    s += `<path d="M1010 340 C 950 360, 900 390, 860 415" marker-end="url(#ah)"/>`;
    return s + txt(400, 300, A.blue, BLUE, 34) + txt(560, 790, A.orange, ORANGE, 34);
  },
  loop(r, A) {
    let s = `<path d="M 800 250 C 1020 250, 1120 380, 1120 470 C 1120 600, 990 690, 800 690 C 610 690, 480 600, 480 470 C 480 390, 550 290, 700 258" marker-end="url(#ah)"/>`;
    s += hei(800, 470, 1, { legs: "walk", armL: "out", armR: "down" });
    s += `<path d="M1120 470 C 1190 470, 1260 440, 1330 400" marker-end="url(#ah)"/><path d="M1350 360 l20 24 l38 -44" stroke-width="4"/>`;
    return s + txt(430, 200, A.blue, BLUE, 34) + txt(1180, 320, A.amber || "exit: done", AMBER, 30) + txt(560, 800, A.orange, ORANGE, 34);
  },
  ledger(r, A) {
    let s = desk(420, 600, 500);
    s += hei(560, 460, 1, { legs: "none", armL: "down", armR: "out" });
    s += coins(760, 570, 4) + coins(840, 570, 6);
    s += `<rect x="940" y="380" width="180" height="230" rx="4"/><path d="M965 420 h130 M965 460 h90 M965 500 h130 M965 540 h70"/><path d="M940 610 l20 16 l24 -16 l24 16 l24 -16 l24 16 l24 -16 l20 16"/>`;
    return s + txt(1180, 350, A.blue, BLUE, 34) + txt(300, 780, A.orange, ORANGE, 34);
  },
  book(r, A) {
    let s = book(480, 380, 640);
    s += hei(360, 560, 0.9, { legs: "stand", armR: "out", armL: "down" });
    s += `<path d="M1120 300 C 1050 330, 1000 360, 960 390" marker-end="url(#ah)"/>`;
    return s + txt(1140, 280, A.blue, BLUE, 34) + txt(520, 820, A.orange, ORANGE, 34);
  },
  terminal(r, A) {
    let s = terminal(500, 260, 620, 380);
    s += `<path d="M560 560 h30 l-12 -12 m12 12 l-12 12" stroke-width="3"/>`;
    s += hei(390, 560, 0.95, { legs: "none", armR: "out", armL: "none" });
    s += desk(330, 660, 900);
    return s + txt(1160, 300, A.blue, BLUE, 34) + txt(360, 800, A.orange, ORANGE, 34);
  },
  ship(r, A) {
    let s = `<path d="M340 700 L1320 700"/>`;
    s += box(760, 540, 230, 160, true) + flag(875, 540, 1.3);
    s += hei(620, 555, 1, { legs: "walk", armL: "down", armR: "out" });
    s += `<path d="M540 560 l-40 -10 M545 600 l-46 0 M540 640 l-40 12" />`;
    return s + txt(890, 400, A.blue, BLUE, 46, "middle") + txt(830, 790, A.orange, ORANGE, 34, "middle");
  },
  talk(r, A) {
    let s = hei(520, 520, 1, { legs: "stand", armR: "out", armL: "down" });
    s += hei(1080, 520, 1, { legs: "stand", armL: "out", armR: "down" });
    s += bubble(330, 260, 340, 110, 1) + bubble(940, 250, 360, 110, -1);
    return s + txt(360, 330, A.blue, BLUE, 32) + txt(970, 320, A.blue2 || "…", BLUE, 32) + txt(560, 790, A.orange, ORANGE, 34);
  },
  spotlight(r, A) {
    let s = `<path d="M700 640 l-70 120 M820 640 l70 120 M760 640 v120"/>`; // easel legs
    s += `<rect x="560" y="300" width="400" height="340" rx="6"/><path d="M560 356 h400"/>`;
    s += `<path d="M600 420 h150 M600 470 h220 M600 520 h130 M600 570 h190"/>`;
    s += hei(1140, 520, 1, { legs: "stand", armL: "out", armR: "down" });
    s += `<path d="M1046 512 C 1010 490, 985 470, 962 452"/>`;
    return s + txt(1180, 340, A.blue, BLUE, 34) + txt(440, 800, A.orange, ORANGE, 34);
  },
};

// ---- extra parts for rich scenes ----
const plant = (x, y, s = 1) => `<path d="M${x - 18 * s} ${y} h${36 * s} l${-5 * s} ${26 * s} h${-26 * s} z"/>` +
  `<path d="M${x} ${y} C ${x - 4 * s} ${y - 28 * s}, ${x - 22 * s} ${y - 34 * s}, ${x - 26 * s} ${y - 52 * s} M${x} ${y} C ${x + 2 * s} ${y - 30 * s}, ${x + 20 * s} ${y - 30 * s}, ${x + 26 * s} ${y - 50 * s} M${x} ${y} V ${y - 44 * s}"/>`;
const mug = (x, y, s = 1) => `<path d="M${x - 14 * s} ${y} v${-22 * s} h${28 * s} v${22 * s} z"/><path d="M${x + 14 * s} ${y - 18 * s} c ${12 * s} 0 ${12 * s} ${14 * s} 0 ${14 * s}"/>` +
  `<path d="M${x - 4 * s} ${y - 30 * s} c 2 -4 -2 -6 0 -10 M${x + 5 * s} ${y - 30 * s} c 2 -4 -2 -6 0 -10"/>`;
const laptop = (x, y, w) => `<rect x="${x}" y="${y - w * 0.6}" width="${w}" height="${w * 0.6}" rx="4"/><path d="M${x - w * 0.08} ${y} h${w * 1.16} l${-w * 0.05} ${w * 0.09} h${-w * 1.06} z"/>` +
  `<path d="M${x + w * 0.14} ${y - w * 0.42} h${w * 0.5} M${x + w * 0.14} ${y - w * 0.3} h${w * 0.66} M${x + w * 0.14} ${y - w * 0.18} h${w * 0.4}"/>`;
const rack = (x, y, w, h) => { let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5"/>`;
  const rows = 4; for (let i = 0; i < rows; i++) { const ry = y + 12 + i * ((h - 24) / rows);
    s += `<rect x="${x + 12}" y="${ry}" width="${w - 24}" height="${(h - 24) / rows - 10}" rx="3"/><circle cx="${x + 28}" cy="${ry + (h - 24) / rows / 2 - 5}" r="4"/><path d="M${x + w - 52} ${ry + (h - 24) / rows / 2 - 5} h28"/>`; }
  return s; };
const cloudS = (x, y, s = 1) => `<path d="M${x} ${y} a${26 * s} ${26 * s} 0 0 1 ${24 * s} ${-30 * s} a${30 * s} ${30 * s} 0 0 1 ${58 * s} ${-4 * s} a${22 * s} ${22 * s} 0 0 1 ${20 * s} ${34 * s} z"/>`;
const keyI = (x, y, s = 1) => `<circle cx="${x}" cy="${y}" r="${13 * s}"/><path d="M${x + 11 * s} ${y + 8 * s} l${34 * s} ${24 * s}"/><path d="M${x + 30 * s} ${y + 21 * s} l${-7 * s} ${9 * s} M${x + 41 * s} ${y + 29 * s} l${-7 * s} ${9 * s}"/>`;
const wrench = (x, y, s = 1) => `<path d="M${x} ${y} a${12 * s} ${12 * s} 0 1 0 ${8 * s} ${-20 * s} l${4 * s} ${-10 * s} a${16 * s} ${16 * s} 0 0 1 ${-20 * s} ${20 * s} z" transform="rotate(28 ${x} ${y})"/><path d="M${x + 4 * s} ${y + 4 * s} l${34 * s} ${34 * s}" stroke-width="5"/>`;
const browserW = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7"/><path d="M${x} ${y + 34} h${w}"/>` +
  `<circle cx="${x + 18}" cy="${y + 17}" r="4"/><circle cx="${x + 34}" cy="${y + 17}" r="4"/><circle cx="${x + 50}" cy="${y + 17}" r="4"/>` +
  `<rect x="${x + 66}" y="${y + 8}" width="${w * 0.6}" height="18" rx="9"/>`;
const checklist = (x, y, w, rows) => { let s = `<rect x="${x}" y="${y}" width="${w}" height="${rows.length * 44 + 26}" rx="6"/>`;
  rows.forEach((r, i) => { const ry = y + 30 + i * 44;
    s += `<rect x="${x + 16}" y="${ry - 14}" width="20" height="20" rx="4"/>`;
    if (r) s += `<path d="M${x + 20} ${ry - 5} l5 6 l10 -13" stroke-width="3.4"/>`;
    s += `<path d="M${x + 50} ${ry - 4} h${w * 0.5}"/>`; });
  return s; };
const diffdoc = (x, y, w, h) => { let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5"/><path d="M${x + w / 2} ${y} v${h}"/>`;
  for (let i = 0; i < 4; i++) { const ry = y + h * 0.18 + i * h * 0.19;
    s += `<path d="M${x + w * 0.08} ${ry} h${w * 0.3}"/><path d="M${x + w * 0.58} ${ry} h${w * 0.3}"/>`; }
  s += `<text x="${x + w * 0.08}" y="${y + h * 0.12}" font-size="26" fill="${INK}" stroke="none" font-family="Caveat">−</text>` +
       `<text x="${x + w * 0.58}" y="${y + h * 0.12}" font-size="26" fill="${INK}" stroke="none" font-family="Caveat">+</text>`;
  return s; };
const gauge = (x, y, r) => `<path d="M${x - r} ${y} a${r} ${r} 0 0 1 ${2 * r} 0"/><path d="M${x} ${y} L${x + r * 0.55} ${y - r * 0.55}" stroke-width="4"/><circle cx="${x}" cy="${y}" r="4"/>`;
const chip = (x, y, w, label) => `<rect x="${x}" y="${y}" width="${w}" height="34" rx="17"/>` + txt(x + w / 2, y + 24, label, BLUE, 24, "middle");
const stampI = (x, y, s = 1) => `<path d="M${x - 20 * s} ${y} h${40 * s} v${8 * s} h${-40 * s} z M${x - 8 * s} ${y} v${-16 * s} a${8 * s} ${8 * s} 0 0 1 ${16 * s} 0 v${16 * s}"/>`;

// Bespoke rich hero scenes for flagship guides — keyed by slug, they override
// the archetype. Denser: more props, more story, a few more (short) labels.
const RICH = {
  "your-first-hour-with-munder-difflin"(r, A) {
    let s = `<path d="M120 700 L1480 700"/>`;
    // stage 1: the download box
    s += box(150, 590, 120, 100) + `<path d="M210 610 v40 m-14 -14 l14 14 l14 -14"/>`;
    s += txt(140, 560, "min 0 — install", AMBER, 28);
    // stage 2: wizard checklist
    s += checklist(390, 480, 220, [true, true, true, false]);
    s += txt(390, 452, "min 5 — meet your clone", BLUE, 28);
    // stage 3: brief Michael at his desk
    s += desk(720, 620, 300) + terminal(770, 500, 170, 100) + hei(700, 560, 0.72, { legs: "none", armR: "out", armL: "none" });
    s += bubble(640, 350, 250, 84, 1) + txt(672, 402, "brief him once", BLUE, 26);
    s += mug(1000, 618, 1) + plant(1090, 690, 1);
    // stage 4: kanban + clock, walk away
    s += `<rect x="1180" y="470" width="220" height="180" rx="4"/><path d="M1253 470 v180 M1326 470 v180"/><path d="M1180 505 h220"/>`;
    s += sticky(1196, 520, 42, -3) + sticky(1268, 526, 42, 3) + sticky(1340, 520, 42, -2) + `<path d="M1348 578 l12 12 l20 -24" stroke-width="3.6"/>`;
    s += clock(1450, 380, 52);
    s += hei(1130, 380, 0.62, { legs: "walk", armL: "down", armR: "out" });
    s += envelope(1030, 260, 56, 8);
    s += txt(1170, 690, "min 60 — walk away", ORANGE, 30);
    // journey arrows
    s += `<path d="M290 640 C 330 640, 350 620, 380 600" marker-end="url(#ah)"/>`;
    s += `<path d="M620 580 C 650 590, 670 600, 700 610" marker-end="url(#ah)"/>`;
    s += `<path d="M1040 580 C 1090 570, 1120 555, 1165 540" marker-end="url(#ah)"/>`;
    return s + txt(150, 240, "one hour, four moves", BLUE, 34);
  },
  "how-to-install-and-use-munder-difflin"(r, A) {
    let s = `<path d="M140 700 L1460 700"/>`;
    // big terminal running the install
    s += terminal(430, 250, 480, 300);
    s += txt(470, 480, "npm install && npm run dev", BLUE, 27);
    // three platform boxes
    [["macOS", 430], ["Windows", 600], ["Linux", 770]].forEach(([lbl, x]) => {
      s += box(x, 590, 140, 84, false) + txt(x + 70, 645, lbl, BLUE, 26, "middle");
    });
    // prerequisites panel
    s += checklist(1080, 260, 250, [true, true, true, true]);
    s += txt(1085, 232, "prerequisites: all green", AMBER, 27);
    // Hei carrying a box toward the desk, with tools
    s += hei(250, 520, 0.9, { legs: "walk", armL: "up", armR: "up" });
    s += box(200, 380, 110, 70);
    s += wrench(1130, 560, 1);
    s += plant(1420, 690, 1.1) + mug(1010, 588, 1);
    s += `<path d="M950 400 C 1010 390, 1030 380, 1070 360" marker-end="url(#ah)"/>`;
    return s + txt(150, 240, "ten engines, one office", BLUE, 32) + txt(950, 780, A.orange || "from zero to a working hive", ORANGE, 34);
  },
  "run-munder-difflin-on-open-models"(r, A) {
    let s = `<path d="M120 700 L1480 700"/>`;
    // left: your machine
    s += desk(180, 620, 380) + laptop(260, 560, 180);
    s += chip(200, 640, 190, "local/gpt-oss:20b") + mug(560, 618, 0.9);
    s += txt(180, 300, "your machine", BLUE, 30) + txt(180, 338, "private · no per-token bill", AMBER, 24);
    // right: provider rack + cloud
    s += rack(1160, 380, 260, 240) + cloudS(1310, 250, 0.9);
    s += chip(1150, 650, 280, "openrouter/deepseek-v4");
    s += txt(1140, 300, "provider GPUs", BLUE, 30) + txt(1140, 338, "frontier scale · your key", AMBER, 24);
    // center: Hei with the key, cables to both
    s += hei(790, 500, 1, { legs: "stand", armL: "out", armR: "out" });
    s += keyI(770, 350, 1.1);
    s += `<path d="M700 520 C 600 540, 520 550, 450 560" marker-end="url(#ah)"/>`;
    s += `<path d="M880 520 C 990 540, 1060 545, 1140 540" marker-end="url(#ah)"/>`;
    return s + txt(620, 790, A.orange || "your floor, your weights", ORANGE, 34);
  },
  "deploy-a-blog-writer-agent"(r, A) {
    let s = `<path d="M110 700 L1490 700"/>`;
    // writer desk: papers + style book
    s += desk(150, 620, 330) + terminal(200, 505, 150, 95) + hei(160, 560, 0.66, { legs: "none", armR: "out", armL: "none" });
    s += `<rect x="370" y="560" width="70" height="8" rx="2"/><rect x="365" y="548" width="70" height="8" rx="2"/><rect x="372" y="536" width="70" height="8" rx="2"/>`;
    s += book(300, 660, 120);
    s += txt(150, 460, "draft, in a worktree", BLUE, 27);
    // Michael integrates: stamp
    s += desk(620, 620, 260) + hei(700, 545, 0.7, { legs: "none", armL: "down", armR: "up" });
    s += stampI(790, 512, 1.2);
    s += txt(610, 452, "one committer", AMBER, 26);
    // build: blocks
    s += box(960, 560, 90, 60, true) + box(985, 495, 90, 60, true);
    // live site
    s += browserW(1130, 420, 320, 210);
    s += txt(1210, 462, "munderdiffl.in/blog", BLUE, 23);
    s += `<path d="M1180 500 h220 M1180 540 h160 M1180 580 h190"/>`;
    // human gate before the site
    s += bell(1090, 350, 1) + `<path d="M1130 290 l14 -14 M1140 312 l18 -6"/>`;
    s += txt(1010, 260, "one human gate: publish", ORANGE, 28);
    // flow arrows
    s += `<path d="M490 590 C 540 590, 560 585, 605 580" marker-end="url(#ah)"/>`;
    s += `<path d="M890 580 C 920 575, 930 570, 950 565" marker-end="url(#ah)"/>`;
    s += `<path d="M1080 520 C 1100 510, 1110 505, 1125 500" marker-end="url(#ah)"/>`;
    s += plant(560, 690, 1) + mug(905, 618, 0.9) + envelope(520, 400, 54, -8);
    return s + txt(150, 250, "the blog that writes itself", BLUE, 33);
  },
  "deploy-automated-pr-reviewer-agent"(r, A) {
    let s = `<path d="M110 700 L1490 700"/>`;
    // incoming PR envelopes on a conveyor
    s += `<path d="M150 470 h300"/><circle cx="190" cy="486" r="14"/><circle cx="300" cy="486" r="14"/><circle cx="410" cy="486" r="14"/>`;
    s += envelope(170, 400, 78, -5) + envelope(280, 405, 78, 4) + envelope(390, 398, 78, -2);
    s += txt(160, 360, "PRs + issues, all of them", BLUE, 27);
    // reviewer reading the real diff
    s += desk(620, 620, 320) + hei(690, 545, 0.8, { legs: "none", armR: "out", armL: "none" });
    s += diffdoc(790, 420, 210, 180) + magnifier(770, 480, 1);
    s += txt(620, 380, "reads the real source", AMBER, 27);
    // dupes funnel into one finding
    s += `<path d="M1090 430 L1210 430 L1180 520 L1120 520 z"/>`;
    s += sticky(1098, 380, 34, -6) + sticky(1140, 372, 34, 4) + sticky(1180, 382, 34, -3);
    s += box(1110, 560, 90, 62, true);
    s += txt(1230, 400, "dupes in", AMBER, 24) + txt(1230, 600, "one finding out", AMBER, 24);
    // escalation: flag + bell to you
    s += flag(1390, 560, 1.2) + bell(1400, 660, 0.9);
    s += `<path d="M1210 590 C 1280 585, 1320 580, 1360 570" marker-end="url(#ah)"/>`;
    s += `<path d="M470 440 C 530 460, 560 480, 600 520" marker-end="url(#ah)"/>`;
    s += mug(960, 618, 0.9) + plant(560, 690, 1);
    return s + txt(1010, 780, A.orange || "pings you only when it matters", ORANGE, 32);
  },
};

// Bespoke rich note vignettes, keyed "slug#n" — override NOTES for these posts.
const RICHNOTE = {
  "your-first-hour-with-munder-difflin#1"(r) {
    let s = checklist(360, 130, 300, [true, true, true, true]);
    s += txt(370, 105, "git ✓  node ✓  uv ✓  engines ✓", AMBER, 26);
    s += hei(850, 330, 0.8, { legs: "stand", armL: "out", armR: "down" }) + wrench(950, 240, 0.9);
    return s;
  },
  "your-first-hour-with-munder-difflin#2"(r) {
    let s = desk(320, 420, 560) + terminal(380, 250, 240, 150);
    s += gauge(760, 330, 54) + txt(700, 410, "context left", BLUE, 25);
    s += hei(280, 350, 0.66, { legs: "none", armR: "out", armL: "none" }) + mug(680, 418, 0.9);
    return s;
  },
  "how-to-install-and-use-munder-difflin#1"(r) {
    let s = checklist(380, 110, 320, [true, true, false, true]);
    s += txt(390, 88, "prerequisites", AMBER, 26);
    s += hei(880, 320, 0.8, { legs: "stand", armR: "out", armL: "down" });
    s += bubble(940, 130, 200, 78, -1) + txt(975, 178, "I'll install it", BLUE, 24);
    return s;
  },
  "how-to-install-and-use-munder-difflin#2"(r) {
    let s = `<rect x="380" y="110" width="330" height="330" rx="8"/>`;
    s += `<path d="M410 170 h180 M410 225 h240 M410 280 h150 M410 335 h210"/>`;
    s += hei(560, 395, 0.42, { legs: "none", armL: "none", armR: "none" });
    s += txt(400, 92, "add agent", BLUE, 26);
    s += `<path d="M730 280 C 790 285, 820 290, 860 300" marker-end="url(#ah)"/>`;
    s += miniAtDesk(950, 290);
    return s;
  },
  "run-munder-difflin-on-open-models#1"(r) {
    let s = chip(230, 160, 230, "local/gpt-oss:20b");
    s += chip(230, 250, 250, "ollama/qwen3:30b");
    s += chip(230, 340, 320, "openrouter/deepseek-v4");
    s += txt(240, 130, "same model, three prefixes", AMBER, 26);
    s += hei(820, 310, 0.8, { legs: "stand", armL: "out", armR: "down" }) + magnifier(730, 230, 0.9);
    return s;
  },
  "run-munder-difflin-on-open-models#2"(r) {
    let s = keyI(280, 210, 1.2) + box(480, 160, 190, 110, true);
    s += txt(490, 140, "write-only broker", AMBER, 25);
    s += `<path d="M330 240 C 390 235, 420 225, 470 215" marker-end="url(#ah)"/>`;
    s += `<path d="M680 215 C 750 225, 790 245, 840 270" marker-end="url(#ah)"/>`;
    s += miniAtDesk(950, 290);
    return s;
  },
  "deploy-a-blog-writer-agent#1"(r) {
    let s = "";
    const stages = ["brief", "draft", "commit", "build", "gate"];
    stages.forEach((t, i) => {
      const x = 190 + i * 190;
      s += box(x, 230, 130, 84, false) + txt(x + 65, 285, t, BLUE, 26, "middle");
      if (i < 4) s += `<path d="M${x + 138} 272 C ${x + 158} 272, ${x + 165} 272, ${x + 182} 272" marker-end="url(#ah)"/>`;
    });
    s += clock(1090, 150, 44);
    s += `<path d="M1055 380 l14 16 l26 -30" stroke-width="4"/>`;
    return s;
  },
  "deploy-a-blog-writer-agent#2"(r) {
    let s = hei(400, 300, 0.85, { legs: "stand", armR: "up", armL: "down" }) + stampI(505, 210, 1.2);
    s += browserW(640, 150, 300, 200);
    s += `<path d="M690 230 h200 M690 270 h150 M690 310 h180"/>`;
    s += `<path d="M960 250 l20 22 l36 -42" stroke-width="4"/>`;
    return s;
  },
  "deploy-automated-pr-reviewer-agent#1"(r) {
    let s = diffdoc(420, 120, 300, 260) + magnifier(400, 260, 1.2);
    s += hei(280, 330, 0.75, { legs: "stand", armR: "out", armL: "down" });
    s += txt(760, 180, "the diff, not the description", AMBER, 26);
    return s;
  },
  "deploy-automated-pr-reviewer-agent#2"(r) {
    let s = envelope(220, 140, 66, -6) + envelope(310, 130, 66, 5) + envelope(260, 220, 66, 2) + envelope(350, 210, 66, -3);
    s += `<path d="M440 220 L620 220 L580 320 L480 320 z"/>`;
    s += box(500, 360, 90, 64, true);
    s += `<path d="M600 390 C 680 385, 730 375, 790 360" marker-end="url(#ah)"/>`;
    s += bell(880, 350, 1.1) + `<path d="M935 275 l16 -16 M945 300 l22 -8"/>`;
    s += txt(700, 160, "noise in, signal out", AMBER, 27);
    return s;
  },
};

// ---- inline note vignettes (1200x560) ----
// Small mid-post sketches. One or two parts, at most a tiny fixed label —
// the post's own figcaption (if any) carries the meaning. Two variants per
// archetype; per-slug rng keeps every render's jitter + wobble unique.
const NOTE_W = 1200, NOTE_H = 560;
const V = {
  mail(r) {
    let s = envelope(300 + J(r, 20), 300, 96, -6) + envelope(430, 230 + J(r, 16), 96, 5) + envelope(390, 370, 96, 2);
    s += `<path d="M560 310 C 660 305, 720 300, 790 296" marker-end="url(#ah)"/>`;
    s += box(820, 240, 150, 120) + `<path d="M845 300 h100"/>`;
    return s + txt(842, 220, "inbox", AMBER, 28);
  },
  bell(r) {
    let s = bell(500, 300 + J(r, 10), 1.5) + `<path d="M585 200 l18 -18 M600 232 l24 -8 M415 200 l-18 -18 M400 232 l-24 -8"/>`;
    s += hei(800, 330, 0.85, { legs: "walk", armL: "up", armR: "up" });
    return s;
  },
  desks(r) {
    return miniAtDesk(360, 280 + J(r, 8)) + miniAtDesk(800, 280 + J(r, 8));
  },
  board(r) {
    let s = `<rect x="420" y="120" width="440" height="330" rx="4"/><path d="M567 120 v330 M714 120 v330"/><path d="M420 180 h440"/>`;
    s += sticky(445, 205 + J(r, 6), 62, -3) + sticky(452, 295, 62, 2) + sticky(590, 210, 62, 3) + sticky(740, 220 + J(r, 6), 62, -2);
    s += `<path d="M756 310 l18 18 l30 -34" stroke-width="4"/>`;
    return s + txt(455, 165, "todo", BLUE, 26) + txt(598, 165, "doing", BLUE, 26) + txt(748, 165, "done", BLUE, 26);
  },
  cards(r) {
    let s = "";
    [0, 1, 2].forEach(i => { s += `<rect x="${470 + J(r, 6)}" y="${180 + i * 96}" width="300" height="76" rx="3"/><path d="M${595} ${216 + i * 96} h60"/>`; });
    s += hei(320, 330, 0.8, { legs: "stand", armR: "out", armL: "down" }) + sticky(400, 280, 42, -8);
    return s;
  },
  vs(r) {
    let s = box(260, 200 + J(r, 8), 230, 170, true) + box(710, 200 + J(r, 8), 230, 170, true);
    s += `<text x="600" y="300" fill="${INK}" stroke="none" font-size="48" font-weight="600" text-anchor="middle" font-family="Caveat">vs</text>`;
    s += hei(1030, 340, 0.75, { legs: "stand", armL: "out", armR: "down" }) + magnifier(950, 260, 0.9);
    return s;
  },
  shield(r) {
    let s = shield(560, 260 + J(r, 8), 1.3) + bolt(300, 160, 1) + bolt(260, 330, 0.9);
    s += `<path d="M350 200 C 410 230, 440 250, 470 268" marker-end="url(#ah)"/>`;
    s += hei(830, 330, 0.8, { legs: "stand", armL: "out", armR: "down" });
    return s;
  },
  sleep(r) {
    let s = desk(380, 380, 320);
    s += `<g transform="rotate(-14 530 310)"><ellipse cx="530" cy="310" rx="52" ry="62" fill="${YEL}" stroke="${INK}"/><path d="M506 300 c 5 5 12 5 17 0 M536 296 c 5 5 12 5 17 0"/></g>`;
    s += `<text x="640" y="200" font-size="40" fill="${INK}" stroke="none" font-family="Caveat">z</text><text x="672" y="170" font-size="32" fill="${INK}" stroke="none" font-family="Caveat">z</text><text x="696" y="146" font-size="25" fill="${INK}" stroke="none" font-family="Caveat">z</text>`;
    s += terminal(760, 240, 130, 82);
    return s;
  },
  nightowl(r) {
    return moonzzz(360, 180 + J(r, 8)) + clock(800, 280, 66);
  },
  loop(r) {
    let s = `<path d="M 600 140 C 780 140, 860 220, 860 290 C 860 380, 760 440, 600 440 C 440 440, 340 380, 340 290 C 340 235, 390 165, 510 145" marker-end="url(#ah)"/>`;
    s += hei(600, 290, 0.8, { legs: "walk", armL: "out", armR: "down" });
    s += `<path d="M880 260 l18 22 l34 -40" stroke-width="4"/>`;
    return s;
  },
  coins(r) {
    let s = desk(380, 400, 460);
    s += coins(520, 370, 3 + Math.floor(r() * 3)) + coins(610, 370, 5);
    s += `<rect x="700" y="200" width="150" height="190" rx="4"/><path d="M722 240 h106 M722 275 h70 M722 310 h106"/><path d="M700 390 l16 13 l20 -13 l20 13 l20 -13 l20 13 l20 -13 l20 13"/>`;
    return s;
  },
  book(r) {
    return book(400, 210 + J(r, 8), 440) + hei(300, 350, 0.72, { legs: "stand", armR: "out", armL: "down" });
  },
  term(r) {
    let s = terminal(430, 130, 430, 260);
    s += `<path d="M470 340 h24 l-10 -10 m10 10 l-10 10" stroke-width="3"/>`;
    s += hei(340, 350, 0.7, { legs: "none", armR: "out", armL: "none" }) + desk(290, 420, 640);
    return s;
  },
  ship(r) {
    let s = `<path d="M280 430 L940 430"/>`;
    s += box(620, 300, 190, 130, true) + flag(715, 300, 1.1);
    s += hei(470, 320, 0.8, { legs: "walk", armL: "down", armR: "out" });
    s += `<path d="M400 320 l-34 -8 M404 352 l-38 0 M400 384 l-34 10"/>`;
    return s;
  },
  chat(r) {
    let s = hei(420, 320, 0.8, { legs: "stand", armR: "out", armL: "down" });
    s += hei(800, 320, 0.8, { legs: "stand", armL: "out", armR: "down" });
    s += bubble(280, 140, 250, 86, 1) + bubble(700, 130, 260, 86, -1);
    s += txt(330, 196, "…", BLUE, 30) + txt(760, 184, "!", BLUE, 30);
    return s;
  },
  point(r) {
    let s = `<path d="M540 430 l-52 90 M640 430 l52 90 M590 430 v90"/>`;
    s += `<rect x="430" y="170" width="320" height="260" rx="6"/><path d="M430 216 h320"/>`;
    s += `<path d="M465 265 h120 M465 310 h180 M465 355 h105"/>`;
    s += hei(900, 340, 0.8, { legs: "stand", armL: "out", armR: "down" });
    s += `<path d="M826 334 C 800 318, 780 305, 762 292"/>`;
    return s;
  },
  stack(r) {
    let s = "";
    [0, 1, 2].forEach(i => { s += box(400, 430 - i * 82, 260 - i * 26, 74, true); });
    s += hei(800, 320, 0.82, { legs: "stand", armL: "up", armR: "down" });
    return s;
  },
  walk(r) {
    let s = hei(520, 300 + J(r, 8), 0.85, { legs: "walk", armL: "down", armR: "out" });
    s += envelope(610, 250, 64, 8);
    s += `<path d="M700 300 C 800 295, 860 292, 930 290" marker-end="url(#ah)"/>`;
    s += box(950, 240, 130, 110);
    return s;
  },
};

// archetype → [variant for note-1, variant for note-2]
const NOTES = {
  routing: [V.mail, V.walk],
  fleet: [V.desks, V.board],
  kanban: [V.board, V.walk],
  memory: [V.cards, V.book],
  versus: [V.vs, V.point],
  guard: [V.shield, V.bell],
  night: [V.sleep, V.nightowl],
  wire: [V.bell, V.term],
  stack: [V.stack, V.point],
  loop: [V.loop, V.bell],
  ledger: [V.coins, V.board],
  book: [V.book, V.point],
  terminal: [V.term, V.walk],
  ship: [V.ship, V.board],
  talk: [V.chat, V.mail],
  spotlight: [V.point, V.chat],
};

// Build a 1200x560 inline-note SVG for a spec entry. `which` = 1, 2, 3…
function buildNote(slug, spec, which) {
  const r = rng(`${slug}#note${which}`);
  const seed = Math.floor(r() * 900) + 2;
  LABELS = "";
  const rich = RICHNOTE[`${slug}#${which}`];
  const variants = NOTES[spec.a] || [V.walk, V.point];
  const inner = rich ? rich(r, spec) : variants[(which - 1) % variants.length](r, spec);
  return `<svg width="${NOTE_W}" height="${NOTE_H}" viewBox="0 0 ${NOTE_W} ${NOTE_H}" font-family="Caveat">
  <defs>
    <filter id="wob" x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="0.015" numOctaves="2" seed="${seed}" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="6"/>
    </filter>
    <marker id="ah" viewBox="0 0 12 12" refX="9" refY="6" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
      <path d="M2 2 L10 6 L2 10" fill="none" stroke="${INK}" stroke-width="2"/>
    </marker>
  </defs>
  <g filter="url(#wob)" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
${inner}
  </g>
  <g>${LABELS}</g>
</svg>`;
}

// Build the full SVG document for a spec entry.
function buildScene(slug, spec) {
  const r = rng(slug);
  const seed = Math.floor(r() * 900) + 2;
  LABELS = "";
  const inner = (RICH[slug] || ARCH[spec.a])(r, spec);
  return `<svg width="1600" height="900" viewBox="0 0 1600 900" font-family="Caveat">
  <defs>
    <filter id="wob" x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="0.015" numOctaves="2" seed="${seed}" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="6"/>
    </filter>
    <marker id="ah" viewBox="0 0 12 12" refX="9" refY="6" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
      <path d="M2 2 L10 6 L2 10" fill="none" stroke="${INK}" stroke-width="2"/>
    </marker>
  </defs>
  <g filter="url(#wob)" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
${inner}
  </g>
  <g>${LABELS}</g>
</svg>`;
}
