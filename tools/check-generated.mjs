// The generated types are the contract's, never edited by hand: regenerate them from
// spec/openapi.yaml into a temporary file and fail when anything differs from what is committed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mfx-gen-"));
const out = join(dir, "api.ts");
try {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const opts = { stdio: "ignore", shell: process.platform === "win32" };
  execFileSync(npx, ["openapi-typescript", "spec/openapi.yaml", "-o", out], opts);
  execFileSync(npx, ["prettier", "--config", ".prettierrc", "--write", out], opts);
  const fresh = readFileSync(out, "utf8");
  const committed = readFileSync("src/generated/api.ts", "utf8");
  if (fresh !== committed) {
    console.error(
      "src/generated/api.ts differs from what spec/openapi.yaml generates: run npm run gen",
    );
    process.exit(1);
  }
  console.log("generated types match the API description");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
