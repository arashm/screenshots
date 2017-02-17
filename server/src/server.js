const config = require("./config").getProperties();

require("mozlog").config({
  app: "pageshot-server",
  fmt: "pretty",
  level: config.log.level,
  debug: config.log.lint
});

const console_mozlog = require("mozlog")("console");
// We can't prevent any third party libraries from writing to the console,
// so monkey patch it so they play nice with mozlog.
function logFactory(level) {
  let logger = console_mozlog[level].bind(console_mozlog);
  return function () {
    let msg = "";
    let stack = undefined;
    for (var i = 0; i < arguments.length; i++) {
      let arg = arguments[i];
      if (msg) {
        msg += " ";
      }
      if (typeof arg === "string") {
        msg += arg;
      } else {
        if (arg && arg.stack) {
          if (stack) {
            stack = stack + "\n\n" + arg.stack;
          } else {
            stack = arg.stack;
          }
        }
        msg += JSON.stringify(arg);
      }
    }
    logger(level, {msg, stack});
  }
}

console.debug = logFactory("debug");
console.info = logFactory("info");
console.warn = logFactory("warn");
console.error = logFactory("error");

const path = require('path');
const { readFileSync, existsSync } = require('fs');
const Cookies = require("cookies");

const { Shot } = require("./servershot");
const {
  checkLogin,
  registerLogin,
  updateLogin,
  setState,
  checkState,
  tradeCode,
  getAccountId,
  registerAccount,
} = require("./users");
const dbschema = require("./dbschema");
const express = require("express");
const bodyParser = require('body-parser');
const morgan = require("morgan");
const linker = require("./linker");
const { randomBytes } = require("./helpers");
const errors = require("../shared/errors");
const { checkContent, checkAttributes } = require("./contentcheck");
const buildTime = require("./build-time").string;
const ua = require("universal-analytics");
const urlParse = require("url").parse;
const http = require("http");
const https = require("https");
const gaActivation = require("./ga-activation");
const genUuid = require("nodify-uuid");
const AWS = require("aws-sdk");
const escapeHtml = require("escape-html");
const validUrl = require("valid-url");
const statsd = require("./statsd");
const { notFound } = require("./pages/not-found/server");
const { cacheTime, setCache } = require("./caching");
const { captureRavenException, sendRavenMessage,
        addRavenRequestHandler, addRavenErrorHandler } = require("./ravenclient");
const { errorResponse, simpleResponse, jsResponse } = require("./responses");
const selfPackage = require("./package.json");
const { b64EncodeJson, b64DecodeJson } = require("./b64");

const PROXY_HEADER_WHITELIST = {
  "content-type": true,
  "content-encoding": true,
  "content-length": true,
  "last-modified": true,
  "etag": true,
  "date": true,
  "accept-ranges": true,
  "content-range": true,
  "retry-after": true,
  "via": true
};

if (config.useS3) {
  // Test a PUT to s3 because configuring this requires using the aws web interface
  // If the permissions are not set up correctly, then we want to know that asap
  var s3bucket = new AWS.S3({params: {Bucket: config.s3BucketName}});
  console.info(new Date(), `creating ${config.s3BucketName}`);

  // createBucket is a horribly named api; it creates a local object to access
  // an existing bucket
  s3bucket.createBucket(function() {
    var params = {Key: 'test', Body: 'Hello!'};
    s3bucket.upload(params, function(err, data) {
      if (err) {
        console.warn("Error uploading data during test: ", err);
      } else {
        console.info(`Successfully uploaded data to ${config.s3BucketName}/test`);
      }
    });
  });
}

function initDatabase() {
  let forceDbVersion = config.db.forceDbVersion;
  if (forceDbVersion) {
    let hadError = false;
    dbschema.forceDbVersion(forceDbVersion).then(() => {
    },
    (e) => {
      hadError = true;
      console.error("Error forcing database version:", forceDbVersion, e);
    }).then(() => {
      console.info("Exiting after downgrade");
      process.exit(hadError ? 2 : 0);
    });
    return Promise.resolve();
  }
  let promise;
  if (config.disableControllerTasks) {
    console.info("Note: this server will not perform database initialization");
    promise = dbschema.createKeygrip();
  } else {
    promise = dbschema.createTables().then(() => {
      return dbschema.createKeygrip();
    }).then(() => {
      return Shot.upgradeSearch();
    });
  }
  promise.catch((e) => {
    console.error("Error initializing database:", e, e.stack);
    captureRavenException(e);
    // Give Raven/etc a chance to work before exit:
    setTimeout(() => {
      process.exit(1);
    }, 500);
  });
}

initDatabase();

const app = express();

app.set('trust proxy', true);

// Disable x-powered-by header
app.disable("x-powered-by");

const CONTENT_NAME = config.contentOrigin;

function addHSTS(req, res) {
  // Note: HSTS will only produce warning on a localhost self-signed cert
  if (req.protocol === "https" && ! config.localhostSsl) {
    let time = 24*60*60*1000; // 24 hours
    res.header(
      "Strict-Transport-Security",
      `max-age=${time}`);
  }
}

