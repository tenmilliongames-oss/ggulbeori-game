import * as XLSX from "xlsx";

import type { WorkbookData } from "./project-types";
import { parseWorkbookData } from "./workbook-sheet-parsers";

export async function loadProjectWorkbook(workbookPath: string): Promise<WorkbookData> {
  const response = await fetch(workbookPath);
  if (!response.ok) {
    throw new Error(`Workbook load failed: ${workbookPath}`);
  }

  const buffer = await response.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  return parseWorkbookData(workbook);
}
