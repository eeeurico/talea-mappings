#!/usr/bin/env node
// Regenerates index.json from mappings/**/*.meta.json.
//
// Every mapping is a pair of files:
//   mappings/<manufacturer>/<controller>.json       the mapping Talea imports
//   mappings/<manufacturer>/<controller>.meta.json  catalog metadata
//
// The mapping file must match the app's schema (crates/mixeee-controllers/
// src/mapping.rs in eeeurico/talea — serde-derived JSON); validation here
// mirrors those types so a broken PR fails CI instead of failing in the app.
//
// Usage: node scripts/build-index.mjs [--check]
//   --check  exit 1 if index.json is out of date instead of rewriting it

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

const errors = [];
const fail = (file, msg) => errors.push(`${file}: ${msg}`);

function walk(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(p) : [p];
  });
}

const files = walk("mappings");
const metaFiles = files.filter((f) => f.endsWith(".meta.json"));
const mappingFiles = files.filter(
  (f) => f.endsWith(".json") && !f.endsWith(".meta.json"),
);

// -- meta validation ---------------------------------------------------------

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const META_REQUIRED = ["id", "name", "manufacturer", "controller", "version"];
const META_KNOWN = [...META_REQUIRED, "author", "description"];

function readJson(file) {
  try {
    return JSON.parse(readFileSync(join(ROOT, file), "utf8"));
  } catch (e) {
    fail(file, `not valid JSON (${e.message})`);
    return null;
  }
}

// -- mapping validation (mirrors mapping.rs) ---------------------------------

const KINDS = ["fader", "button", "encoder"];
const CURVES = ["linear", "eq_db", "trim_ratio"];
const STATES = ["play", "cue", "hotcue"];

const isByte = (v) => Number.isInteger(v) && v >= 0 && v <= 255;
const isStr = (v) => typeof v === "string" && v.length > 0;

function validateMapping(file, m) {
  if (!isStr(m.device)) fail(file, `"device" must be a non-empty string`);
  if (!Array.isArray(m.bindings) || m.bindings.length === 0) {
    fail(file, `"bindings" must be a non-empty array`);
    return;
  }
  m.bindings.forEach((b, i) => {
    const at = `bindings[${i}]`;
    if (!Array.isArray(b.midi) || b.midi.length !== 2 || !b.midi.every(isByte))
      fail(file, `${at}.midi must be [status, data1] (two bytes 0-255)`);
    const t = b.target;
    if (!t || typeof t !== "object") {
      fail(file, `${at}.target missing`);
    } else if (t.type === "control") {
      if (!isStr(t.group) || !isStr(t.key))
        fail(file, `${at}: control target needs "group" and "key"`);
      if (t.kind !== undefined && !KINDS.includes(t.kind))
        fail(file, `${at}.kind must be one of ${KINDS.join("/")}`);
      if (t.curve !== undefined && !CURVES.includes(t.curve))
        fail(file, `${at}.curve must be one of ${CURVES.join("/")}`);
    } else if (t.type === "action") {
      if (!Number.isInteger(t.deck) || t.deck < 1)
        fail(file, `${at}.deck must be a 1-based deck number`);
      if (!isStr(t.action)) fail(file, `${at}.action must be a string`);
      if (t.arg !== undefined && typeof t.arg !== "number")
        fail(file, `${at}.arg must be a number when present`);
      if (t.on_release !== undefined && typeof t.on_release !== "boolean")
        fail(file, `${at}.on_release must be a boolean when present`);
    } else {
      fail(file, `${at}.target.type must be "control" or "action"`);
    }
  });
  (m.outputs ?? []).forEach((o, i) => {
    const at = `outputs[${i}]`;
    if (!Number.isInteger(o.deck) || o.deck < 1)
      fail(file, `${at}.deck must be a 1-based deck number`);
    if (!STATES.includes(o.state))
      fail(file, `${at}.state must be one of ${STATES.join("/")}`);
    if (o.index !== undefined && !isByte(o.index))
      fail(file, `${at}.index must be a byte when present`);
    if (!isByte(o.status) || !isByte(o.data1))
      fail(file, `${at} needs byte "status" and "data1"`);
    for (const k of ["on", "off"])
      if (o[k] !== undefined && !isByte(o[k]))
        fail(file, `${at}.${k} must be a byte when present`);
  });
}

// -- build -------------------------------------------------------------------

const ids = new Set();
const entries = [];

for (const metaFile of metaFiles) {
  const meta = readJson(metaFile);
  if (!meta) continue;

  for (const k of META_REQUIRED)
    if (!isStr(meta[k])) fail(metaFile, `missing required field "${k}"`);
  for (const k of Object.keys(meta))
    if (!META_KNOWN.includes(k)) fail(metaFile, `unknown field "${k}"`);
  if (isStr(meta.id) && !KEBAB.test(meta.id))
    fail(metaFile, `"id" must be kebab-case (got "${meta.id}")`);
  if (isStr(meta.version) && !SEMVER.test(meta.version))
    fail(metaFile, `"version" must be semver x.y.z (got "${meta.version}")`);
  if (ids.has(meta.id)) fail(metaFile, `duplicate id "${meta.id}"`);
  ids.add(meta.id);

  const mappingFile = metaFile.replace(/\.meta\.json$/, ".json");
  if (!mappingFiles.includes(mappingFile)) {
    fail(metaFile, `no sibling mapping file ${mappingFile}`);
    continue;
  }
  const mapping = readJson(mappingFile);
  if (mapping) validateMapping(mappingFile, mapping);

  entries.push({
    id: meta.id,
    name: meta.name,
    manufacturer: meta.manufacturer,
    controller: meta.controller,
    author: meta.author ?? "",
    description: meta.description ?? "",
    version: meta.version,
    file: mappingFile,
  });
}

for (const f of mappingFiles)
  if (!metaFiles.includes(f.replace(/\.json$/, ".meta.json")))
    fail(f, `no sibling ${f.replace(/\.json$/, ".meta.json")} — every mapping needs catalog metadata`);

if (errors.length) {
  console.error(`✗ ${errors.length} problem(s):\n`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

entries.sort(
  (a, b) =>
    a.manufacturer.localeCompare(b.manufacturer) || a.name.localeCompare(b.name),
);

const index = JSON.stringify({ version: 1, mappings: entries }, null, 2) + "\n";
const indexPath = join(ROOT, "index.json");

let current = null;
try {
  current = readFileSync(indexPath, "utf8");
} catch {}

if (CHECK) {
  if (current !== index) {
    console.error("✗ index.json is out of date — run: node scripts/build-index.mjs");
    process.exit(1);
  }
  console.log(`✓ ${entries.length} mapping(s) valid, index.json up to date`);
} else {
  writeFileSync(indexPath, index);
  console.log(`✓ ${entries.length} mapping(s) valid, index.json written`);
}
