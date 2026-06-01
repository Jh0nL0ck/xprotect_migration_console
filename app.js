const objectDefinitions = [
  {
    id: "cameras",
    label: "Cameras",
    description: "Hardware devices, streams, names, and core camera configuration."
  },
  {
    id: "cameraGroups",
    label: "Camera groups",
    description: "Logical groups used by operators, rules, permissions, and views."
  },
  {
    id: "roles",
    label: "Roles",
    description: "User roles, privileges, and access scope for the target system."
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

function addLog(message) {
  const item = document.createElement("li");
  item.textContent = message;
  activityLog.prepend(item);
}

function formPayload(form) {
  const data = new FormData(form);

  return {
    url: data.get("url"),
    username: data.get("username"),
    password: data.get("password"),
    auth: data.get("auth"),
    sampleMode: data.get("sampleMode") === "on"
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
    await updateWorkspace();
  } catch (error) {
    state[`${system}Connected`] = false;
    updateConnectionUi(system, "error", error.message);
    updateWorkspaceState();
  } finally {
    button.disabled = false;
    button.innerHTML = originalText;
  }
}

async function updateWorkspace() {
  updateWorkspaceState();

  if (!state.sourceConnected || !state.targetConnected) {
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
  const ready = state.sourceConnected && state.targetConnected;

  emptyState.hidden = ready && state.inventory.length > 0;
  objectList.hidden = !ready || state.inventory.length === 0;
  selectAllButton.disabled = !ready || state.inventory.length === 0;

  if (!ready) {
    emptyState.textContent =
      "Connect both systems to load available cameras, camera groups, roles, rules, views, and alarms.";
    objectList.replaceChildren();
    state.inventory = [];
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
    card.innerHTML = `
      <label for="${object.id}">
        <input id="${object.id}" type="checkbox" value="${object.id}" ${object.count === 0 ? "disabled" : ""}>
        <span>${definition.label}</span>
      </label>
      <p class="object-count">${object.count}</p>
      <p class="object-description">${definition.description}</p>
    `;
    fragment.append(card);
  });

  objectList.append(fragment);
  emptyState.hidden = true;
  objectList.hidden = false;
  selectAllButton.disabled = false;
}

function selectedObjects() {
  return [...objectList.querySelectorAll("input:checked")].map((input) => {
    const definition = objectDefinitions.find((item) => item.id === input.value);

    return {
      id: input.value,
      label: definition.label
    };
  });
}

function updateMigrateButton() {
  migrateButton.disabled = selectedObjects().length === 0;
}

sourceForm.addEventListener("submit", (event) => {
  event.preventDefault();
  connectSystem("source", sourceForm);
});

targetForm.addEventListener("submit", (event) => {
  event.preventDefault();
  connectSystem("target", targetForm);
});

objectList.addEventListener("change", updateMigrateButton);

selectAllButton.addEventListener("click", () => {
  const checkboxes = [...objectList.querySelectorAll("input:not(:disabled)")];
  const shouldSelect = checkboxes.some((checkbox) => !checkbox.checked);

  checkboxes.forEach((checkbox) => {
    checkbox.checked = shouldSelect;
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
      })
    });

    addLog(result.message);
  } catch (error) {
    addLog(`Migration failed: ${error.message}`);
  } finally {
    migrateButton.textContent = "Migrate selected";
    updateMigrateButton();
  }
});
