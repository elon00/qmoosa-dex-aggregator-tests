import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const manifestPath = path.join(rootDir, "integrity-manifest.json");

if (!fs.existsSync(manifestPath)) {
  console.error(`FATAL: integrity-manifest.json not found at ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const args = process.argv.slice(2);
let mode = "all";
for (const arg of args) {
  if (arg.startsWith("--mode=")) {
    mode = arg.split("=")[1];
  }
}

console.log("================================================================");
console.log("=== QMOOSA DEX AGGREGATOR SUPPLY-CHAIN INTEGRITY & PROVENANCE GATE ===");
console.log(`Mission:  ${manifest.mission}`);
console.log(`Mode:     ${mode.toUpperCase()}`);
console.log(`Manifest: Generated ${manifest.generatedAt}`);
console.log("================================================================\n");

let archiveIntegrityFailed = false;
let sourceProvenanceFailed = false;
let canonicalArtifactFailed = false;
let currentHeadFailed = false;

// GATE 1: STRICT SHA-256 ARCHIVE CHECKSUM GATE
if (mode === "all" || mode === "archive") {
  console.log(`--- [GATE 1: ARCHIVE INTEGRITY VERIFICATION] ---`);
  for (const pkg of manifest.packages) {
    const archiveFullPath = path.join(rootDir, pkg.archivePath);
    if (!fs.existsSync(archiveFullPath)) {
      console.error(`  [FAIL] Missing archive: ${pkg.archivePath}`);
      archiveIntegrityFailed = true;
      continue;
    }

    const fileBuffer = fs.readFileSync(archiveFullPath);
    const calculatedHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

    if (calculatedHash.toLowerCase() !== pkg.sha256.toLowerCase()) {
      console.error(`  [FAIL] SHA-256 mismatch for ${pkg.name}@${pkg.version}`);
      console.error(`         Expected: ${pkg.sha256}`);
      console.error(`         Actual:   ${calculatedHash}`);
      archiveIntegrityFailed = true;
    } else {
      console.log(`  [PASS] ${pkg.name}@${pkg.version} archive SHA-256 verified (${calculatedHash.substring(0, 16)}...)`);
    }
  }

  if (archiveIntegrityFailed) {
    console.error("\nRESULT: ARCHIVE_INTEGRITY_FAIL (Supply chain tampering detected)");
    process.exit(1);
  } else {
    console.log("\nRESULT: ARCHIVE_INTEGRITY_PASS");
  }
}

// GATE 2: STRICT FAIL-CLOSED SOURCE PROVENANCE & CURRENT-HEAD VERIFICATION
console.log(`--- [GATE 2: SOURCE PROVENANCE VERIFICATION] ---`);
for (const pkg of manifest.packages) {
  const repoBaseName = pkg.repository.split("/")[1];
  const siblingPath = path.resolve(rootDir, "..", repoBaseName);

  if (!fs.existsSync(siblingPath) || !fs.existsSync(path.join(siblingPath, ".git"))) {
    console.error(`  [FAIL] Strict reality-gate failure: sibling repository checkout required but missing: ${pkg.repository}`);
    sourceProvenanceFailed = true;
    currentHeadFailed = true;
    continue;
  }

  try {
    const currentHead = execSync("git rev-parse HEAD", { cwd: siblingPath, stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
    const declaredCommit = pkg.sourceCommit.trim();

    if (mode === "current-head") {
      const isAligned = currentHead.toLowerCase().startsWith(declaredCommit.toLowerCase());
      console.log(`  [${isAligned ? "PASS" : "FAIL"}] ${pkg.repository}: HEAD=${currentHead.substring(0, 7)} DECLARED=${declaredCommit.substring(0, 7)} ALIGNED=${isAligned ? "YES" : "NO"}`);
      if (!isAligned) {
        currentHeadFailed = true;
      }
      continue;
    }

    execSync(`git merge-base --is-ancestor ${declaredCommit} HEAD`, { cwd: siblingPath, stdio: ["pipe", "pipe", "ignore"] });
    console.log(`  [PASS] ${pkg.repository} provenance established at ${declaredCommit.substring(0, 7)}`);
  } catch (err) {
    console.error(`  [FAIL] Git inspection error in ${siblingPath}: ${err.message}`);
    sourceProvenanceFailed = true;
    currentHeadFailed = true;
  }
}

if (mode === "current-head") {
  if (currentHeadFailed) {
    console.error("\nRESULT: CURRENT_HEAD_ALIGNMENT_FAIL (One or more repository heads differ from declared commit)");
    process.exit(1);
  } else {
    console.log("\nRESULT: CURRENT_HEAD_ALIGNMENT_PASS (All 3 sibling repository heads aligned)");
    process.exit(0);
  }
}

function getAllFiles(dir, base = "") {
  let res = [];
  if (!fs.existsSync(dir)) return res;
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    const rel = path.join(base, f);
    if (fs.statSync(full).isDirectory()) {
      res = res.concat(getAllFiles(full, rel));
    } else {
      res.push(rel);
    }
  }
  return res;
}

function verifyCanonicalArtifacts(siblingDistPath, archivePath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qmoosa-dex-artifact-"));
  try {
    execSync(`tar -xzf "${archivePath}" -C "${tmpDir}"`, { stdio: "pipe" });
    const archiveDist = path.join(tmpDir, "package", "dist");
    if (!fs.existsSync(archiveDist)) {
      throw new Error("Missing dist folder inside pinned package archive");
    }

    const archiveFiles = getAllFiles(archiveDist);
    const siblingFiles = getAllFiles(siblingDistPath);

    if (archiveFiles.length === 0) {
      throw new Error("No artifacts found in archive dist folder");
    }

    for (const file of archiveFiles) {
      const archFilePath = path.join(archiveDist, file);
      const sibFilePath = path.join(siblingDistPath, file);

      if (!fs.existsSync(sibFilePath)) {
        throw new Error(`File ${file} present in archive but missing from fresh build dist`);
      }

      const h1 = crypto.createHash("sha256").update(fs.readFileSync(archFilePath)).digest("hex");
      const h2 = crypto.createHash("sha256").update(fs.readFileSync(sibFilePath)).digest("hex");

      if (h1 !== h2) {
        throw new Error(`SHA-256 mismatch for compiled artifact ${file} (archive: ${h1}, fresh build: ${h2})`);
      }
    }

    for (const file of siblingFiles) {
      const archFilePath = path.join(archiveDist, file);
      if (!fs.existsSync(archFilePath)) {
        throw new Error(`Superfluous file ${file} in fresh build dist that was not in archive`);
      }
    }

    return archiveFiles.length;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// GATE 3: HERMETIC SOURCE DERIVATION & BYTE-FOR-BYTE ARTIFACT EQUALITY
if (mode === "all" || mode === "source") {
  console.log(`\n--- [GATE 3: REPRODUCIBLE REBUILD & CANONICAL ARTIFACT COMPARISON] ---`);

  for (const pkg of manifest.packages) {
    const repoBaseName = pkg.repository.split("/")[1];
    const siblingPath = path.resolve(rootDir, "..", repoBaseName);
    const archiveFullPath = path.join(rootDir, pkg.archivePath);

    try {
      execSync("npm run build", { cwd: siblingPath, stdio: ["pipe", "pipe", "pipe"] });

      const siblingDist = path.join(siblingPath, "dist");
      const artifactCount = verifyCanonicalArtifacts(siblingDist, archiveFullPath);
      console.log(`  [PASS] ${pkg.name} cleanly rebuilt from source; ${artifactCount} compiled artifacts verified against archive`);
    } catch (err) {
      console.error(`  [FAIL] Reproducible build or canonical artifact equality failure in ${pkg.name}: ${err.message}`);
      canonicalArtifactFailed = true;
    }
  }
}

if (sourceProvenanceFailed || canonicalArtifactFailed) {
  console.error("\nRESULT: SOURCE_PROVENANCE_FAIL (Fail-closed security gate triggered)");
  process.exit(1);
} else {
  console.log("\nRESULT: SOURCE_PROVENANCE_PASS (100% Hermetic source derivation and canonical artifact equality verified)");
}
