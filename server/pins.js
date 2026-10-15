#!/usr/bin/env node
/* Lineup PINs. Stores only salted hashes in data/pins.json and prints the
   new PINs once, so hand them out right away.

   node server/pins.js            new PINs for every team that doesn't have one, plus commish
   node server/pins.js 0005       reset one team's PIN
   node server/pins.js commish    reset the commissioner PIN
   node server/pins.js --all      reset everyone */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const PINS_FILE = path.join(DATA_DIR, "pins.json");

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, "league-data.js"), "utf8"), sandbox);
const L = sandbox.window.LEAGUE;

const hash = (pin) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return `scrypt$${salt}$${crypto.scryptSync(pin, salt, 32).toString("hex")}`;
};
const newPin = (digits) => String(crypto.randomInt(0, 10 ** digits)).padStart(digits, "0");

let pins = { teams: {} };
try { pins = JSON.parse(fs.readFileSync(PINS_FILE, "utf8")); } catch {}
pins.teams = pins.teams || {};

const arg = process.argv[2];
const known = new Set(L.teams.map(t => t.id));
let targets;
if (arg === "--all") targets = [...known, "commish"];
else if (arg === "commish") targets = ["commish"];
else if (arg) {
  if (!known.has(arg)) { console.error(`Unknown team "${arg}". Team IDs: ${[...known].join(", ")}`); process.exit(1); }
  targets = [arg];
} else {
  targets = [...known].filter(id => !pins.teams[id]);
  if (!pins.commish) targets.push("commish");
}

if (!targets.length) { console.log("Everyone already has a PIN. Pass a team ID, 'commish' or --all to reset."); process.exit(0); }

console.log("New PINs (shown once, not stored in plain text):\n");
for (const id of targets) {
  const pin = newPin(id === "commish" ? 8 : 6);
  if (id === "commish") pins.commish = hash(pin);
  else pins.teams[id] = hash(pin);
  const name = id === "commish" ? "Commissioner" : `${id}  ${L.teams.find(t => t.id === id).name}`;
  console.log(`  ${name.padEnd(28)} ${pin}`);
}
fs.mkdirSync(path.dirname(PINS_FILE), { recursive: true });
fs.writeFileSync(PINS_FILE, JSON.stringify(pins, null, 2));
console.log(`\nSaved hashes to ${path.relative(ROOT, PINS_FILE)}.`);
