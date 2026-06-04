const objectDefinitions = [
  {
    id: "hardware",
    label: "Hardware",
    description: "Recording-server hardware devices that contain cameras, microphones, inputs, outputs, and metadata."
  },
  {
    id: "cameraGroups",
    label: "Camera groups",
    description: "Logical groups used by operators, rules, permissions, and views."
  },
  {
    id: "users",
    label: "Users",
    description: "Basic and Windows users available for role and permission migration."
  },
  {
    id: "roles",
    label: "Roles",
    description: "Operator roles, permissions, and mapped user membership."
  },
  {
    id: "rules",
    label: "Rules",
    description: "Automation rules, schedules, actions, and related triggers."
  },
  {
    id: "views",
    label: "Views",
    description: "Shared layouts and operator views available after migration."
  },
  {
    id: "alarms",
    label: "Alarms",
    description: "Alarm definitions, priorities, categories, and handling setup."
  }
];

const state = {
  sourceConnected: false,
  targetConnected: false,
  inventory: []
};

const sourceForm = document.querySelector("#sourceForm");
const targetForm = document.querySelector("#targetForm");
const sourceBadge = document.querySelector("#sourceBadge");
const targetBadge = document.querySelector("#targetBadge");
const sourceStatus = document.querySelector("#sourceStatus");
const targetStatus = document.querySelector("#targetStatus");
const emptyState = document.querySelector("#emptyState");
const objectList = document.querySelector("#objectList");
const selectAllButton = document.querySelector("#selectAll");
const migrateButton = document.querySelector("#migrateButton");
const activityLog = document.querySelector("#activityLog");
const defaultUserPassword = document.querySelector("#defaultUserPassword");
const forcePasswordChange = document.querySelector("#forcePasswordChange");
const nodeStatus = document.querySelector("#nodeStatus");
const pstoolsStatus = document.querySelector("#pstoolsStatus");
const refreshEnvironmentButton = document.querySelector("#refreshEnvironmentButton");
const pstoolsHelpButton = document.querySelector("#pstoolsHelpButton");
const pstoolsHelpPanel = document.querySelector("#pstoolsHelpPanel");
const closePstoolsHelpButton = document.querySelector("#closePstoolsHelpButton");

function addLog(message) {
  const item = document.createElement("li");
  item.textContent = message;
  activityLog.prepend(item);
}

function addMigrationReport(results) {
  results.slice().reverse().forEach((result) => {
    const item = document.createElement("li");
    const errors = result.errors && result.errors.length
      ? ` Errors: ${result.errors.slice(0, 3).join(" | ")}${result.errors.length > 3 ? " | ..." : ""}`
      : "";
    const mapped = typeof result.mapped === "number" ? ` Mapped ${result.mapped}/${result.exported}.` : "";
    const skipped = typeof result.skipped === "number" && result.skipped > 0 ? ` Skipped ${result.skipped} existing.` : "";
    const target = result.targetRecorder ? ` Target recorder: ${result.targetRecorder}.` : "";
    const artifacts = result.runDirectory ? ` Artifacts: ${result.runDirectory}.` : "";
    const csv = result.csvExportPath ? ` CSV: ${result.csvExportPath}.` : "";
    const temporaryGroup = result.temporaryCameraGroup ? ` Camera group: /${result.temporaryCameraGroup}.` : "";

    item.textContent = `${result.id}: ${result.status}. Imported ${result.imported}/${result.exported}.${mapped}${skipped}${target}${temporaryGroup}${artifacts}${csv}${errors}`;
    activityLog.prepend(item);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[character]);
}

function formPayload(form) {
  const data = new FormData(form);

  return {
    url: data.get("url"),
    username: data.get("username"),
    password: data.get("password"),
    auth: data.get("auth"),
    connectionProfile: data.get("connectionProfile"),
    sampleMode: data.get("sampleMode") === "on",
    allowSelfSigned: data.get("allowSelfSigned") === "on"
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error || `Request failed with status ${response.status}`);
  }

  return body;
}

function updateConnectionUi(system, status, detail) {
  const badge = system === "source" ? sourceBadge : targetBadge;
  const stripStatus = system === "source" ? sourceStatus : targetStatus;
  const label = system === "source" ? "Source" : "Target";

  badge.classList.remove("connected", "error");
  stripStatus.classList.remove("connected", "error");

  if (status === "loading") {
    badge.textContent = "Connecting...";
    stripStatus.textContent = `${label} connecting`;
    return;
  }

  if (status === "connected") {
    badge.textContent = "Connected";
    stripStatus.textContent = `${label} connected`;
    badge.classList.add("connected");
    stripStatus.classList.add("connected");
    return;
  }

  badge.textContent = "Connection failed";
  stripStatus.textContent = `${label} error`;
  badge.classList.add("error");
  stripStatus.classList.add("error");
  addLog(`${label} connection failed: ${detail}`);
}

