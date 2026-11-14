"use strict";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var http = require("http");
var https = require("https");
var urlMod = require("url");

var PORT = 8192;
var UA = "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var started = false;

function toBuf(str) {
  return typeof Buffer.from === "function" ? Buffer.from(str, "utf8") : new Buffer(str, "utf8");
}

function httpsRequestFollow(targetUrl, method, bodyBuf, extraHeaders, redirectsLeft, cb) {
  if (redirectsLeft <= 0) {
    return cb(new Error("Too many redirects"));
  }
  var parsed = urlMod.parse(targetUrl);
  var mod = parsed.protocol === "http:" ? http : https;
  var headers = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"
  };
  if (extraHeaders) {
    for (var k in extraHeaders) {
      if (Object.prototype.hasOwnProperty.call(extraHeaders, k)) {
        headers[k] = extraHeaders[k];
      }
    }
  }
  if (bodyBuf) {
    headers["Content-Length"] = bodyBuf.length;
  }

  var opts = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
    path: parsed.path,
    method: method || "GET",
    headers: headers,
    rejectUnauthorized: false
  };

  var req = mod.request(opts, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      var nextUrl = urlMod.resolve(targetUrl, res.headers.location);
      return httpsRequestFollow(nextUrl, "GET", null, null, redirectsLeft - 1, cb);
    }
    var chunks = [];
    res.on("data", function (c) { chunks.push(c); });
    res.on("end", function () {
      var full = Buffer.concat(chunks);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cb(null, { finalUrl: targetUrl, body: full });
      } else {
        cb(new Error("Upstream HTTP " + res.statusCode));
      }
    });
  });

  req.on("error", function (err) { cb(err); });
  req.setTimeout(25000, function () {
    req.abort();
    cb(new Error("Upstream timeout"));
  });

  if (bodyBuf) req.write(bodyBuf);
  req.end();
}

function sendCorsHeaders(res, status, contentType, byteLen) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": String(byteLen),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
}

function startServer() {
  if (started) return;
  started = true;

  var server = http.createServer(function (req, res) {
    if (req.method === "OPTIONS") {
      sendCorsHeaders(res, 204, "text/plain", 0);
      return res.end();
    }

    var parsed = urlMod.parse(req.url, true);

    if (parsed.pathname === "/ping") {
      var okBuf = toBuf("ok");
      sendCorsHeaders(res, 200, "text/plain", okBuf.length);
      return res.end(okBuf);
    }

    if (req.method === "GET" && parsed.pathname === "/api/page1") {
      var shareUrl = (parsed.query && parsed.query.url) || "";
      httpsRequestFollow(shareUrl, "GET", null, null, 8, function (err, result) {
        if (err) {
          var errBuf = toBuf(JSON.stringify({ error: err.message }));
          sendCorsHeaders(res, 502, "application/json; charset=utf-8", errBuf.length);
          return res.end(errBuf);
        }
        var outBuf = toBuf(JSON.stringify({ finalUrl: result.finalUrl, html: result.body.toString("utf8") }));
        sendCorsHeaders(res, 200, "application/json; charset=utf-8", outBuf.length);
        res.end(outBuf);
      });
      return;
    }

    if (req.method === "POST" && parsed.pathname === "/api/batchexecute") {
      var bodyChunks = [];
      req.on("data", function (c) { bodyChunks.push(c); });
      req.on("end", function () {
        var reqBody = Buffer.concat(bodyChunks);
        httpsRequestFollow(
          "https://photos.google.com/_/PhotosUi/data/batchexecute?rpcids=snAcKc",
          "POST",
          reqBody,
          { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          5,
          function (err, result) {
            if (err) {
              var errBuf = toBuf(err.message);
              sendCorsHeaders(res, 502, "text/plain; charset=utf-8", errBuf.length);
              return res.end(errBuf);
            }
            sendCorsHeaders(res, 200, "text/plain; charset=utf-8", result.body.length);
            res.end(result.body);
          }
        );
      });
      return;
    }

    var nf = toBuf("Not Found");
    sendCorsHeaders(res, 404, "text/plain", nf.length);
    res.end(nf);
  });

  server.on("error", function () {});
  server.listen(PORT, "127.0.0.1");
}

module.exports.onStart = function () {
  startServer();
};

module.exports.onRequest = function () {
  startServer();
};

module.exports.onExit = function () {};
