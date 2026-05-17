import { execFileSync, spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const nodeCommand = process.execPath;
const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const exportPort = Number.parseInt(process.env.FFMPEG_EXPORT_PORT ?? "43123", 10) || 43123;
const vitePortRange = { start: 5173, end: 5180 };
const children = new Set();
let shuttingDown = false;
let shutdownExitCode = 0;
let shutdownTimer = null;

function quoteShellArg(value) {
  if (!value) {
    return '""';
  }

  if (!/[\s"]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '\\"')}"`;
}

function spawnTaggedProcess(label, command, args, cwd) {
  const child = isWindows
    ? spawn([quoteShellArg(command), ...args.map(quoteShellArg)].join(" "), [], {
        cwd,
        env: process.env,
        stdio: ["inherit", "pipe", "pipe"],
        shell: true,
        windowsHide: true,
      })
    : spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ["inherit", "pipe", "pipe"],
        windowsHide: true,
      });

  children.add(child);

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
  });

  child.on("exit", (code, signal) => {
    children.delete(child);
    if (shuttingDown && children.size === 0) {
      process.exit(shutdownExitCode);
    }

    if (signal) {
      console.error(`[${label}] exited from signal ${signal}`);
      shutdown(signal);
      return;
    }

    if (code !== 0) {
      console.error(`[${label}] exited with code ${code}`);
      shutdown("SIGTERM", code ?? 1);
    }
  });

  child.on("error", (error) => {
    children.delete(child);
    console.error(`[${label}] failed to start: ${error.message}`);
    shutdown("SIGTERM", 1);
  });

  return child;
}

function shutdown(signal, exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  shutdownExitCode = exitCode;

  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }

  if (children.size === 0) {
    process.exit(exitCode);
  }

  shutdownTimer = setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }
    process.exit(exitCode);
  }, 3000);

  shutdownTimer.unref();
}

function runCommand(command, args) {
  return execFileSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runCommandCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  return {
    status: result.status ?? 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error ?? null,
  };
}

function parsePidList(output) {
  if (!output) {
    return [];
  }

  return output
    .split(/[\s,]+/u)
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function probePidsWithPowerShell(port) {
  const result = runCommandCapture("powershell", [
    "-NoProfile",
    "-Command",
    [
      "$connections = @(Get-NetTCPConnection -LocalPort " + port + " -State Listen -ErrorAction SilentlyContinue)",
      "$pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique",
      'if ($pids) { $pids -join "," }',
    ].join("; "),
  ]);

  const pids = parsePidList(result.stdout);
  if (pids.length > 0) {
    return { kind: "success", pids };
  }

  if (result.status === 0 || (!result.stdout && !result.stderr)) {
    return { kind: "empty", pids: [] };
  }

  return {
    kind: "failed",
    reason: result.error?.message || result.stderr || result.stdout || `powershell exited with code ${result.status}`,
  };
}

function probePidsWithNetstat(port) {
  const result = runCommandCapture("cmd.exe", ["/c", "netstat", "-ano", "-p", "tcp"]);
  if (result.error) {
    return { kind: "failed", reason: result.error.message };
  }

  if (result.status !== 0 && !result.stdout && !result.stderr) {
    return { kind: "empty", pids: [] };
  }

  if (result.status !== 0) {
    return {
      kind: "failed",
      reason: result.stderr || result.stdout || `netstat exited with code ${result.status}`,
    };
  }

  const pids = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    if (columns.length < 5) {
      continue;
    }

    const [protocol, localAddress, , state, pidText] = columns;
    if (protocol !== "TCP" || state !== "LISTENING" || !localAddress.endsWith(`:${port}`)) {
      continue;
    }

    const pid = Number.parseInt(pidText, 10);
    if (Number.isInteger(pid) && pid > 0) {
      pids.push(pid);
    }
  }

  return {
    kind: pids.length > 0 ? "success" : "empty",
    pids: [...new Set(pids)],
  };
}

function getListeningPids(port) {
  if (isWindows) {
    const powershellProbe = probePidsWithPowerShell(port);
    if (powershellProbe.kind === "success" || powershellProbe.kind === "empty") {
      return powershellProbe.pids;
    }

    console.warn(`[bootstrap] port probe fallback used for ${port}: ${powershellProbe.reason}`);
    const netstatProbe = probePidsWithNetstat(port);
    if (netstatProbe.kind === "success" || netstatProbe.kind === "empty") {
      return netstatProbe.pids;
    }

    console.warn(
      `[bootstrap] port probe skipped due to lookup failure for ${port}: ${netstatProbe.reason}`,
    );
    return [];
  }

  try {
    const output = runCommand("lsof", ["-ti", `tcp:${port}`]);
    return output
      .split(/\s+/u)
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function getProcessCommandLine(pid) {
  try {
    if (isWindows) {
      return runCommand("powershell", [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ]);
    }

    return runCommand("ps", ["-o", "command=", "-p", String(pid)]);
  } catch {
    return "";
  }
}

function stopProcess(pid) {
  if (isWindows) {
    runCommand("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`]);
    return;
  }

  process.kill(pid, "SIGKILL");
}

function ensureExportPortAvailable(port) {
  const listeningPids = getListeningPids(port);
  for (const pid of listeningPids) {
    const commandLine = getProcessCommandLine(pid);
    if (/ffmpeg-export-server\.mjs/u.test(commandLine)) {
      console.log(`[bootstrap] stale export server stopped on port ${port} (pid ${pid})`);
      stopProcess(pid);
      continue;
    }

    throw new Error(`Port ${port} is already in use by another process (pid ${pid}). Close it first and retry.`);
  }
}

function isStaleProjectViteProcess(commandLine) {
  if (!commandLine) {
    return false;
  }

  const normalized = commandLine.toLowerCase();
  const normalizedProjectRoot = projectRoot.toLowerCase();

  return (
    /vite(?:\.js)?/u.test(normalized) &&
    (normalized.includes(normalizedProjectRoot) || normalized.includes("spot-new"))
  );
}

function ensureProjectVitePortsAvailable() {
  const handledPids = new Set();

  for (let port = vitePortRange.start; port <= vitePortRange.end; port += 1) {
    const listeningPids = getListeningPids(port);
    for (const pid of listeningPids) {
      if (handledPids.has(pid)) {
        continue;
      }

      const commandLine = getProcessCommandLine(pid);
      if (!isStaleProjectViteProcess(commandLine)) {
        continue;
      }

      console.log(`[bootstrap] stale vite dev server stopped on port ${port} (pid ${pid})`);
      stopProcess(pid);
      handledPids.add(pid);
    }
  }
}

ensureExportPortAvailable(exportPort);
ensureProjectVitePortsAvailable();

spawnTaggedProcess("export", nodeCommand, [path.join(__dirname, "ffmpeg-export-server.mjs")], projectRoot);
spawnTaggedProcess("dev", npmCommand, ["run", "dev"], projectRoot);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}
