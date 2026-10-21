import { HardwareAuthorizer } from "./auth.js";
import { loadConfig } from "./config.js";
import { escpos } from "./escpos.js";
import { createLogger } from "./logger.js";
import { listWindowsPrinters, WindowsRawPosPrinter } from "./printer.js";
import { buildHardwareTestReceipt, buildSampleSaleReceipt } from "./receipt.js";
import type { HardwareAction } from "./types.js";

const command = process.argv[2];
const config = loadConfig();
const logger = createLogger(config);
const printer = new WindowsRawPosPrinter(config, logger);

async function main(): Promise<void> {
  switch (command) {
    case "printers": {
      const printers = await listWindowsPrinters(config.projectRoot);
      if (printers.length === 0) console.log("No Windows printers found.");
      else console.table(printers);
      return;
    }
    case "receipt":
      await printer.sendRawForHardwareTest(buildHardwareTestReceipt(), "Smokehouse POS hardware test receipt");
      console.log("Hardware test receipt submitted to the Windows spooler. It should feed and cut.");
      return;
    case "sale-receipt":
      await printer.sendRawForHardwareTest(buildSampleSaleReceipt(), "Smokehouse sample sale receipt");
      console.log("Sample sale receipt submitted to the Windows spooler. No sale or stock was changed.");
      return;
    case "cut":
      await printer.sendRawForHardwareTest(Buffer.concat([escpos.initialize(), escpos.lineFeed(4), escpos.fullCut()]), "Smokehouse cutter test");
      console.log("Cutter test submitted to the Windows spooler.");
      return;
    case "drawer":
      if (!process.argv.includes("--confirm")) {
        console.error("REFUSED: this fires the configured drawer output. Re-run: npm run test:drawer -- --confirm");
        process.exitCode = 2;
        return;
      }
      console.warn(`Firing configured drawer output ${config.drawerPin} once for ${config.drawerPulseMs} ms.`);
      await printer.openDrawer();
      console.log("Drawer pulse submitted to the Windows spooler.");
      return;
    case "token": {
      const action = process.argv[3] as HardwareAction | undefined;
      const saleId = process.argv[4];
      if ((action !== "print_receipt" && action !== "open_drawer") || !saleId) {
        throw new Error("Usage: npm run dev:token -- <print_receipt|open_drawer> <saleId>");
      }
      const token = await new HardwareAuthorizer(config).createDevelopmentToken(action, saleId);
      console.log(token);
      return;
    }
    default:
      console.error("Usage: npm run printers | test:receipt | test:sale-receipt | test:cut | test:drawer -- --confirm | dev:token -- <action> <saleId>");
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "Bridge command failed");
  console.error(error instanceof Error ? error.message : "Bridge command failed");
  process.exitCode = 1;
});