addRavenRequestHandler(app);

app.use((req, res, next) => {
  genUuid.generate(genUuid.V_RANDOM, function (err, uuid) {
    if (!err) {
      let dsn = config.sentryPublicDSN;
      if (dsn) {
        dsn = dsn.replace(/^https?:\/\/[^@]*@/, "").replace(/\/.*/, "");
      } else {
        dsn = "";
      }
      req.cspNonce = uuid;
      res.header(
        "Content-Security-Policy",
        `default-src 'self'; img-src 'self' www.google-analytics.com ${CONTENT_NAME} data:; script-src 'self' www.google-analytics.com 'nonce-${uuid}'; style-src 'self' 'unsafe-inline' https://code.cdn.mozilla.net; connect-src 'self' www.google-analytics.com ${dsn}; font-src https://code.cdn.mozilla.net;`);
      res.header("X-Frame-Options", "DENY");
      addHSTS(req, res);
      next();
    } else {
      errorResponse(res, "Error creating nonce:", err);
    }
  });
});

function isApiUrl(url) {
  return url.startsWith("/api") || url === "/event";
}

app.use((req, res, next) => {
  if (isApiUrl(req.url)) {
    // All API requests are CORS-enabled
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "POST, GET, PUT, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Cookie, Content-Type, User-Agent");
    if (req.method === "OPTIONS") {
      res.type("text");
      res.send("");
      return;
    }
  }
  next();
});

app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json({limit: '100mb'}));

app.use("/static", express.static(path.join(__dirname, "static"), {
  index: false,
  maxAge: cacheTime ? cacheTime * 1000 : null
}));

let xpidir = path.join(__dirname, "..", "xpi");
app.use("/xpi", express.static(xpidir, {index: false}));

app.use("/homepage", express.static(path.join(__dirname, "static/homepage"), {
  index: false
}));

app.use(morgan("combined"));

app.use(function (req, res, next) {
  let authHeader = req.headers['x-pageshot-auth'];
  let authInfo = {};
  if (authHeader) {
    authInfo = decodeAuthHeader(authHeader);
  } else {
    let cookies = new Cookies(req, res, {keys: dbschema.getKeygrip()});
    authInfo.deviceId = cookies.get("user", {signed: true});
    let abTests = cookies.get("abtests", {signed: true});
    if (abTests) {
      abTests = b64DecodeJson(abTests);
      authInfo.abTests = abTests;
    }
  }
  if (authInfo.deviceId) {
    req.deviceId = authInfo.deviceId;
    req.userAnalytics = ua(config.gaId, req.deviceId, {strictCidFormat: false});
    if (config.debugGoogleAnalytics) {
      req.userAnalytics = req.userAnalytics.debug();
    }
  }
  req.abTests = authInfo.abTests || {};
  req.backend = `${req.protocol}://${req.headers.host}`;
  req.config = config;
  next();
});

function decodeAuthHeader(header) {
  /** Decode a string header in the format {deviceId}:{deviceIdSig};abtests={b64thing}:{sig} */
  // Since it's treated as opaque, we'll use a fragile regex
  let keygrip = dbschema.getKeygrip();
  let match = /^([^:]+):([^;]+);abTests=([^:]+):(.*)$/.exec(header);
  if (! match) {
    // FIXME: log, Sentry error
    return {};
  }
  let deviceId = match[1];
  let deviceIdSig = match[2];
  let abTestsEncoded = match[3];
  let abTestsEncodedSig = match[4];
  if (! (keygrip.verify(deviceId, deviceIdSig) && keygrip.verify(abTestsEncoded, abTestsEncodedSig))) {
    // FIXME: log, Sentry error
    return {};
  }
  let abTests = b64DecodeJson(abTestsEncoded);
  return {deviceId, abTests};
}

app.use(function (req, res, next) {
  // FIXME: remove this as part of removing all export-related functions
  // (was used for the exporter process to act as the user)
  let magicAuth = req.headers['x-magic-auth'];
  if (magicAuth && dbschema.getTextKeys().indexOf(magicAuth) != -1) {
    req.deviceId = req.headers['x-device-id'];
  }
  next();
});

app.use(function (req, res, next) {
  req.staticLink = linker.staticLink;
  req.staticLinkWithHost = linker.staticLinkWithHost.bind(null, req);
  let base = `${req.protocol}://${req.headers.host}`;
  linker.imageLinkWithHost = linker.imageLink.bind(null, base);
  next();
});

app.get("/ga-activation.js", function (req, res) {
  sendGaActivation(req, res, false);
});

app.get("/ga-activation-hashed.js", function (req, res) {
  sendGaActivation(req, res, true);
});

