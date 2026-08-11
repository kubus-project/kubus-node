#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
let manifestPath = path.join(rootDir, 'version.json');

// Parse CLI args for --manifest
const manifestArg = process.argv.find(arg => arg.startsWith('--manifest'));
if (manifestArg) {
  if (manifestArg === '--manifest' && process.argv.includes('--manifest')) {
    const idx = process.argv.indexOf('--manifest');
    if (idx + 1 < process.argv.length) {
      manifestPath = path.resolve(process.argv[idx + 1]);
    }
  } else if (manifestArg.startsWith('--manifest=')) {
    manifestPath = path.resolve(manifestArg.slice(11));
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function normalizeBuildNumber(rawBuildNumber) {
  if (Number.isInteger(rawBuildNumber) && rawBuildNumber >= 0) {
    return rawBuildNumber;
  }

  const text = String(rawBuildNumber ?? '').trim();
  if (/^\d+$/.test(text)) {
    const parsed = Number.parseInt(text, 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  if (/^\d+(\.\d+)+$/.test(text)) {
    const flattened = text.replace(/\./g, '');
    const parsed = Number.parseInt(flattened, 10);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  throw new Error(
    'buildNumber must be a non-negative integer (e.g. 42) or numeric string (e.g. "42" or "20260512.02")'
  );
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('version.json must be a JSON object');
  }
  const { version, buildNumber, buildDate } = manifest;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/.test(String(version || ''))) {
    throw new Error('version must be a valid SemVer version, including optional prerelease/build metadata');
  }
  normalizeBuildNumber(buildNumber);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(buildDate || ''))) {
    throw new Error('buildDate must use YYYY-MM-DD format');
  }
}

function run() {
  const manifest = readJson(manifestPath);
  validateManifest(manifest);
  const numericBuildNumber = normalizeBuildNumber(manifest.buildNumber);

  // Update package.json
  const packageJsonPath = path.join(rootDir, 'package.json');
  const packageData = readJson(packageJsonPath);
  packageData.version = manifest.version;
  writeJson(packageJsonPath, packageData);

  // Update package-lock.json if it exists
  const packageLockPath = path.join(rootDir, 'package-lock.json');
  if (fs.existsSync(packageLockPath)) {
    const packageLock = readJson(packageLockPath);
    packageLock.version = manifest.version;
    if (packageLock.packages && packageLock.packages['']) {
      packageLock.packages[''].version = manifest.version;
    }
    writeJson(packageLockPath, packageLock);
  }

  // Create version.json
  const versionJsonPath = path.join(rootDir, 'version.json');
  const versionData = {
    version: manifest.version,
    buildNumber: manifest.buildNumber,
    buildDate: manifest.buildDate,
    channel: manifest.channel || 'beta',
  };
  writeJson(versionJsonPath, versionData);

  // Create src/version.ts if src exists
  const srcDir = path.join(rootDir, 'src');
  if (fs.existsSync(srcDir)) {
    const versionTsPath = path.join(srcDir, 'version.ts');
    const versionTs = `export const KUBUS_VERSION = '${manifest.version}'
export const KUBUS_BUILD_NUMBER = '${manifest.buildNumber}'
export const KUBUS_BUILD_NUMBER_NUMERIC = ${numericBuildNumber}
export const KUBUS_BUILD_DATE = '${manifest.buildDate}'
export const KUBUS_CHANNEL = '${manifest.channel || 'beta'}'
`;
    fs.writeFileSync(versionTsPath, versionTs, 'utf8');
  }

  const dockerfilePath = path.join(rootDir, 'Dockerfile');
  if (fs.existsSync(dockerfilePath)) {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8').replace(
      /LABEL org\.opencontainers\.image\.version="[^"]+"/,
      `LABEL org.opencontainers.image.version="${manifest.version}"`,
    );
    fs.writeFileSync(dockerfilePath, dockerfile, 'utf8');
  }

  process.stdout.write(
    `Synced kubus-node to version ${manifest.version} (buildNumber: ${manifest.buildNumber}, buildDate: ${manifest.buildDate})\n`
  );
}

run();
