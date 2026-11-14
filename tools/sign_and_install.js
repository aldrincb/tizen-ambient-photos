#!/usr/bin/env node
"use strict";

// Required by Samsung's svdca.samsungqbe.com certificate endpoint
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.removeAllListeners("warning");

const http = require("http");
const fs = require("fs");
const path = require("path");
const querystring = require("querystring");
const JSZip = require("./node_modules/jszip");
const adbhost = require("./node_modules/adbhost");
const { createSamsungCertificate, resignPackage } = require("./SamsungCertificateCreation.js");
const { parsePackage, installPackage } = require("./PackageInstallation.js");
const PushFile = require("./FilePusher.js");
const AccessInfoHTMLPage = require("./HTMLPage.js");

const TV_IP = process.argv[2] || process.env.TV_IP || "";
const OAUTH_PORT = 4794;
const ROOT_DIR = path.resolve(__dirname, "..");
const APP_DIR = path.join(ROOT_DIR, "app");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const CERT_FILE = path.join(__dirname, "samsung_cert.json");
const LOCAL_DEFAULTS_FILE = path.join(__dirname, "local_defaults.json");

if (!TV_IP) {
  console.error("Usage: node tools/sign_and_install.js <SAMSUNG_TV_IP>");
  console.error("Example: node tools/sign_and_install.js 192.168.1.50");
  process.exit(1);
}