function sendGaActivation(req, res, hashPage) {
  let promise;
  setCache(res, {private: true});
  if (req.deviceId) {
    promise = hashUserId(req.deviceId).then((uuid) => {
      return uuid.toString();
    });
  } else {
    promise = Promise.resolve("");
  }
  promise.then((userUuid) => {
    let script = gaActivation.makeGaActivationString(config.gaId, userUuid, req.abTests, hashPage);
    jsResponse(res, script);
  }).catch((e) => {
    errorResponse(res, "Error creating user UUID:", e);
  });
}

const parentHelperJs = readFileSync(path.join(__dirname, "/static/js/parent-helper.js"), {encoding: "UTF-8"});

app.get("/parent-helper.js", function (req, res) {
  setCache(res);
  let postMessageOrigin = `${req.protocol}://${req.config.contentOrigin}`;
  let script = `${parentHelperJs}\nvar CONTENT_HOSTING_ORIGIN = "${postMessageOrigin}";`
  jsResponse(res, script);
});

const ravenClientJs = readFileSync(require.resolve("raven-js/dist/raven.min"), {encoding: "UTF-8"});

app.get("/install-raven.js", function (req, res) {
  setCache(res);
  if (! req.config.sentryPublicDSN) {
    jsResponse(res, "");
    return;
  }
  let options = {
    environment: process.env.NODE_ENV || "dev",
    release: linker.getGitRevision(),
    serverName: req.backend
  };
  // FIXME: this monkeypatch is because our version of Raven (6.2) doesn't really work
  // with our version of Sentry (8.3.3)
  let script = `
  ${ravenClientJs}

  (function () {
    var old_captureException = Raven.captureException.bind(Raven);
    Raven.captureException = function (ex, options) {
      options = options || {};
      options.message = options.message || ex.message;
      return old_captureException(ex, options);
    };
  })();
  Raven.config("${req.config.sentryPublicDSN}", ${JSON.stringify(options)}).install();
  window.Raven = Raven;`;
  jsResponse(res, script);
});

app.get("/favicon.ico", function (req, res) {
  res.redirect(301, "/static/img/pageshot-icon-32.png");
});

app.post("/error", function (req, res) {
  let bodyObj = req.body;
  if (typeof bodyObj !== "object") {
    throw new Error(`Got unexpected req.body type: ${typeof bodyObj}`);
  }
  let userAnalytics = ua(config.gaId);
  let desc = bodyObj.name;
  let attrs = [];
  for (let attr in bodyObj) {
    if (attr == "name" || attr == "help" || attr == "version") {
      continue;
    }
    let value = "" + bodyObj[attr];
    // FIXME: maybe a crude attempt to ensure some santization of parameters:
    value = value.replace(/\n/g, " / ");
    value = value.replace(/[\t\r]/g, " ");
    value = value.replace(/\s+/g, " ");
    value = value.replace(/[^a-z0-9_\-=+\{\}\(\).,/\?:\[\]\| ]/gi, "?");
    value = value.substr(0, 100);
    attrs.push(`${attr}:  ${value}`);
  }
  if (attrs.length) {
    desc += " - " + attrs.join("; ");
  }
  userAnalytics.exception({
    hitType: "exception",
    userAgentOverride: req.headers['user-agent'],
    applicationName: "firefox",
    applicationVersion: bodyObj.version,
    exceptionDescription: desc
  }).send();
  console.info("Error received:", desc);
  simpleResponse(res, "OK", 200);
});

function hashUserId(deviceId) {
  return new Promise((resolve, reject) => {
    if (! dbschema.getTextKeys()) {
      throw new Error("Server keys not initialized");
    }
    let userKey = dbschema.getTextKeys()[0] + deviceId;
    genUuid.generate(genUuid.V_SHA1, genUuid.nil, userKey, function (err, userUuid) {
      if (err) {
        reject(err);
      } else {
        resolve(userUuid);
      }
    });
  });
}

app.post("/event", function (req, res) {
  let bodyObj = req.body;
  if (typeof bodyObj !== "object") {
    throw new Error(`Got unexpected req.body type: ${typeof bodyObj}`);
  }
  hashUserId(req.deviceId).then((userUuid) => {
    let userAnalytics = ua(config.gaId, userUuid.toString(), {strictCidFormat: false});
    if (config.debugGoogleAnalytics) {
      userAnalytics = userAnalytics.debug();
    }
    let params = Object.assign(
      {},
      bodyObj.options,
      {
        ec: bodyObj.event,
        ea: bodyObj.action,
        el: bodyObj.label,
        ev: bodyObj.eventValue
      }
    );
    if (req.headers["user-agent"]) {
      params.ua = req.headers["user-agent"];
    }
    userAnalytics.event(params).send();
    simpleResponse(res, "OK", 200);
  }).catch((e) => {
    errorResponse(res, "Error creating user UUID:", e);
  });
});

