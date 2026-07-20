#!/usr/bin/env bun
/**
 * Régénère `e2e/valeurs-sensibles.txt` à partir des fixtures du projet de test
 * (`pasteguard-test/fixtures/clients.txt`, `env.fake`). Extraction déterministe
 * par regex ciblées (une par type de PII/secret connu du moteur, cf.
 * `integrations/claude-code/README.md`), pas de dépendance au détecteur.
 *
 * Le fichier généré est le SEUL utilisé par `run.ts` au moment du grep
 * anti-fuite : il est committé et sert de référence stable. Relancer ce
 * script après toute modification des fixtures :
 *
 *   bun run integrations/claude-code/e2e/build-valeurs-sensibles.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TEST_PROJECT_DIR =
  process.env.PASTEGUARD_E2E_PROJECT_DIR ?? "/Users/jb/Documents/MyProjects/LOCAL/pasteguard-test";
const FIXTURES = ["fixtures/clients.txt", "fixtures/env.fake"];
const OUTPUT_FILE = join(import.meta.dir, "valeurs-sensibles.txt");
const MIN_LENGTH = 6;

/** Une regex par type reconnu (PII et secrets, cf. README) + un repli générique. */
const GLOBAL_PATTERNS: RegExp[] = [
  // EMAIL_ADDRESS
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // IP_ADDRESS
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
  // IBAN_CODE (groupes espacés)
  /\bFR\d{2}(?:\s?[0-9A-Z]{4}){2,7}\s?[0-9A-Z]{1,4}\b/g,
  // VAT_CODE (FR + 11 chiffres collés, pas d'espace)
  /\bFR\d{2}\d{9}\b/g,
  // PHONE_NUMBER (formats FR : +33 7 98 76 54 32 / 06 12 34 56 78)
  /\+33[\s.]?\d(?:[\s.]?\d{2}){4}\b|\b0\d(?:[\s.]?\d{2}){4}\b/g,
  // API_KEY_SK
  /\bsk-ant-[A-Za-z0-9-]+/g,
  // API_KEY_GITHUB
  /\bghp_[A-Za-z0-9]+/g,
  // CONNECTION_STRING
  /\b\w+:\/\/\S+/g,
  // JWT_TOKEN
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  // PERSON (deux mots ou plus à initiale majuscule, tirets autorisés dans un mot)
  /\b[A-ZÀ-Ý][a-zà-ÿ]+(?:-[A-ZÀ-Ý][a-zà-ÿ]+)?(?:\s[A-ZÀ-Ý][a-zà-ÿ]+(?:-[A-ZÀ-Ý][a-zà-ÿ]+)?)+\b/g,
  // LOCATION (code postal FR + ville)
  /\b\d{5}\s[A-ZÀ-Ý][a-zà-ÿ]+\b/g,
];

/** Lignes `Label : valeur` (clients.txt) : capture tout ce qui suit le premier `:`. */
const LABEL_COLON_LINE = /^[^:#=]{1,40}:\s*(.+)$/;
/** Lignes `CLE=valeur` (env.fake) : capture tout ce qui suit le premier `=`. */
const ENV_KEY_VALUE_LINE = /^[A-Z][A-Z0-9_]*=(.+)$/;

function extractFromText(text: string): string[] {
  const values: string[] = [];
  for (const pattern of GLOBAL_PATTERNS) {
    for (const match of text.matchAll(pattern)) values.push(match[0]);
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const labelMatch = line.match(LABEL_COLON_LINE);
    if (labelMatch?.[1]) values.push(labelMatch[1].trim());
    const envMatch = line.match(ENV_KEY_VALUE_LINE);
    if (envMatch?.[1]) values.push(envMatch[1].trim());
  }
  return values;
}

async function main(): Promise<void> {
  const allValues: string[] = [];
  for (const relPath of FIXTURES) {
    const absPath = join(TEST_PROJECT_DIR, relPath);
    const text = await readFile(absPath, "utf8");
    allValues.push(...extractFromText(text));
  }

  const deduped = [...new Set(allValues.map((v) => v.trim()))]
    .filter((v) => v.length >= MIN_LENGTH)
    .sort((a, b) => a.localeCompare(b));

  const header =
    `# Généré par build-valeurs-sensibles.ts depuis ${FIXTURES.join(", ")} — ne pas éditer à la main.\n` +
    `# Une valeur par ligne, doublons retirés, lignes de moins de ${MIN_LENGTH} caractères ignorées.\n`;
  await writeFile(OUTPUT_FILE, `${header}${deduped.join("\n")}\n`, "utf8");

  console.log(`${deduped.length} valeurs sensibles écrites dans ${OUTPUT_FILE}`);
  for (const v of deduped) console.log(`  - ${v}`);
}

await main();