async function buildUnsignedWgtBuffer() {
  let localAlbumUrl = "";
  if (fs.existsSync(LOCAL_DEFAULTS_FILE)) {
    try {
      localAlbumUrl = JSON.parse(fs.readFileSync(LOCAL_DEFAULTS_FILE, "utf8")).albumUrl || "";
    } catch (e) {}
  }
  const zip = new JSZip();
  for (const name of fs.readdirSync(APP_DIR)) {
    if (name.startsWith(".")) continue;
    const full = path.join(APP_DIR, name);
    if (fs.statSync(full).isFile()) {
      let content = fs.readFileSync(full);
      if (name === "app.js" && localAlbumUrl) {
        content = Buffer.from(
          content
            .toString("utf8")
            .replace('var DEFAULT_ALBUM_URL = "";', `var DEFAULT_ALBUM_URL = ${JSON.stringify(localAlbumUrl)};`),
          "utf8"
        );
      }
      zip.file(name, content);
    }
  }
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function connectTv(ip) {
  return new Promise((resolve, reject) => {
    const client = adbhost.createConnection({ host: ip, port: 26101 });
    let connected = false;
    client._stream.on("connect", () => {
      connected = true;
      setTimeout(() => resolve(client), 900);
    });
    client._stream.on("error", (err) => {
      if (!connected) reject(err);
    });
  });
}

function pushBuffer(adbClient, remotePath, buffer, settleMs = 1800) {
  return new Promise((resolve) => {
    PushFile(adbClient, remotePath, buffer, () => {
      setTimeout(resolve, settleMs);
    });
  });
}

function launchAppOnTv(adbClient, appId) {
  return new Promise((resolve) => {
    try {
      const k = adbClient.createStream(`shell:0 was_kill ${appId}`);
      k.on("data", () => {});
      setTimeout(() => {
        const s = adbClient.createStream(`shell:0 was_execute ${appId}`);
        let out = "";
        s.on("data", (d) => (out += d.toString()));
        setTimeout(() => resolve(out.trim()), 1500);
      }, 800);
    } catch (e) {
      resolve("");
    }
  });
}

async function signAndDeployWithCert(certConfig) {
  console.log("[1/5] Building unsigned AmbientPhotos.wgt from app/...");
  const unsignedBuf = await buildUnsignedWgtBuffer();

  console.log("[2/5] Signing AmbientPhotos.wgt with Samsung Author & Distributor certificates...");
  const certificates = {
    authorCert: Buffer.from(certConfig.authorCert, "base64").toString("binary"),
    distributorCert: Buffer.from(certConfig.distributorCert, "base64").toString("binary"),
    password: certConfig.password,
  };
  const signedBuf = await resignPackage(certificates, unsignedBuf);
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const outWgt = path.join(DIST_DIR, "AmbientPhotos-local-signed.wgt");
  fs.writeFileSync(outWgt, signedBuf);
  console.log(`      Saved device-signed package: ${outWgt} (${signedBuf.length} bytes)`);

  console.log(`[3/5] Connecting to Samsung TV at ${TV_IP}:26101...`);
  const adbClient = await connectTv(TV_IP);

  if (certConfig.distributorXML) {
    console.log("      Pushing device-profile.xml to TV...");
    await pushBuffer(
      adbClient,
      "/home/owner/share/tmp/sdk_tools/device-profile.xml",
      Buffer.from(certConfig.distributorXML, "utf8"),
      1200
    );
  }

  console.log("[4/5] Pushing signed AmbientPhotos.wgt to TV...");
  await pushBuffer(adbClient, "/home/owner/share/tmp/sdk_tools/package.wgt", signedBuf, 2200);

  const pkg = await parsePackage(signedBuf);
  console.log(`[5/5] Installing package '${pkg.packageId}' via vd_appinstall...`);
  const installResult = await installPackage("/home/owner/share/tmp/sdk_tools/package.wgt", pkg.packageId, adbClient);
  console.log("=== vd_appinstall output ===");
  console.log(installResult);

  const launchOut = await launchAppOnTv(adbClient, "AmbPhotos0.AmbientPhotos");
  if (launchOut) console.log("=== Launch output ===\n" + launchOut);

  return installResult;
}

async function main() {
  if (fs.existsSync(CERT_FILE)) {
    console.log("Found existing Samsung certificate in tools/samsung_cert.json — deploying directly!");
    const certConfig = JSON.parse(fs.readFileSync(CERT_FILE, "utf8"));
    await signAndDeployWithCert(certConfig);
    process.exit(0);
  }

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://localhost:${OAUTH_PORT}`);
    if (req.method === "GET" && !reqUrl.searchParams.get("code")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(AccessInfoHTMLPage);
      return;
    }

    let rawBody = "";
    if (req.method === "GET") {
      rawBody = "code=" + encodeURIComponent(reqUrl.searchParams.get("code"));
    } else {
      await new Promise((resolve) => {
        req.on("data", (chunk) => (rawBody += chunk.toString()));
        req.on("end", resolve);
      });
    }

    (async () => {
      try {
        const parsed = querystring.parse(rawBody);
        const codeJson = JSON.parse(parsed.code);
        const accessInfo = {
          accessToken: codeJson.access_token,
          userId: codeJson.userId,
        };
        const password =
          Math.random().toString(36).slice(-10) +
          Math.random().toString(36).slice(-10) +
          Math.random().toString(36).slice(-4);
        const authorInfo = {
          name: "AmbientPhotos",
          email: codeJson.inputEmailID || "dev@example.com",
          password,
          privilegeLevel: "Partner",
        };

        console.log("Received Samsung OAuth token! Connecting to TV to read DUID & mint certificate...");
        const tvForCert = await connectTv(TV_IP);
        const cert = await createSamsungCertificate(authorInfo, accessInfo, tvForCert, false);
        try {
          tvForCert._stream.end();
          tvForCert._stream.destroy();
        } catch (e) {}

        const certConfig = {
          authorCert: Buffer.from(cert.authorCert, "binary").toString("base64"),
          distributorCert: Buffer.from(cert.distributorCert, "binary").toString("base64"),
          distributorXML: cert.distributorXML,
          password,
        };
        fs.writeFileSync(CERT_FILE, JSON.stringify(certConfig, null, 2));
        console.log("Saved Samsung certificate to tools/samsung_cert.json!");

        const installOut = await signAndDeployWithCert(certConfig);
        const ok = String(installOut).includes("spend time") && !String(installOut).includes("install failed");

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><body style="background:#111318;color:#fff;font-family:system-ui,sans-serif;padding:40px;max-width:680px;margin:auto;">
          <h1 style="color:${ok ? "#7ee787" : "#ffa657"};">${ok ? "✅ Ambient Photos Installed on Your 55&quot; The Serif!" : "⚠️ Install Finished — Check Log"}</h1>
          <p>Certificate created and saved locally for future one-click updates. You can close this tab now.</p>
          <pre style="background:#1c1f26;padding:16px;border-radius:10px;overflow:auto;">${installOut}</pre>
        </body></html>`);

        if (ok) {
          setTimeout(() => {
            server.close();
            process.exit(0);
          }, 1500);
        }
      } catch (err) {
        console.error("OAuth/Install error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
  });

  server.listen(OAUTH_PORT, "127.0.0.1", () => {
    console.log(`READY_FOR_SAMSUNG_LOGIN on http://localhost:${OAUTH_PORT}/signin/callback`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
