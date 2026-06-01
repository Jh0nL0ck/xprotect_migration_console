const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PORT || 4173);
const root = __dirname;
const sessions = {
  source: null,
  target: null
};

const staticTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png"
};

const resourceMap = [
  {
    id: "cameras",
    resources: ["cameras"]
  },
  {
    id: "cameraGroups",
    resources: ["cameraGroups", "deviceGroups", "cameraDeviceGroups"]
  },
  {
    id: "roles",
    resources: ["roles"]
  },
  {
    id: "rules",
    resources: ["rules"]
  },
  {
    id: "views",
    resources: ["views", "viewGroups"]
  },
  {
    id: "alarms",
    resources: ["alarmDefinitions", "alarms"]
  }
];

const sampleCounts = {
  cameras: 128,
  cameraGroups: 18,
  roles: 9,
  rules: 34,
  views: 42,
  alarms: 16
};

function baseServerUrl(serverUrl) {
  const url = new URL(serverUrl.trim());
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function normalizeServerUrl(serverUrl) {
  const url = new URL(serverUrl.trim());
  const pathName = url.pathname.replace(/\/$/, "");

  if (!pathName.toLowerCase().endsWith("/api/rest/v1")) {
    url.pathname = `${pathName}/API/rest/v1`;
  }

  return url.toString().replace(/\/$/, "");
}

function readResponseBody(response) {
  return new Promise((resolve, reject) => {
    let body = "";

    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      body += chunk;
    });
    response.on("end", () => {
      resolve(body);
    });
    response.on("error", reject);
  });
}

async function httpRequest(connection, url, options = {}) {
  const endpointUrl = new URL(url);
  const headers = {
    ...options.headers
  };

  const client = endpointUrl.protocol === "https:" ? https : http;

  const response = await new Promise((resolve, reject) => {
    const request = client.request(endpointUrl, {
      method: options.method || "GET",
      headers,
      rejectUnauthorized: !connection.allowSelfSigned,
      timeout: 10000
    }, resolve);

    request.on("timeout", () => {
      request.destroy(new Error("Connection timed out after 10 seconds"));
    });
    request.on("error", reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });

  const body = await readResponseBody(response);

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${response.statusCode} ${response.statusMessage}`);
  }

  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error("Server returned a non-JSON response");
  }
}

async function requestAccessToken(connection) {
  const body = new URLSearchParams({
    grant_type: "password",
    username: connection.username,
    password: connection.password,
    client_id: "GrantValidatorClient"
  }).toString();

  const payload = await httpRequest(connection, `${connection.serverBase}/api/idp/connect/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body)
    },
    body
  });

  if (!payload.access_token) {
    throw new Error("Identity Provider did not return an access token");
  }

  connection.accessToken = payload.access_token;
  connection.tokenType = payload.token_type || "Bearer";
  connection.tokenExpiresAt = Date.now() + ((payload.expires_in || 3600) * 1000);
}

async function ensureAccessToken(connection) {
  if (connection.sampleMode) {
    return;
  }

  if (!connection.accessToken || Date.now() > connection.tokenExpiresAt - 60000) {
    await requestAccessToken(connection);
  }
}

async function xprotectFetch(connection, resourcePath) {
  await ensureAccessToken(connection);

  const endpoint = `${connection.apiBase}/${resourcePath.replace(/^\//, "")}`;
  const headers = {
    Accept: "application/json",
    Authorization: `${connection.tokenType} ${connection.accessToken}`
  };

  return httpRequest(connection, endpoint, {
    headers
  });
}

function extractCount(payload, resourceName) {
  if (typeof payload.count === "number") {
    return payload.count;
  }

  if (Array.isArray(payload.data)) {
    return payload.data.length;
  }

  if (payload.data && typeof payload.data.count === "number") {
    return payload.data.count;
  }

  if (payload.data && Array.isArray(payload.data[resourceName])) {
    return payload.data[resourceName].length;
  }

  if (Array.isArray(payload[resourceName])) {
    return payload[resourceName].length;
  }

  return 0;
}

