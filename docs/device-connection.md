# Device Connection

LumaBurn communicates with ESP3D-enabled laser controllers over your local network through a built-in proxy server.

---

## How It Works

```
Browser (LumaBurn) → Local Proxy (port 4173) → ESP3D Controller (port 80)
```

The built-in Node.js proxy handles:
- CORS restrictions (browser can't talk directly to ESP3D)
- Network scanning and device discovery
- G-code line-by-line streaming with response monitoring

---

## Quick Connect

1. Click the **Device** tab on the right sidebar
2. Enter your controller's IP in **Controller URL** (e.g. `http://192.168.1.50`)
3. Click **Load Device Files** to verify the connection and browse stored files

---

## Auto-Discovery (Recommended)

LumaBurn scans your local subnet automatically:

1. Leave the **Scan Range** field empty for auto-detection, or enter a subnet like `192.168.1`
2. Click **Scan Network**
3. Any ESP3D devices found appear in the **Discovery** log
4. Click a discovered URL to populate the Controller URL field

**How discovery works**: LumaBurn probes every `.1–.254` address in the subnet, checking for an ESP3D response at `/files?action=list&path=/sd/`. Discovery runs 48 addresses concurrently and completes in about 5 seconds on a typical home network.

---

## Saving Device Profiles

Once you have a working connection:
1. Give it a **Friendly Name** (e.g. "Shop Laser")
2. Click **Save Profile**
3. The profile appears in the **Saved Device Profile** dropdown for future sessions

Set a **Default Profile** to have it load automatically on startup.

---

## Running a Job

### Stream G-code (Recommended)
Click **Run Job** — LumaBurn generates G-code and streams each line to the controller via `[ESP500]` forwarding, monitoring responses.

### Upload & Run
Click **Upload G-code** to upload the file to the controller's SD card first.
Then click **Run** next to the uploaded file in the file list.

---

## During a Job

| Button | Action |
|---|---|
| **Pause** | Sends `M5` + `!` (feed hold) |
| **Resume** | Sends `~` (resume) |
| **Stop Job** | Emergency stop burst: `!`, `M5`, soft-reset |
| **Unlock** | Sends `$X` to clear GRBL alarm |
| **Home** | Sends `$H` to home the machine |

---

## Manual Commands

Use the **Manual Command** field to send raw G-code directly (e.g. `G0 X10 Y10`, `$X`, `M3 S100`). The response appears in the **Recent Activity** log.

---

## Upload Path

The **Upload Path** setting (`/sd/` by default) controls where files are stored on the controller. Change it to `/ext/` for machines with external storage.

---

## Troubleshooting

See [Troubleshooting → Device Not Found](./troubleshooting.md#device-not-found-on-scan).