app.post("/timing", function (req, res) {
  let bodyObj = req.body;
  if (typeof bodyObj !== "object") {
    throw new Error(`Got unexpected req.body type: ${typeof bodyObj}`);
  }
  hashUserId(req.deviceId).then((userUuid) => {
    let userAnalytics = ua(config.gaId, userUuid.toString());
    let sender = userAnalytics;
    for (let item of bodyObj.timings) {
      sender = sender.timing({
        userTimingCategory: item.category,
        userTimingVariableName: item.variable,
        userTimingTime: item.time,
        userTimingLabel: item.label
      });
    }
    sender.send();
    simpleResponse(res, "OK", 200);
  }).catch((e) => {
    errorResponse(res, "Error creating user UUID:", e);
  });
});

app.get("/redirect", function (req, res) {
  if (req.query.to) {
    let from = req.query.from;
    if (!from) {
      from = "shot-detail";
    }
    res.header("Content-type", "text/html");
    res.status(200);
    let redirectUrl = req.query.to;
    if (! validUrl.isUri(redirectUrl)) {
      console_mozlog.warn("redirect-bad-url", {msg: "Redirect attempted to invalid URL", url: redirectUrl});
      sendRavenMessage(req, "Redirect attempted to invalid URL", {extra: {redirectUrl}});
      simpleResponse(res, "Bad Request", 400);
      return;
    }
    let redirectUrlJs = JSON.stringify(redirectUrl).replace(/[<>]/g, "");
    let output = `<html>
  <head>
    <title>Redirect</title>
  </head>
  <body>
    <a href="${escapeHtml(redirectUrl)}">If you are not automatically redirected, click here.</a>
    <script nonce="${req.cspNonce}">
window.location = ${redirectUrlJs};
    </script>
  </body>
</html>`;
    res.send(output);
  } else {
    console_mozlog.warn("no-redirect-to", {"msg": "Bad Request, no ?to parameter"});
    sendRavenMessage(req, "Bad request, no ?to parameter");
    simpleResponse(res, "Bad Request", 400);
  }
});

app.post("/api/register", function (req, res) {
  let vars = req.body;
  let canUpdate = vars.deviceId === req.deviceId;
  if (! vars.deviceId) {
    console.error("Bad register request:", JSON.stringify(vars, null, "  "));
    sendRavenMessage(req, "Attempted to register without deviceId");
    simpleResponse(res, "Bad request, no deviceId", 400);
    return;
  }
  return registerLogin(vars.deviceId, {
    secret: vars.secret,
    nickname: vars.nickname || null,
    avatarurl: vars.avatarurl || null
  }, canUpdate).then(function (userAbTests) {
    if (userAbTests) {
      sendAuthInfo(req, res, vars.deviceId, userAbTests);
      // FIXME: send GA signal?
    } else {
      sendRavenMessage(req, "Attempted to register existing user", {
        extra: {
          hasSecret: !!vars.secret,
          hasNickname: !!vars.nickname,
          hasAvatarurl: !!vars.avatarurl
        }
      });
      simpleResponse(res, "User exists", 401);
    }
  }).catch(function (err) {
    errorResponse(res, "Error registering:", err);
  });
});

app.post("/api/update", function (req, res, next) {
  if (! req.deviceId) {
    next(errors.missingSession());
    return;
  }
  if (! req.body) {
    res.sendStatus(204);
    return;
  }
  let { nickname, avatarurl } = req.body;
  updateLogin(req.deviceId, { nickname, avatarurl }).then(ok => {
    if (! ok) {
      throw errors.badSession();
    }
    res.sendStatus(204);
  }, err => {
    console.warn("Error updating device info", err);
    throw errors.badParams();
  }).catch(next);
});

function sendAuthInfo(req, res, deviceId, userAbTests) {
  if (deviceId.search(/^[a-zA-Z0-9_-]+$/) == -1) {
    // FIXME: add logging message with deviceId
    throw new Error("Bad deviceId");
  }
  let encodedAbTests = b64EncodeJson(userAbTests);
  let keygrip = dbschema.getKeygrip();
  let cookies = new Cookies(req, res, {keys: keygrip});
  cookies.set("user", deviceId, {signed: true});
  cookies.set("abtests", encodedAbTests, {signed: true});
  let authHeader = `${deviceId}:${keygrip.sign(deviceId)};abTests=${encodedAbTests}:${keygrip.sign(encodedAbTests)}`;
  let responseJson = {
    ok: "User created",
    sentryPublicDSN: config.sentryPublicDSN,
    abTests: userAbTests,
    authHeader
  };
  // FIXME: I think there's a JSON sendResponse equivalent
  simpleResponse(res, JSON.stringify(responseJson), 200);
}


