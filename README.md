# XProtect Migration Console

Prototype web application for reducing the manual work involved in migrating configuration between two Milestone XProtect systems.

The current version focuses on the migration workflow:

- Connect to a source XProtect system.
- Connect to a target XProtect system.
- Load available cameras, views, users, rules, alarms, and related object counts from the source system.
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
- Source inventory loading immediately after the source connection succeeds.
- MilestonePSTools hardware migration wrapper for camera/hardware migration.
- Optional sample data mode for demos.
- Initial XProtect REST Config API adapter for inventory counts.

Not implemented yet:

- Conflict detection between source and target.
- Object mapping for servers, users, domains, storage paths, certificates, or licenses.
- Secure credential storage.
- Production authentication flows beyond the initial Basic authentication prototype.

## Migration Behavior

The migration action uses two engines:

- **MilestonePSTools** for `Hardware`, because this is the supported path for cameras, microphones, metadata, inputs, outputs, driver data, and hardware credentials.
- **REST Config API** for the remaining object types while they are being validated.

For REST-backed object types, the app currently:

1. Export selected object collections from the source server.
2. Remove common read-only fields such as `id`, `path`, and link metadata.
3. POST each object to the matching target REST resource.
4. Report imported, exported, partial, skipped, or failed results per object type.

Some XProtect objects, especially cameras, rules, views, alarms, and permissions, can depend on target-specific IDs, recording servers, users, devices, hardware, licenses, or storage paths. Those cases may require mapping logic before they can be imported successfully.

Current mapping behavior:

- Cameras are matched by name against existing target cameras. The app does not create cameras directly because cameras depend on recording server and hardware configuration.
- Hardware is listed separately and is the correct way to create cameras/devices in the target system.
- Hardware migration calls `Export-VmsHardware` on the source and `Import-VmsHardware` on the target. All imported hardware is assigned to the first target recording server. If source credentials are not available, use the hardware fallback username/password fields.
- Basic users can be created with a temporary password and the force-password-change option enabled. Existing passwords cannot be exported from XProtect.
- Users are matched by name against existing target users before creating missing users.
- Alarm payloads attempt to replace source camera IDs with matching target camera IDs before import.
- Missing matches are reported as `requires_mapping`.

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

Keep **API Gateway profile** set to **Auto-detect** for normal use. Use the manual profiles only when troubleshooting:

- **Legacy IDP (/IDP)** for older API Gateway layouts.
- **Modern IDP (/api/idp)** for newer API Gateway layouts.

If the server returns `LockedOut`, stop retrying and unlock the account or wait for the lockout policy to expire before testing again.

The real connection flow uses the XProtect API Gateway Identity Provider:

```text
/api/idp/connect/token
```

The app requests a bearer token and then calls:

```text
/API/rest/v1
```

For XProtect versions such as 2023 R3, the app first reads:

```text
/API/.well-known/uris
```

and uses the returned IDP/API paths when they differ from newer defaults.

Recordings and stored events are intentionally out of scope for this migration workflow.