async function countResource(connection, resourceNames) {
  const errors = [];

  for (const resourceName of resourceNames) {
    try {
      const payload = await xprotectFetch(connection, `${resourceName}?count&disabled`);
      return extractCount(payload, resourceName);
    } catch (error) {
      errors.push(`${resourceName}: ${error.message}`);
    }
  }

  throw new Error(errors.join("; "));
}

async function probeConnection(connection) {
  const errors = [];
  const probeResources = [
    "cameras?count&disabled",
    "roles?count",
    "rules?count",
    "alarmDefinitions?count"
  ];

  for (const resourcePath of probeResources) {
    try {
      await xprotectFetch(connection, resourcePath);
      return resourcePath;
    } catch (error) {
      errors.push(`${resourcePath}: ${error.message}`);
    }
  }

  throw new Error(`Could not reach the XProtect REST Config API at ${connection.apiBase}. Tried ${errors.join("; ")}`);
}

async function buildInventory(connection) {
  if (connection.sampleMode) {
    return resourceMap.map((resource) => ({
      id: resource.id,
      count: sampleCounts[resource.id]
    }));
  }

  const objects = [];

  for (const resource of resourceMap) {
    try {
      objects.push({
        id: resource.id,
        count: await countResource(connection, resource.resources)
      });
    } catch (error) {
      objects.push({
        id: resource.id,
        count: 0,
        error: error.message
      });
    }
  }

  return objects;
}

function validateConnectionPayload(payload) {
  if (!payload.url || !payload.username || !payload.password) {
    throw new Error("Server URL, username, and password are required.");
  }

  if (payload.auth !== "basic" && !payload.sampleMode) {
    throw new Error("Only Basic authentication is implemented in this prototype.");
  }
}

async function connectSystem(system, payload) {
  validateConnectionPayload(payload);

  const connection = {
    serverUrl: payload.url,
    serverBase: baseServerUrl(payload.url),
    apiBase: normalizeServerUrl(payload.url),
    username: payload.username,
    password: payload.password,
    auth: payload.auth,
    sampleMode: payload.sampleMode,
    allowSelfSigned: payload.allowSelfSigned
  };

  if (!connection.sampleMode) {
    connection.probeResource = await probeConnection(connection);
  }

  sessions[system] = connection;

  return {
    serverUrl: connection.serverUrl,
    apiBase: connection.apiBase,
    sampleMode: connection.sampleMode,
    probeResource: connection.probeResource
  };
}

async function handleApi(request, response, requestUrl) {
  try {
    if (request.method === "POST" && requestUrl.pathname === "/api/source/connect") {
      const payload = await readRequestJson(request);
      sendJson(response, 200, await connectSystem("source", payload));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/target/connect") {
      const payload = await readRequestJson(request);
      sendJson(response, 200, await connectSystem("target", payload));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/source/inventory") {
      if (!sessions.source) {
        sendJson(response, 409, {
          error: "Source system is not connected."
        });
        return;
      }

      sendJson(response, 200, {
        objects: await buildInventory(sessions.source)
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/migrate") {
      const payload = await readRequestJson(request);

      if (!sessions.source || !sessions.target) {
        sendJson(response, 409, {
          error: "Source and target systems must be connected before migration."
        });
        return;
      }

      if (!Array.isArray(payload.objects) || payload.objects.length === 0) {
        sendJson(response, 400, {
          error: "Select at least one configuration object to migrate."
        });
        return;
      }

      sendJson(response, 200, {
        message: "Migration queued. Recordings and stored events were not moved.",
        objects: payload.objects
      });
      return;
    }

    sendJson(response, 404, {
      error: "API route not found."
    });
  } catch (error) {
    sendJson(response, 400, {
      error: error.message
    });
  }
}

function serveStatic(requestUrl, response) {
  const requestedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = path.normalize(path.join(root, decodeURIComponent(requestedPath)));
  const relativePath = path.relative(root, filePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": staticTypes[path.extname(filePath)] || "application/octet-stream"
    });
    response.end(data);
  });
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://localhost:${port}`);

  if (requestUrl.pathname.startsWith("/api/")) {
    handleApi(request, response, requestUrl);
    return;
  }

  serveStatic(requestUrl, response);
});

server.listen(port, () => {
  console.log(`Migration console available at http://localhost:${port}`);
});
