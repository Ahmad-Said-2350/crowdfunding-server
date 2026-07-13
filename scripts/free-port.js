const { execSync } = require("node:child_process");

const port = process.env.PORT || "5000";

try {
  const out = execSync(
    `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`,
    { encoding: "utf8" }
  );
  const pids = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s) && s !== "0");

  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
      console.log(`Freed port ${port} (killed PID ${pid})`);
    } catch {
      // process may already have exited
    }
  }
} catch {
  // nothing listening on the port
}
