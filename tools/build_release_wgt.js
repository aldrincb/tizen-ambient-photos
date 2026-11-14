#!/usr/bin/env node
"use strict";

/**
 * Builds a generic, anonymous Tizen-signed AmbientPhotos.wgt in dist/AmbientPhotos.wgt
 * containing ZERO personal certificates, emails, or device DUIDs.
 * - Installs directly on Tizen <= 6.5 TVs
 * - Compatible with TizenBrew Installer auto-resigning for Tizen 7/8/9+ TVs
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const forge = require("./node_modules/node-forge");
const JSZip = require("./node_modules/jszip");
const { Signature, TizenCertificateCreator } = require("./node_modules/tizen");

const ROOT_DIR = path.resolve(__dirname, "..");
const APP_DIR = path.join(ROOT_DIR, "app");
const DIST_DIR = path.join(ROOT_DIR, "dist");

async function main() {
  const creator = new TizenCertificateCreator();
  const genericPassword = "ambientphotos-public-build";
  const authorDer = await creator.createCertificate({
    name: "AmbientPhotos",
    password: genericPassword,
  });

  const distP12Path = path.join(
    os.homedir(),
    "share",
    ".tizen-cert",
    "distributor",
    "sdk-partner",
    "tizen-distributor-signer.p12"
  );
  const distDer = fs.readFileSync(distP12Path, "binary");

  const authorP12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(authorDer), false, genericPassword);
  const distributorP12 = forge.pkcs12.pkcs12FromAsn1(
    forge.asn1.fromDer(distDer),
    false,
    "tizenpkcs12passfordsigner"
  );

  const files = [];
  for (const name of fs.readdirSync(APP_DIR).sort()) {
    if (name.startsWith(".")) continue;
    const full = path.join(APP_DIR, name);
    if (fs.statSync(full).isFile()) {
      files.push({
        uri: encodeURIComponent(name),
        data: fs.readFileSync(full),
      });
    }
  }

  const authorSig = new Signature("AuthorSignature", files);
  const afterAuthor = await authorSig.sign(authorP12);
  const distSig = new Signature("DistributorSignature", afterAuthor);
  const signedFiles = await distSig.sign(distributorP12);

  const outZip = new JSZip();
  for (const f of signedFiles) {
    outZip.file(decodeURIComponent(f.uri), f.data);
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const outFile = path.join(DIST_DIR, "AmbientPhotos.wgt");
  const buf = await outZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(outFile, buf);
  console.log(`Built clean generic release package: ${outFile} (${buf.length} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