app.post("/api/login", function (req, res) {
  let vars = req.body;
  let deviceInfo = {};
  try {
    deviceInfo = JSON.parse(vars.deviceInfo);
  } catch (e) {
    if (e instanceof SyntaxError) {
      // JSON isn't valid
      deviceInfo = {};
    } else {
      throw e;
    }
  }
  checkLogin(vars.deviceId, vars.secret, deviceInfo.addonVersion).then((userAbTests) => {
    if (userAbTests) {
      sendAuthInfo(req, res, vars.deviceId, userAbTests);
      if (config.gaId) {
        let userAnalytics = ua(config.gaId, vars.deviceId, {strictCidFormat: false});
        userAnalytics.event({
          ec: "server",
          ea: "api-login",
          ua: req.headers["user-agent"],
          ni: true
        }).send();
      }
    } else if (! userAbTests) {
      simpleResponse(res, '{"error": "No such user"}', 404);
    } else {
      sendRavenMessage(req, "Invalid login");
      simpleResponse(res, '{"error": "Invalid login"}', 401);
    }
  }).catch(function (err) {
    errorResponse(res, JSON.stringify({"error": `Error in login: ${err}`}), err);
  });
});

app.post("/api/unload", function (req, res) {
  let reason = req.body.reason;
  reason = reason.replace(/[^a-zA-Z0-9]/g, "");
  console.info("Device", req.deviceId, "unloaded for reason:", reason);
  let cookies = new Cookies(req, res, {keys: dbschema.getKeygrip()});
  // This erases the session cookie:
  cookies.set("user");
  cookies.set("user.sig");
  cookies.set("abtests");
  cookies.set("abtests.sig");
  simpleResponse(res, "Noted", 200);
});

app.put("/data/:id/:domain", function (req, res) {
  let slowResponse = config.testing.slowResponse;
  let failSometimes = config.testing.failSometimes;
  if (failSometimes && Math.floor(Math.random()*failSometimes)) {
    console.info("Artificially making request fail");
    res.end();
    return;
  }
  let bodyObj = req.body;
  if (typeof bodyObj != "object") {
    throw new Error(`Got unexpected req.body type: ${typeof bodyObj}`);
  }
  let shotId = `${req.params.id}/${req.params.domain}`;

  if (! bodyObj.deviceId) {
    console.warn("No deviceId in request body", req.url);
    let keys = "No keys";
    try {
      keys = Object.keys(bodyObj);
    } catch (e) {
      // ignore
    }
    sendRavenMessage(
      req, "Attempt PUT without deviceId in request body",
      {extra:
        {
          "typeof bodyObj": typeof bodyObj,
          keys
        }
      }
    );
    simpleResponse(res, "No deviceId in body", 400);
    return;
  }
  if (! req.deviceId) {
    console.warn("Attempted to PUT without logging in", req.url);
    sendRavenMessage(req, "Attempt PUT without authentication");
    simpleResponse(res, "Not logged in", 401);
    return;
  }
  if (req.deviceId != bodyObj.deviceId) {
    // FIXME: this doesn't make sense for comments or other stuff, see https://github.com/mozilla-services/pageshot/issues/245
    console.warn("Attempted to PUT a page with a different deviceId than the login deviceId");
    sendRavenMessage(req, "Attempted to save page for another user");
    simpleResponse(res, "Cannot save a page on behalf of another user", 403);
    return;
  }
  let errors = checkContent(bodyObj.head)
    .concat(checkContent(bodyObj.body))
    .concat(checkAttributes(bodyObj.headAttrs, "head"))
    .concat(checkAttributes(bodyObj.bodyAttrs, "body"))
    .concat(checkAttributes(bodyObj.htmlAttrs, "html"));
  if (errors.length) {
    console.warn("Attempted to submit page with invalid HTML:", errors.join("; ").substr(0, 60));
    sendRavenMessage(req, "Errors in submission", {extra: {errors: errors}});
    simpleResponse(res, "Errors in submission", 400);
    return;
  }
  let shot = new Shot(req.deviceId, req.backend, shotId, bodyObj);
  let responseDelay = Promise.resolve()
  if (slowResponse) {
    responseDelay = new Promise((resolve) => {
      setTimeout(resolve, slowResponse);
    });
  }
  responseDelay.then(() => {
    return shot.insert();
  }).then((inserted) => {
    if (! inserted) {
      return shot.update();
    }
    return inserted;
  }).then((commands) => {
    commands = commands || [];
    simpleResponse(res, JSON.stringify({updates: commands.filter((x) => !!x)}), 200);
  }).catch((err) => {
    errorResponse(res, "Error saving Object:", err);
  });
});

app.get("/data/:id/:domain", function (req, res) {
  let shotId = `${req.params.id}/${req.params.domain}`;
  Shot.getRawValue(shotId).then((data) => {
    if (! data) {
      simpleResponse(res, "No such shot", 404);
    } else {
      let value = data.value;
      value = JSON.parse(value);
      delete value.deviceId;
      value = JSON.stringify(value);
      if ('format' in req.query) {
        value = JSON.stringify(JSON.parse(value), null, '  ');
      }
      res.header("Content-Type", "application/json");
      res.send(value);
    }
  }).catch(function (err) {
    errorResponse(res, "Error serving data:", err);
  });
});

