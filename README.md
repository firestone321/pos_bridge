# Firestone Smokehouse POS Hardware Bridge

This is a **separate Windows-local application**, not a change to the Smokehouse POS business system. It accepts narrow localhost requests from the permitted POS browser origin and sends RAW ESC/POS jobs through the Windows print spooler to an installed receipt printer.

It is designed for the verified hardware profile:

- S-POS SP-240 U USB thermal printer, Epson-compatible ESC/POS, 80 mm, Font A 48 columns, PC437 default.
- 405A drawer connected **to the printer's cashbox port**, never to the POS computer.

## Architecture

```text
Smokehouse POS browser
  -- signed, structured localhost request --> 127.0.0.1:17891 bridge
  -- Windows RAW printer job -------------> installed S-POS SP-240 U printer
  -- ESC/POS drawer pulse ----------------> printer cashbox port -> 405A drawer
```

The bridge uses a small PowerShell P/Invoke helper for Windows `winspool.drv`, rather than a native Node printer module. Microsoft documents the RAW spooler sequence used here: `OpenPrinter`, `StartDocPrinter` with datatype `RAW`, `StartPagePrinter`, `WritePrinter`, `EndPagePrinter`, and `EndDocPrinter`.

The POS database remains the only source of truth. A successful sale is never rolled back by this bridge if a printer or drawer action fails.

## Contents

| Path | Purpose |
| --- | --- |
| `src/server.ts` | Loopback-only HTTP API, validation, CORS, rate limits, machine-readable errors. |
| `src/printer.ts` | Serialized RAW spooler jobs and Windows printer status checks. |
| `src/escpos.ts` | Named Epson-compatible command builders and the SP-240 profile. |
| `src/receipt.ts` | Safe 48-column structured receipt formatter; no arbitrary raw bytes. |
| `src/auth.ts` | Signed, short-lived action-token verification and drawer-token replay protection. |
| `scripts/send-raw-printer.ps1` | Minimal `winspool.drv` RAW spooler helper. |
| `scripts/install-startup.ps1` | Optional per-user Windows logon task. |

## Dependencies

- `express`, `cors`, `express-rate-limit`: a small local HTTP API with restrictive CORS and abuse limits.
- `zod`: validates structured receipts and accepts no arbitrary printer command data.
- `jose`: verifies the production backend's signed authorizations (JWKS) and makes development tokens for physical testing.
- `pino`: non-sensitive file and console logging.
- `dotenv`: local configuration.
- `tsx`, TypeScript, and type packages: development, compilation, and tests only.

There is deliberately **no native printer npm package** and no browser USB dependency. The only Windows-specific layer calls the documented spooler API already present on the POS computer.

## Initial setup

Use PowerShell on the Windows POS computer:

```powershell
Set-Location 'C:\Users\jurug\OneDrive\VS Code\Web Development\smokehouse-pos-bridge'
npm install
Copy-Item .env.example .env
```

Edit `.env` before starting. At minimum set:

```dotenv
ALLOWED_ORIGIN=https://the-real-admin-pos-origin.example
AUTH_MODE=development
BRIDGE_DEV_SECRET=replace-with-a-random-32-byte-secret
```

Generate a suitable development secret locally; do not put it in source control:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Keep the resulting `.env` only on the POS computer. `BRIDGE_DEV_SECRET` is a **test-phase** secret, not a production backend credential.

## Install and identify the printer

1. Connect the S-POS SP-240 U to its 24 V power supply and USB. Connect the 405A only to the printer's cashbox port.
2. Install the vendor's Windows printer driver, then confirm the printer appears in **Settings > Bluetooth & devices > Printers & scanners**. Do not guess its display name.
3. List the names Windows reports:

   ```powershell
   npm run printers
   ```

4. Copy the exact `name` output into `.env`:

   ```dotenv
   PRINTER_NAME=exact Windows printer name here
   ```

5. Confirm the bridge can see it after it starts:

   ```powershell
   Invoke-RestMethod http://127.0.0.1:17891/printer/status
   ```

`found: true` means Windows exposes that configured queue. `state: available` is useful spooler information, but cannot prove paper, the USB cable, cutter, drawer cabling, or physical output are healthy.

## Run the bridge

Compile and start it:

```powershell
npm run build
npm start
```

It listens only on `127.0.0.1:17891`; it never binds to a LAN address. In a second PowerShell window:

