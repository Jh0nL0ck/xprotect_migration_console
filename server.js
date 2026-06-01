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
    id: "users",
    resources: ["users", "basicUsers", "windowsUsers"]
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
  users: 12,
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

function sameOriginUrl(baseUrl, pathName) {
  const url = new URL(baseUrl);
  url.pathname = pathName;
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

function configureConnectionProfile(connection) {
  if (connection.connectionProfile === "legacy") {
    connection.identityCandidates = [`${connection.serverBase}/IDP`];
    connection.apiBase = `${connection.serverBase}/API/rest/v1`;
    return;
  }

  if (connection.connectionProfile === "modern") {
    connection.identityCandidates = [`${connection.serverBase}/api/idp`];
    connection.apiBase = `${connection.serverBase}/api/rest/v1`;
  }
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
    const detail = body ? ` - ${body.slice(0, 300)}` : "";
    const error = new Error(`${response.statusCode} ${response.statusMessage}${detail}`);
    error.statusCode = response.statusCode;
    error.responseBody = body;
    throw error;
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

function isCredentialFailure(error) {
  if (error.statusCode !== 400 && error.statusCode !== 401) {
    return false;
  }

  return /invalid_grant|invalid_username_or_password|LockedOut/i.test(error.responseBody || error.message);
}

async function tryJsonRequest(connection, urls, options = {}) {
  const errors = [];

  for (const url of urls) {
    try {
      return {
        payload: await httpRequest(connection, url, options),
        url
      };
    } catch (error) {
      if (options.stopOnCredentialFailure && isCredentialFailure(error)) {
        throw new Error(`Authentication failed at ${url}: ${error.message}`);
      }

      errors.push(`${url}: ${error.message}`);
    }
  }

  throw new Error(errors.join("; "));
}

async function discoverGateway(connection) {
  const discoveryUrls = [
    `${connection.serverBase}/API/.well-known/uris`,
    `${connection.serverBase}/api/.well-known/uris`
  ];
  const result = await tryJsonRequest(connection, discoveryUrls);
  const discovery = result.payload;

  connection.productVersion = discovery.ProductVersion;

  if (discovery.IdentityProvider) {
    const identityUrl = new URL(discovery.IdentityProvider);
    connection.identityCandidates = [
      sameOriginUrl(connection.serverBase, identityUrl.pathname),
      discovery.IdentityProvider.replace(/\/$/, "")
    ];
  }

  if (Array.isArray(discovery.ApiGateways) && discovery.ApiGateways.length > 0) {
    const apiGatewayUrl = new URL(discovery.ApiGateways[0]);
    connection.apiBase = `${sameOriginUrl(connection.serverBase, apiGatewayUrl.pathname)}/rest/v1`;
  }
}

async function requestAccessToken(connection) {
  const body = new URLSearchParams({
    grant_type: "password",
    username: connection.username,
    password: connection.password,
    client_id: "GrantValidatorClient"
  }).toString();

  const identityCandidates = connection.identityCandidates || [
    `${connection.serverBase}/IDP`,
    `${connection.serverBase}/api/idp`
  ];
  const tokenBases = new Set(identityCandidates);

  for (const identityBase of identityCandidates) {
    const identityUrl = new URL(identityBase);
    const normalizedPath = identityUrl.pathname.replace(/^\/+|\/+$/g, "");

    if (normalizedPath && !normalizedPath.toLowerCase().startsWith("api/")) {
      tokenBases.add(`${connection.serverBase}/API/${normalizedPath}`);
      tokenBases.add(`${connection.serverBase}/api/${normalizedPath.toLowerCase()}`);
    }
  }

  tokenBases.add(`${connection.serverBase}/API/IDP`);
  tokenBases.add(`${connection.serverBase}/api/idp`);
  tokenBases.add(`${connection.serverBase}/IDP`);
  tokenBases.add(`${connection.serverBase}/idp`);

  const tokenUrls = [...new Set([...tokenBases].map((identityBase) => `${identityBase}/connect/token`))];
  const result = await tryJsonRequest(connection, tokenUrls, {
    method: "POST",
    stopOnCredentialFailure: true,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body)
    },
    body
  });
  const payload = result.payload;

  if (!payload.access_token) {
    throw new Error("Identity Provider did not return an access token");
  }

  connection.accessToken = payload.access_token;
  connection.tokenType = payload.token_type || "Bearer";
  connection.tokenExpiresAt = Date.now() + ((payload.expires_in || 3600) * 1000);
  connection.tokenEndpoint = result.url;
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

async function xprotectJson(connection, resourcePath, method, payload) {
  await ensureAccessToken(connection);

  const body = JSON.stringify(payload);
  const endpoint = `${connection.apiBase}/${resourcePath.replace(/^\//, "")}`;
  const headers = {
    Accept: "application/json",
    Authorization: `${connection.tokenType} ${connection.accessToken}`,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  };

  return httpRequest(connection, endpoint, {
    method,
    headers,
    body
  });
}

function extractCount(payload, resourceName) {
  if (typeof payload.count === "number") {
    return payload.count;
  }

  if (Array.isArray(payload.data)) {
    return payload.data.length;
  }

  if (Array.isArray(payload.array)) {
    return payload.array.length;
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

function extractCollection(payload, resourceName) {
  if (Array.isArray(payload.array)) {
    return payload.array;
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  if (payload.data && Array.isArray(payload.data[resourceName])) {
    return payload.data[resourceName];
  }

  if (Array.isArray(payload[resourceName])) {
    return payload[resourceName];
  }

  return [];
}

function itemDisplayName(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  return item.displayName || item.name || item.userName || item.id || null;
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function itemId(item) {
  return item.id || item.path || item.referenceId || null;
}

function buildNameMap(sourceItems, targetItems) {
  const targetByName = new Map();
  const mapped = [];
  const missing = [];

  for (const target of targetItems) {
    const name = normalizeName(itemDisplayName(target));

    if (name && !targetByName.has(name)) {
      targetByName.set(name, target);
    }
  }

  for (const source of sourceItems) {
    const sourceName = itemDisplayName(source);
    const target = targetByName.get(normalizeName(sourceName));

    if (target) {
      mapped.push({
        sourceId: itemId(source),
        targetId: itemId(target),
        name: sourceName
      });
    } else {
      missing.push(sourceName || itemId(source) || "Unnamed item");
    }
  }

  return {
    mapped,
    missing
  };
}

function replaceMappedIds(value, idMap) {
  if (Array.isArray(value)) {
    return value.map((item) => replaceMappedIds(item, idMap));
  }

  if (value && typeof value === "object") {
    const clone = {};

    for (const [key, childValue] of Object.entries(value)) {
      clone[key] = replaceMappedIds(childValue, idMap);
    }

    return clone;
  }

  if (typeof value === "string" && idMap.has(value)) {
    return idMap.get(value);
  }

  return value;
}

function sanitizeForCreate(item) {
  const clone = JSON.parse(JSON.stringify(item));
  const readOnlyKeys = [
    "id",
    "path",
    "parentPath",
    "lastModified",
    "created",
    "lastModifiedTime",
    "createdTime",
    "links",
    "_links"
  ];

  for (const key of readOnlyKeys) {
    delete clone[key];
  }

  return clone;
}

async function fetchResourceCollection(connection, resourceNames) {
  const errors = [];

  for (const resourceName of resourceNames) {
    try {
      const payload = await xprotectFetch(connection, `${resourceName}?page=0&size=100&disabled`);
      const collection = extractCollection(payload, resourceName);

      return {
        resourceName,
        collection
      };
    } catch (error) {
      errors.push(`${resourceName}: ${error.message}`);
    }
  }

  throw new Error(errors.join("; "));
}

async function summarizeResource(connection, resourceNames) {
  const errors = [];

  for (const resourceName of resourceNames) {
    try {
      const payload = await xprotectFetch(connection, `${resourceName}?page=0&size=100&disabled`);
      const collection = extractCollection(payload, resourceName);
      const items = collection.map(itemDisplayName).filter(Boolean).slice(0, 6);

      return {
        count: collection.length || extractCount(payload, resourceName),
        items
      };
    } catch (error) {
      errors.push(`${resourceName}: ${error.message}`);
    }
  }

  throw new Error(errors.join("; "));
}

async function probeConnection(connection) {
  await ensureAccessToken(connection);

  const errors = [];
  const probeResources = [
    "cameras?page=0&size=1&disabled",
    "rules?page=0&size=1&disabled",
    "alarmDefinitions?page=0&size=1&disabled"
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
      const summary = await summarizeResource(connection, resource.resources);

      objects.push({
        id: resource.id,
        count: summary.count,
        items: summary.items
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

async function migrateObjectType(objectId) {
  const resource = resourceMap.find((item) => item.id === objectId);

  if (!resource) {
    return {
      id: objectId,
      status: "failed",
      exported: 0,
      imported: 0,
      errors: [`Unknown object type: ${objectId}`]
    };
  }

  if (sessions.source.sampleMode || sessions.target.sampleMode) {
    return {
      id: objectId,
      status: "skipped",
      exported: 0,
      imported: 0,
      errors: ["Sample data mode cannot perform a real migration."]
    };
  }

  if (objectId === "cameras") {
    const sourceData = await fetchResourceCollection(sessions.source, resource.resources);
    const targetData = await fetchResourceCollection(sessions.target, resource.resources);
    const mapping = buildNameMap(sourceData.collection, targetData.collection);

    return {
      id: objectId,
      status: mapping.missing.length ? "requires_mapping" : "mapped",
      exported: sourceData.collection.length,
      imported: 0,
      mapped: mapping.mapped.length,
      errors: mapping.missing.length
        ? [`${mapping.missing.length} cameras were not found by name on the target: ${mapping.missing.slice(0, 8).join(", ")}`]
        : ["Cameras were mapped by name. Camera creation is not attempted because cameras depend on recording server and hardware configuration."]
    };
  }

  if (objectId === "users") {
    const sourceData = await fetchResourceCollection(sessions.source, resource.resources);
    const targetData = await fetchResourceCollection(sessions.target, resource.resources).catch(() => ({
      collection: []
    }));
    const mapping = buildNameMap(sourceData.collection, targetData.collection);

    return {
      id: objectId,
      status: mapping.missing.length ? "requires_mapping" : "mapped",
      exported: sourceData.collection.length,
      imported: 0,
      mapped: mapping.mapped.length,
      errors: mapping.missing.length
        ? [`${mapping.missing.length} users are missing on target or require a temporary password: ${mapping.missing.slice(0, 8).join(", ")}`]
        : ["Users were mapped by name. User creation is not attempted because XProtect does not expose existing passwords."]
    };
  }

  const sourceData = await fetchResourceCollection(sessions.source, resource.resources);
  const targetResource = sourceData.resourceName;
  const result = {
    id: objectId,
    resource: targetResource,
    status: "completed",
    exported: sourceData.collection.length,
    imported: 0,
    errors: []
  };

  for (const item of sourceData.collection) {
    try {
      const payload = objectId === "alarms"
        ? await applyCameraMapping(sanitizeForCreate(item))
        : sanitizeForCreate(item);

      await xprotectJson(sessions.target, targetResource, "POST", payload);
      result.imported += 1;
    } catch (error) {
      result.errors.push(`${itemDisplayName(item) || "Unnamed item"}: ${error.message}`);
    }
  }

  if (result.errors.length > 0 && result.imported > 0) {
    result.status = "partial";
  } else if (result.errors.length > 0) {
    result.status = "failed";
  }

  return result;
}

async function cameraIdMap() {
  const sourceData = await fetchResourceCollection(sessions.source, ["cameras"]);
  const targetData = await fetchResourceCollection(sessions.target, ["cameras"]);
  const mapping = buildNameMap(sourceData.collection, targetData.collection);
  const idMap = new Map();

  for (const item of mapping.mapped) {
    if (item.sourceId && item.targetId) {
      idMap.set(item.sourceId, item.targetId);
    }
  }

  return idMap;
}

async function applyCameraMapping(payload) {
  const idMap = await cameraIdMap();

  if (idMap.size === 0) {
    return payload;
  }

  return replaceMappedIds(payload, idMap);
}

async function migrateObjects(objectIds) {
  const results = [];

  for (const objectId of objectIds) {
    try {
      results.push(await migrateObjectType(objectId));
    } catch (error) {
      results.push({
        id: objectId,
        status: "failed",
        exported: 0,
        imported: 0,
        errors: [error.message]
      });
    }
  }

  const imported = results.reduce((total, result) => total + result.imported, 0);
  const exported = results.reduce((total, result) => total + result.exported, 0);

  return {
    message: `Migration finished: ${imported} of ${exported} exported items imported. Recordings and stored events were not moved.`,
    results
  };
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
    connectionProfile: payload.connectionProfile || "auto",
    sampleMode: payload.sampleMode,
    allowSelfSigned: payload.allowSelfSigned
  };

  if (!connection.sampleMode) {
    configureConnectionProfile(connection);

    if (connection.connectionProfile === "auto") {
      await discoverGateway(connection);
    }

    connection.probeResource = await probeConnection(connection);
  }

  sessions[system] = connection;

  return {
    serverUrl: connection.serverUrl,
    apiBase: connection.apiBase,
    sampleMode: connection.sampleMode,
    probeResource: connection.probeResource,
    productVersion: connection.productVersion
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

      sendJson(response, 200, await migrateObjects(payload.objects));
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