app.post("/api/delete-shot", function (req, res) {
  if (! req.deviceId) {
    sendRavenMessage(req, "Attempt to delete shot without login");
    simpleResponse(res, "Not logged in", 401);
    return;
  }
  Shot.deleteShot(req.backend, req.body.id, req.deviceId).then((result) => {
    if (result) {
      simpleResponse(res, "ok", 200);
    } else {
      sendRavenMessage(req, "Attempt to delete shot that does not exist");
      simpleResponse(res, "No such shot", 404);
    }
  }).catch((err) => {
    errorResponse(res, "Error: could not delete shot", err);
  });
});

app.post("/api/set-title/:id/:domain", function (req, res) {
  let shotId = `${req.params.id}/${req.params.domain}`;
  let userTitle = req.body.title;
  if (userTitle === undefined) {
    simpleResponse(res, "No title given", 400);
    return;
  }
  if (! req.deviceId) {
    sendRavenMessage(req, "Attempt to set title on shot without login");
    simpleResponse(res, "Not logged in", 401);
    return;
  }
  Shot.get(req.backend, shotId).then((shot) => {
    if (shot.deviceId !== req.deviceId) {
      simpleResponse(res, "Not the owner", 403);
      return;
    }
    shot.userTitle = userTitle;
    return shot.update();
  }).then((updated) => {
    simpleResponse(res, "Updated", 200);
  }).catch((err) => {
    errorResponse(res, "Error updating title", err);
  });
});

/*
app.post("/api/add-saved-shot-data/:id/:domain", function (req, res) {
  let shotId = `${req.params.id}/${req.params.domain}`;
  let bodyObj = req.body;
  Shot.get(req.backend, shotId).then((shot) => {
    if (! shot) {
      sendRavenMessage(req, "Attempt to add saved shot data when no shot exists");
      simpleResponse(res, "No such shot", 404);
      return;
    }
    let errors = checkContent(bodyObj.head)
      .concat(checkContent(bodyObj.body))
      .concat(checkAttributes(bodyObj.headAttrs, "head"))
      .concat(checkAttributes(bodyObj.bodyAttrs, "body"))
      .concat(checkAttributes(bodyObj.htmlAttrs, "html"));
    if (errors.length) {
      console.warn("Attempted to submit page with invalid HTML:", errors.join("; ").substr(0, 60));
      sendRavenMessage(req, "Errors in submission when adding saved shot", {extra: {errors: errors}});
      simpleResponse(res, "Errors in submission", 400);
      return;
    }
    for (let attr in bodyObj) {
      if (! ["body", "head", "headAttrs", "bodyAttrs", "htmlAttrs", "showPage", "readable", "resources"].includes(attr)) {
        console.warn("Unexpected attribute in update:", attr);
        sendRavenMessage(req, "Unexpected attribute in submission", {extra: {attr}});
        simpleResponse(res, "Unexpected attribute in submission", 400);
        return;
      }
      shot[attr] = bodyObj[attr];
    }
    return shot.update().then(() => {
      simpleResponse(res, "ok", 200);
    });
  }).catch((err) => {
    errorResponse(res, "Error serving data:", err);
  });

});
*/

app.post("/api/set-expiration", function (req, res) {
  if (! req.deviceId) {
    sendRavenMessage(req, "Attempt to set expiration without login");
    simpleResponse(res, "Not logged in", 401);
    return;
  }
  let shotId = req.body.id;
  let expiration = parseInt(req.body.expiration, 10);
  if (expiration < 0) {
    sendRavenMessage(req, "Attempt negative expiration", {extra: {expiration}});
    simpleResponse(res, "Error: negative expiration", 400);
    return;
  }
  if (isNaN(expiration)) {
    sendRavenMessage(req, "Set expiration to non-number", {extra: {rawExpiration: req.body.expiration}});
    simpleResponse(res, `Error: bad expiration (${req.body.expiration})`, 400);
    return;
  }
  Shot.setExpiration(req.backend, shotId, req.deviceId, expiration).then((result) => {
    if (result) {
      simpleResponse(res, "ok", 200);
    } else {
      sendRavenMessage(req, "Attempt to set expiration on shot that does not exist");
      simpleResponse(res, "No such shot", 404);
    }
  }).catch((err) => {
    errorResponse(res, "Error: could not set expiration on shot", err);
  });
});

app.get("/images/:imageid", function (req, res) {
  let embedded = req.query.embedded;
  Shot.getRawBytesForClip(
    req.params.imageid
  ).then((obj) => {
    if (obj === null) {
      notFound(req, res);
    } else {
      let localReferrer = false;
      if (req.headers["referer"]) {
        localReferrer = req.headers["referer"].startsWith(req.backend);
      }
      if (! localReferrer) {
        let hasher = require("crypto").createHash("sha1");
        hasher.update(req.params.imageid);
        let hashedId = hasher.digest("hex").substr(0, 15);
        let analyticsUrl = `/images/${embedded ? 'embedded/' : ''}hash${encodeURIComponent(hashedId)}`;
        let analytics = req.userAnalytics;
        if (! analytics) {
          analytics = ua(config.gaId);
          if (config.debugGoogleAnalytics) {
            analytics = analytics.debug();
          }
        }
        analytics.pageview({
          dp: analyticsUrl,
          dh: req.backend,
          documentReferrer: req.headers["referer"],
          ua: req.headers["user-agent"]
        }).event({
          ec: "web",
          ea: "visit",
          el: embedded ? "direct-view-embedded" : "direct-view"
        }).send();
      }
      res.header("Content-Type", obj.contentType);
      res.status(200);
      res.send(obj.data);
    }
  });
});

