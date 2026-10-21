# Recipient Windows setup

This package runs the Firestone Smokehouse POS hardware bridge on the Windows computer physically connected to the receipt printer and cash drawer.

## Before installation

1. Install Node.js 20 or newer.
2. Connect and power the `80Series2` printer.
3. Confirm Windows has a printer queue named exactly `S-POS SP-240 U` using the `Generic / Text Only` driver on the printer's USB port.
4. Connect the cash drawer to the printer's cashbox port.
5. Extract the entire package to a permanent local folder. Do not run it from inside the ZIP file.

## Install

Open PowerShell in the extracted folder and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-production.ps1
```

The installer verifies Node.js, the production configuration, the exact Windows printer queue, and the compiled bridge. It then creates and starts the per-user scheduled task `Firestone Smokehouse POS Hardware Bridge` and checks both local health endpoints.

The bridge listens only on `127.0.0.1:17891`. Do not add a Windows Firewall rule or expose this port to the LAN or internet.

## Production behavior

- Cash: the Smokehouse receipt prints and the drawer opens after the sale commits.
- Mobile Money or Card: payment and receipt are handled by the Visa POS terminal; the local printer and drawer are not triggered.
- Printer or drawer failure never reverses a committed sale.

## Verify later

```powershell
Invoke-RestMethod http://127.0.0.1:17891/health
Invoke-RestMethod http://127.0.0.1:17891/printer/status
Get-ScheduledTask -TaskName 'Firestone Smokehouse POS Hardware Bridge'
```

`printer/status` must report `configured: true`, `found: true`, `state: available`, and `printerName: S-POS SP-240 U`.

## Remove automatic startup

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1 -Remove
```
