# XProtect Migration Console

Prototype web application for reducing the manual work involved in migrating configuration between two Milestone XProtect systems.

The current version focuses on the migration workflow:

- Connect to a source XProtect system.
- Connect to a target XProtect system.
- Load available configuration object counts from the source system.
- Select which object types should be migrated.
- Start a migration operation from the selected objects.
- Clearly warn that recordings and stored events are not moved.

## Current Status

This is an early prototype.

Implemented:

- English web interface.
- Source and target connection forms.
- Local Node.js backend.
- Internal API endpoints for source connection, target connection, inventory loading, and migration start.
- Optional sample data mode for demos.
- Initial XProtect REST Config API adapter for inventory counts.

Not implemented yet:

- Real export/import of configuration objects.
- Conflict detection between source and target.
- Object mapping for servers, users, domains, storage paths, certificates, or licenses.
- Secure credential storage.
- Production authentication flows beyond the initial Basic authentication prototype.

## Run Locally

Requirements:

- Node.js 18 or newer.

Start the local server:

```powershell
node server.js
```

Open:

```text
http://localhost:4173
```

## Project Structure

```text
index.html    Web interface
styles.css    Application styling
app.js        Frontend workflow and API calls
server.js     Local backend and XProtect adapter prototype
```

## Notes

Use **Use sample data** only for demos or UI testing. When sample mode is disabled, the backend attempts to query the configured XProtect server through its REST Config API.

For real XProtect tests, use the base server address, for example:

```text
https://192.168.1.50
```

The backend automatically appends:

```text
/API/rest/v1
```

If the XProtect server uses a self-signed HTTPS certificate, enable **Allow self-signed certificate** in the connection form.

Recordings and stored events are intentionally out of scope for this migration workflow.