app.get("/__version__", function (req, res) {
  let response = {
    source: "https://github.com/mozilla-services/pageshot/",
    description: "Page Shot application server",
    version: selfPackage.version,
    buildDate: buildTime,
    commit: linker.getGitRevision(),
    contentOrigin: config.contentOrigin,
    commitLog: `https://github.com/mozilla-services/pageshot/commits/${linker.getGitRevision()}`,
    unincludedCommits: `https://github.com/mozilla-services/pageshot/compare/${linker.getGitRevision()}...master`,
    dbSchemaVersion: dbschema.MAX_DB_LEVEL
  };
  res.header("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(response, null, '  '));
});

// This is a minimal heartbeat that only indicates the server process is up and responding
app.get("/__lbheartbeat__", function (req, res) {
  res.send("OK");
});

// This tests if the server is really working
app.get("/__heartbeat__", function (req, res) {
  dbschema.connectionOK().then((ok) => {
    if (! ok) {
      statsd.increment("heartbeat.fail");
      res.status(500).send("schema fail");
    } else {
      statsd.increment("heartbeat.pass");
      res.send("OK");
    }
  }).catch((error) => {
    statsd.increment("heartbeat.fail");
    res.status(500).send("database fail");
  });
});

app.get("/contribute.json", function (req, res) {
  let data = {
    name: "Page Shot",
    description: "Page Shot is an add-on for Firefox and a service for screenshots and other ways to capture and share content",
    repository: {
      url: "https://github.com/mozilla-services/pageshot/",
      license: "MPL2",
      tests: "https://travis-ci.org/mozilla-services/pageshot"
    },
    participate: {
      home: "https://github.com/mozilla-services/pageshot/",
      irc: "irc://irc.mozilla.org/#pageshot",
      "irc-contacts": ["ianbicking", "fzzzy"]
    },
    bugs: {
      list: "https://github.com/mozilla-services/pageshot/issues",
      report: "https://github.com/mozilla-services/pageshot/issues/new",
      goodfirstbugs: "https://github.com/mozilla-services/pageshot/labels/good%20first%20bug"
    },
    urls: {
      prod: "https://pageshot.net",
      stage: "https://pageshot.stage.mozaws.net/"
    },
    keywords: [
      "javascript",
      "node",
      "express",
      "react",
      "postgresql",
      "firefox"
    ]
  };
  res.header("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(data, null, '  '));
});

app.get("/oembed", function (req, res) {
  let url = req.query.url;
  if (! url) {
    simpleResponse(req, "No ?url given", 400);
    return;
  }
  let format = req.query.format || "json";
  if (format !== "json") {
    return simpleResponse(res, "Only JSON OEmbed is supported", 501);
  }
  let maxwidth = req.query.maxwidth || null;
  if (maxwidth) {
    maxwidth = parseInt(maxwidth, 10);
  }
  let maxheight = req.query.maxheight || null;
  if (maxheight) {
    maxheight = parseInt(maxheight, 10);
  }
  url = url.replace(/^http:\/\//i, "https://");
  let backend = req.backend.replace(/^http:\/\//i, "https://");
  if (! url.startsWith(backend)) {
    return simpleResponse(res, `Error: URL is not hosted here (${req.backend})`, 501);
  }
  url = url.substr(backend.length);
  let match = /^\/*([^\/]+)\/([^\/]+)/.exec(url);
  if (! match) {
    return simpleResponse(res, "Error: not a Shot url", 404);
  }
  let shotId = match[1] + "/" + match[2];
  Shot.get(req.backend, shotId).then((shot) => {
    if (! shot) {
      notFound(req, res);
      return;
    }
    let body = shot.oembedJson({maxheight, maxwidth});
    res.header("Content-Type", "application/json");
    res.send(body);
  });
});

// Get OAuth client params for the client-side authorization flow.
app.get('/api/fxa-oauth/params', function (req, res, next) {
  if (! req.deviceId) {
    next(errors.missingSession());
    return;
  }
  randomBytes(32).then(stateBytes => {
    let state = stateBytes.toString('hex');
    return setState(req.deviceId, state).then(inserted => {
      if (!inserted) {
        throw errors.dupeLogin();
      }
      return state;
    });
  }).then(state => {
    res.send({
      // FxA profile server URL.
      profile_uri: config.oAuth.profileServer,
      // FxA OAuth server URL.
      oauth_uri: config.oAuth.oAuthServer,
      redirect_uri: 'urn:ietf:wg:oauth:2.0:fx:webchannel',
      client_id: config.oAuth.clientId,
      // FxA content server URL.
      content_uri: config.oAuth.contentServer,
      state,
      scope: 'profile'
    });
  }).catch(next);
});

// Exchange an OAuth authorization code for an access token.
app.post('/api/fxa-oauth/token', function (req, res, next) {
  if (! req.deviceId) {
    next(errors.missingSession());
    return;
  }
  if (! req.body) {
    next(errors.missingParams());
    return;
  }
  let { code, state } = req.body;
  checkState(req.deviceId, state).then(isValid => {
    if (!isValid) {
      throw errors.badState();
    }
    return tradeCode(code);
  }).then(({ access_token: accessToken }) => {
    return getAccountId(accessToken).then(({ uid: accountId }) => {
      return registerAccount(req.deviceId, accountId, accessToken);
    }).then(() => {
      res.send({
        access_token: accessToken
      });
    }).catch(next);
  }).catch(next);
});

if (! config.disableMetrics) {
  app.use("/metrics", require("./pages/metrics/server").app);
}

app.use("/shots", require("./pages/shotindex/server").app);

app.use("/leave-page-shot", require("./pages/leave-page-shot/server").app);

app.use("/terms", require("./pages/legal/server").app);

app.use("/privacy", require("./pages/legal/server").app);

app.use("/creating", require("./pages/creating/server").app);

app.use("/", require("./pages/shot/server").app);

app.use("/", require("./pages/homepage/server").app);

app.get("/proxy", function (req, res) {
  let url = req.query.url;
  let sig = req.query.sig;
  let isValid = dbschema.getKeygrip().verify(new Buffer(url, 'utf8'), sig);
  if (! isValid) {
    sendRavenMessage(req, "Bad signature on proxy", {extra: {proxyUrl: url, sig: sig}});
    return simpleResponse(res, "Bad signature", 403);
  }
  url = urlParse(url);
  let httpModule = http;
  if (url.protocol == "https:") {
    httpModule = https;
  }
  let headers = {};
  for (let passthrough of ["user-agent", "if-modified-since", "if-none-match"]) {
    if (req.headers[passthrough]) {
      headers[passthrough] = req.headers[passthrough];
    }
  }
  let host = url.host.split(":")[0];
  let subreq = httpModule.request({
    protocol: url.protocol,
    host: host,
    port: url.port,
    method: "GET",
    path: url.path,
    headers: headers
  });
  subreq.on("response", function (subres) {
    let headers = {};
    for (let h in subres.headers) {
      if (PROXY_HEADER_WHITELIST[h]) {
        headers[h] = subres.headers[h];
      }
    }
    // Cache for 30 days
    headers["cache-control"] = "public, max-age=2592000";
    headers["expires"] = new Date(Date.now() + 2592000000).toUTCString();
    res.writeHead(subres.statusCode, subres.statusMessage, headers);

    subres.on("data", function (chunk) {
      res.write(chunk);
    });
    subres.on("end", function () {
      res.end();
    });
    subres.on("error", function (err) {
      errorResponse(res, "Error getting response:", err);
    });
  });
  subreq.on("error", function (err) {
    errorResponse(res, "Error fetching:", err);
  });
  subreq.end();
});

let httpsCredentials;
if (config.localhostSsl) {
  // To generate trusted keys on Mac, see: https://certsimple.com/blog/localhost-ssl-fix
  let key = `${process.env.HOME}/.localhost-ssl/key.pem`;
  let cert = `${process.env.HOME}/.localhost-ssl/cert.pem`;
  if (! (existsSync(key) && existsSync(cert))) {
    console.log("Error: to use localhost SSL/HTTPS you must create a key.pem and cert.pem file");
    console.log("  These must be located in:");
    console.log(`    ${key}`);
    console.log(`    ${cert}`);
    console.log("  You can find instructions on creating these files here:");
    console.log("    https://certsimple.com/blog/localhost-ssl-fix");
    process.exit(2);
  }
  httpsCredentials = {
    key: readFileSync(key),
    cert: readFileSync(cert)
  };
}

linker.init().then(() => {
  let server;
  let scheme;
  if (httpsCredentials) {
    server = https.createServer(httpsCredentials, app);
    scheme = "https";
  } else {
    server = http.createServer(app);
    scheme = "http";
  }
  server.listen(config.port);
  console.info(`server listening on ${scheme}://localhost:${config.port}/`);
}).catch((err) => {
  console.error("Error getting git revision:", err, err.stack);
});

require("./jobs").start();

addRavenErrorHandler(app);

app.use(function (err, req, res, next) {
  if (err.isAppError) {
    let { statusCode, headers, payload } = err.output;
    res.status(statusCode);
    res.header(headers);
    res.send(payload);
    return;
  }
  errorResponse(res, "General error:", err);
});

/* General 404 handler: */
app.use(function(req, res, next) {
  notFound(req, res);
});