async function connectSystem(system, form) {
  const label = system === "source" ? "Source" : "Target";
  const button = form.querySelector("button");
  const originalText = button.innerHTML;

  updateConnectionUi(system, "loading");
  button.disabled = true;

  try {
    const payload = formPayload(form);
    const result = await requestJson(`/api/${system}/connect`, {
      method: "POST",
      body: JSON.stringify(payload)
    });

    state[`${system}Connected`] = true;
    updateConnectionUi(system, "connected");
    addLog(`${label} connection established: ${result.serverUrl}`);
    if (result.probeResource) {
      addLog(`${label} API validated successfully${result.productVersion ? `, version ${result.productVersion}` : ""}.`);
    }

    if (system === "source") {
      await loadSourceInventory();
    } else {
      updateWorkspaceState();
    }
  } catch (error) {
    state[`${system}Connected`] = false;
    updateConnectionUi(system, "error", error.message);
    updateWorkspaceState();
  } finally {
    button.disabled = false;
    button.innerHTML = originalText;
  }
}

async function loadSourceInventory() {
  updateWorkspaceState();

  if (!state.sourceConnected) {
    return;
  }

  emptyState.textContent = "Loading configuration objects from the source system...";
  emptyState.hidden = false;
  objectList.hidden = true;
  selectAllButton.disabled = true;

  try {
    const result = await requestJson("/api/source/inventory");
    state.inventory = result.objects;
    renderMigrationObjects();
    addLog("Configuration objects loaded from the source system.");
  } catch (error) {
    state.inventory = [];
    objectList.replaceChildren();
    emptyState.textContent = `Could not load source inventory: ${error.message}`;
    emptyState.hidden = false;
    objectList.hidden = true;
    selectAllButton.disabled = true;
    addLog(`Source inventory failed: ${error.message}`);
  }

  updateMigrateButton();
}

function updateWorkspaceState() {
  const hasSourceInventory = state.sourceConnected && state.inventory.length > 0;

  emptyState.hidden = hasSourceInventory;
  objectList.hidden = !hasSourceInventory;
  selectAllButton.disabled = !hasSourceInventory;

  if (!state.sourceConnected) {
    emptyState.textContent =
      "Connect the source system to load available hardware, camera groups, users, roles, rules, views, and alarms.";
    objectList.replaceChildren();
    state.inventory = [];
  } else if (!state.targetConnected && hasSourceInventory) {
    emptyState.hidden = true;
  }

  updateMigrateButton();
}

function renderMigrationObjects() {
  const fragment = document.createDocumentFragment();

  objectList.replaceChildren();

  state.inventory.forEach((object) => {
    const definition = objectDefinitions.find((item) => item.id === object.id) || object;
    const card = document.createElement("article");
    card.className = "object-card";
    const items = Array.isArray(object.items) ? object.items : [];
    const itemList = items.length
      ? `
        <div class="object-items" data-object-items="${object.id}">
          ${items.map((item, index) => `
            <label class="object-item">
              <input class="object-item-checkbox" type="checkbox" data-object-id="${object.id}" value="${escapeHtml(JSON.stringify(item.identity || {
                id: item.id || "",
                name: item.name || "",
                address: item.address || ""
              }))}" checked disabled>
              <span>
                <span class="object-item-name">${escapeHtml(item.name || item.label || `Item ${index + 1}`)}</span>
                <span class="object-item-meta">${escapeHtml(item.meta || item.address || item.driver || "")}</span>
              </span>
            </label>
          `).join("")}
        </div>
      `
      : "";

    card.innerHTML = `
      <label class="object-heading" for="${object.id}">
        <input class="object-type-checkbox" id="${object.id}" type="checkbox" value="${object.id}" ${object.count === 0 ? "disabled" : ""}>
        <span>${definition.label}</span>
      </label>
      <p class="object-count">${object.count}</p>
      <p class="object-description">${object.error ? `Unavailable: ${object.error}` : definition.description}</p>
      ${itemList}
    `;
    fragment.append(card);
  });

  objectList.append(fragment);
  emptyState.hidden = true;
  objectList.hidden = false;
  selectAllButton.disabled = false;
}

function selectedObjects() {
  return [...objectList.querySelectorAll(".object-type-checkbox:checked")].map((input) => {
    const definition = objectDefinitions.find((item) => item.id === input.value);

    return {
      id: input.value,
      label: definition.label
    };
  });
}

