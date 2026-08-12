import ExcelJS from "exceljs";
import { parseXlsx } from "../parseXlsx";

async function buildWorkbookBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Suppliers");
  sheet.addRow(["supplier_id", "name", "signup_date", "credit_limit"]);
  sheet.addRow([1, "Acme Corp", new Date("2024-01-15"), 10000.5]);
  sheet.addRow([2, "Globex", new Date("2024-03-02"), 25000]);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

describe("parseXlsx", () => {
  it("reads the first worksheet into string rows, stringifying dates/numbers uniformly", async () => {
    const buffer = await buildWorkbookBuffer();
    const { rows } = await parseXlsx(buffer);

    expect(rows).toEqual([
      ["supplier_id", "name", "signup_date", "credit_limit"],
      ["1", "Acme Corp", "2024-01-15", "10000.5"],
      ["2", "Globex", "2024-03-02", "25000"],
    ]);
  });

  it("returns no rows for an empty workbook", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Empty");
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const { rows } = await parseXlsx(buffer);
    expect(rows).toHaveLength(0);
  });
});