```powershell
Invoke-RestMethod http://127.0.0.1:17891/health
Invoke-RestMethod http://127.0.0.1:17891/printer/status
```

For development with automatic reload, use `npm run dev` instead. Logs are written to `logs/bridge.log` by default and intentionally omit authorization tokens, secrets, and payment details.

## Physical hardware test sequence

The S-POS SP-240 U receipt path and 405A drawer output 0 have been physically validated. Repeat these checks one at a time whenever installing the package on another Windows computer.

### 1. Windows discovery

Run `npm run printers`, then set the exact `PRINTER_NAME` as above.

### 2. RAW receipt and cutter

With the printer connected and configured:

```powershell
npm run test:printer
```

It sends the requested `POS HARDWARE TEST` receipt, feeds four lines, and sends the full-cut command. The receipt explicitly says `HARDWARE TEST - NOT A SALE`.

If you want to isolate the cutter after a successful receipt test:

```powershell
npm run test:cut
```

The bridge can confirm the Windows spooler accepted the job; it cannot electronically verify that the printer physically cut paper. If control codes print as text or the job is transformed, stop and check that the installed queue/driver accepts RAW ESC/POS data before changing bridge code.

### 3. Drawer output 0 — one pulse only

Set the documented safe starting values in `.env`:

```dotenv
DRAWER_PIN=0
DRAWER_PULSE_MS=80
DRAWER_COOLDOWN_MS=1000
```

The physically validated 80 ms pulse is within the drawer's documented 80–200 ms range. The 1,000 ms cooldown keeps the duty factor at 8%, below the 10% maximum. When ready, issue one pulse:

```powershell
npm run test:drawer -- --confirm
```

The command refuses to fire unless `--confirm` is present. It does not test output 1 automatically.

### 4. Drawer output 1 only if output 0 did not work

Stop after the single output-0 test. If the wiring is confirmed and output 0 does not open the drawer, change only this value:

```dotenv
DRAWER_PIN=1
```

Then run the same explicit confirmed command once. Do not pulse both outputs repeatedly.

## Local HTTP bridge test

Browser mutations require both the exact configured `Origin` and a short-lived signed action token. In development mode, make a two-minute test token locally:

```powershell
$printToken = npm run dev:token -- print_receipt POS-LOCAL-TEST | Select-Object -Last 1
$headers = @{ Origin = 'https://the-real-admin-pos-origin.example'; Authorization = "Bearer $printToken" }
$body = @{
  saleId = 'POS-LOCAL-TEST'
  date = '2026-08-16T10:20:00+03:00'
  items = @(@{ name = 'Smoked Beef Ribs'; quantity = 1; unitPrice = 50000; total = 50000 })
  subtotal = 50000
  total = 50000
  paymentMethod = 'cash'
} | ConvertTo-Json -Depth 4
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:17891/receipt/print -Headers $headers -ContentType 'application/json' -Body $body
```

This prints and cuts only. It **does not** open the drawer because a receipt says `cash`.

For a development-only drawer HTTP test, create a separate `open_drawer` token for the same sale ID, then make one call. Production integrations must not use this development secret:

```powershell
$drawerToken = npm run dev:token -- open_drawer POS-LOCAL-TEST | Select-Object -Last 1
$drawerHeaders = @{ Origin = 'https://the-real-admin-pos-origin.example'; Authorization = "Bearer $drawerToken" }
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:17891/drawer/open -Headers $drawerHeaders -ContentType 'application/json' -Body '{"saleId":"POS-LOCAL-TEST"}'
```

The bridge permits only six drawer requests per minute, applies the configured cooldown, and consumes a successful authorization token before sending the pulse. An uncertain drawer spooler result needs a newly issued backend authorization instead of a replay.

## API contract

| Endpoint | Behaviour |
| --- | --- |
| `GET /health` | Confirms the local bridge process is alive. |
| `GET /printer/status` | Distinguishes unconfigured, missing/unavailable, available, and probe-error states. |
| `POST /receipt/print` | Requires allowed Origin plus `print_receipt` action token tied to its `saleId`; formats then queues receipt + cut. |
| `POST /drawer/open` | Requires allowed Origin plus one-time `open_drawer` action token tied to its `saleId`; queues only the configured drawer pulse. |

Error responses have the form:

```json
{
  "ok": false,
  "error": { "code": "printer_unavailable", "message": "..." }
}
```

Relevant codes include `printer_not_configured`, `print_failed`, `drawer_failed`, `drawer_cooldown`, `invalid_authorization`, `authorization_replayed`, and `invalid_request`.

## Production authorization boundary

Before a production POS integration, switch to:

```dotenv
AUTH_MODE=jwks
BRIDGE_JWKS_URL=https://admin.firestonesmokehouse.com/api/pos-hardware/jwks
BRIDGE_ISSUER=firestone-smokehouse
BRIDGE_AUDIENCE=smokehouse-pos-bridge
```

After the backend successfully commits a sale, it must issue a signed, short-lived JWT containing:

```json
{
  "iss": "firestone-smokehouse",
  "aud": "smokehouse-pos-bridge",
  "exp": "short expiry",
  "jti": "unique token id",
  "action": "print_receipt or open_drawer",
  "sale_id": "the committed sale ID"
}
```

For a cash sale, the browser can post the committed sale's structured receipt with a `print_receipt` token and then use a distinct `open_drawer` token. Mobile Money and Card are completed on the separate Visa POS terminal, which prints its own receipt, so the backend issues neither local hardware authorization. The bridge deliberately has no tender/business rule that can override this backend decision.

If receipt printing or drawer opening fails, the POS should present, respectively, `SALE COMPLETE — RECEIPT PRINT FAILED` or `SALE COMPLETE — DRAWER OPEN FAILED`, offer a controlled retry, and never undo the sale.

## Start automatically with Windows

After a successful manual hardware test:

```powershell
npm run build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1
```

This creates a named per-user Scheduled Task that runs `node dist/server.js` when the cashier logs into Windows. Test it without rebooting:

```powershell
Start-ScheduledTask -TaskName 'Firestone Smokehouse POS Hardware Bridge'
```

To remove it later:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1 -Remove
```

The task starts at user logon, so the cashier does not need to open a terminal; it is not a Windows Service and does not run while no user is logged in.

## Daily automatic release updates

The bridge can check the public GitHub repository `firestone321/pos_bridge` once per day for a newer published release. It downloads only the versioned production ZIP and its SHA-256 asset, verifies the archive, keeps the machine's `.env` and local data in place, restarts the bridge, then checks bridge health and printer discovery. If startup or printer discovery fails, it restores the previous files and restarts the previous version.

On the production Windows computer, after installing the bridge and confirming it runs with the printer available, open PowerShell in the installed package folder and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\update-production.ps1 -Install
```

This registers `Firestone Smokehouse POS Bridge Daily Update` for 10:00 AM local time. The cashier must be logged in; missed runs start at the next logon. The computer must be powered on and have internet access; an update does not expose the local bridge port. The updater uses GitHub's public latest-release endpoint, so the repository must remain public unless authenticated access is added separately.

To check manually:

```powershell
Start-ScheduledTask -TaskName 'Firestone Smokehouse POS Bridge Daily Update'
Get-ScheduledTaskInfo -TaskName 'Firestone Smokehouse POS Bridge Daily Update'
```

To remove only the updater task:

```powershell
Unregister-ScheduledTask -TaskName 'Firestone Smokehouse POS Bridge Daily Update' -Confirm:$false
```

To publish an update, increment `version` in `package.json`, commit and push the change, then create and push a matching tag such as `v0.2.1`. GitHub Actions builds the Windows release ZIP and checksum and publishes them as a GitHub Release; the computer installs it on its next daily check.

## Verification and limitations

```powershell
npm run build
npm test
```

The project has unit tests for drawer timing, CP437 fallback behaviour, receipt initialization, and cut output. Those tests verify generated bytes only. They cannot verify the physical printer, USB driver, cutter, drawer cable, or the actual cashbox output.

Known limitations before production integration:

- The supplied profile is intentionally specific to the S-POS SP-240 U's reported Epson mode. Another printer needs a separate profile after testing.
- Windows queue status is advisory; it is not a paper/cutter/drawer sensor.
- `WritePrinter` confirms the spooler accepted the bytes, not eventual physical print completion.
- The production backend integration is present but remains disabled until the server-only Ed25519 signing key and production environment values are deliberately configured and deployed.
- Do not expose this port through a firewall rule, reverse proxy, or LAN forwarding.