function selectedItemsByObject() {
  const selected = {};

  objectList.querySelectorAll("[data-object-items]").forEach((list) => {
    selected[list.dataset.objectItems] = [];
  });

  objectList.querySelectorAll(".object-item-checkbox:checked").forEach((input) => {
    const objectId = input.dataset.objectId;
    const card = input.closest(".object-card");
    const typeCheckbox = card.querySelector(".object-type-checkbox");

    if (!typeCheckbox.checked) {
      return;
    }

    if (!selected[objectId]) {
      selected[objectId] = [];
    }

    selected[objectId].push(JSON.parse(input.value));
  });

  return selected;
}

function updateMigrateButton() {
  migrateButton.disabled = selectedObjects().length === 0 || !state.targetConnected;
}

function setStatusPill(element, ok, text) {
  element.textContent = text;
  element.classList.remove("connected", "error");
  element.classList.add(ok ? "connected" : "error");
}

async function refreshEnvironment() {
  try {
    const status = await requestJson("/api/environment");
    setStatusPill(nodeStatus, status.node.ok, `Node.js ${status.node.version}`);

    if (status.pstools.ok) {
      setStatusPill(pstoolsStatus, true, `MilestonePSTools ${status.pstools.version}`);
    } else {
      setStatusPill(pstoolsStatus, false, "MilestonePSTools missing");
    }
  } catch (error) {
    setStatusPill(nodeStatus, false, "Environment check failed");
    setStatusPill(pstoolsStatus, false, "MilestonePSTools unknown");
    addLog(`Environment check failed: ${error.message}`);
  }
}

sourceForm.addEventListener("submit", (event) => {
  event.preventDefault();
  connectSystem("source", sourceForm);
});

targetForm.addEventListener("submit", (event) => {
  event.preventDefault();
  connectSystem("target", targetForm);
});

refreshEnvironmentButton.addEventListener("click", refreshEnvironment);

pstoolsHelpButton.addEventListener("click", () => {
  pstoolsHelpPanel.hidden = false;
});

closePstoolsHelpButton.addEventListener("click", () => {
  pstoolsHelpPanel.hidden = true;
});

objectList.addEventListener("change", (event) => {
  const input = event.target;

  if (input.classList.contains("object-type-checkbox")) {
    const card = input.closest(".object-card");
    card.querySelectorAll(".object-item-checkbox").forEach((itemCheckbox) => {
      itemCheckbox.checked = input.checked;
      itemCheckbox.disabled = !input.checked;
    });
  }

  if (input.classList.contains("object-item-checkbox")) {
    const card = input.closest(".object-card");
    const typeCheckbox = card.querySelector(".object-type-checkbox");
    const itemCheckboxes = [...card.querySelectorAll(".object-item-checkbox")];

    typeCheckbox.checked = itemCheckboxes.some((itemCheckbox) => itemCheckbox.checked);
  }

  updateMigrateButton();
});

selectAllButton.addEventListener("click", () => {
  const checkboxes = [...objectList.querySelectorAll(".object-type-checkbox:not(:disabled)")];
  const shouldSelect = checkboxes.some((checkbox) => !checkbox.checked);

  checkboxes.forEach((checkbox) => {
    checkbox.checked = shouldSelect;
    const card = checkbox.closest(".object-card");

    card.querySelectorAll(".object-item-checkbox").forEach((itemCheckbox) => {
      itemCheckbox.checked = shouldSelect;
      itemCheckbox.disabled = !shouldSelect;
    });
  });

  selectAllButton.textContent = shouldSelect ? "Clear selection" : "Select all";
  updateMigrateButton();
});

migrateButton.addEventListener("click", async () => {
  const objects = selectedObjects();

  if (!objects.length) {
    return;
  }

  addLog(`Migration started for: ${objects.map((object) => object.label).join(", ")}.`);
  migrateButton.disabled = true;
  migrateButton.textContent = "Migrating...";

  try {
    const result = await requestJson("/api/migrate", {
      method: "POST",
      body: JSON.stringify({
        objects: objects.map((object) => object.id)
        ,
        options: {
          defaultUserPassword: defaultUserPassword.value,
          forcePasswordChange: forcePasswordChange.checked,
          selectedItems: selectedItemsByObject()
        }
      })
    });

    addLog(result.message);
    if (result.reportPath) {
      addLog(`Migration report created: ${result.reportPath}`);
    }
    if (Array.isArray(result.results)) {
      addMigrationReport(result.results);
    }
  } catch (error) {
    addLog(`Migration failed: ${error.message}`);
  } finally {
    migrateButton.textContent = "Migrate selected";
    updateMigrateButton();
  }
});

refreshEnvironment();
